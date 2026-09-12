/**
 * Fetch an artifact and prove it is the one that was published.
 *
 * Adapted from motionbuff/app/src/agent/cli/server/install/download.ts, with one addition:
 * `downloadVerified` can RESUME. GGUF files run to many gigabytes, and a dropped connection
 * at 90% must not cost the whole download. The staging file is kept on failure; on the next
 * attempt its bytes are re-hashed and the request continues with a `Range` header. Nothing is
 * renamed into place until the hash matches.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, chmod, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DownloadSpec {
  url: string
  /** Lowercase hex SHA-256 the publisher gave for this artifact, or null to skip the check. */
  sha256: string | null
  /** Expected byte count, for progress. 0 when unknown. */
  size: number
  /** Absolute path to write. */
  dest: string
  /** Mark executable afterwards (POSIX only). */
  executable?: boolean
  headers?: Record<string, string>
}

export type Progress = (received: number, total: number) => void

export class ChecksumError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`checksum mismatch: expected ${expected}, got ${actual}`)
    this.name = 'ChecksumError'
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Feed an existing partial file through the hasher so a resumed download still verifies. */
async function rehash(path: string, hasher: Bun.CryptoHasher): Promise<void> {
  const stream = Bun.file(path).stream()
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) hasher.update(chunk)
}

/** Stream the body to disk, appending when resuming. node:fs so that append is real. */
async function writeBody(
  body: ReadableStream<Uint8Array>,
  path: string,
  append: boolean,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const ws = createWriteStream(path, { flags: append ? 'a' : 'w' })
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      onChunk(chunk)
      if (!ws.write(chunk)) await new Promise<void>((r) => ws.once('drain', () => r()))
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      ws.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  }
}

async function finish(spec: DownloadSpec, staging: string, actual: string): Promise<void> {
  if (spec.sha256 && actual.toLowerCase() !== spec.sha256.toLowerCase()) {
    // A bad partial must not be resumed again: remove it so the next attempt starts clean.
    await rm(staging, { force: true }).catch(() => {})
    throw new ChecksumError(spec.sha256, actual)
  }
  // Replace, not overwrite: on Windows a running executable is locked.
  await rm(spec.dest, { force: true })
  await rename(staging, spec.dest)
  if (spec.executable && process.platform !== 'win32') await chmod(spec.dest, 0o755)
}

/**
 * Download (resuming a previous partial if present), verify, then move into place.
 *
 * On a network failure or abort the `.partial` file is left behind on purpose so the next
 * call resumes it. On a checksum failure it is removed.
 */
export async function downloadVerified(
  spec: DownloadSpec,
  signal: AbortSignal,
  onProgress?: Progress,
): Promise<void> {
  await mkdir(dirname(spec.dest), { recursive: true })
  const staging = `${spec.dest}.partial`

  let hasher = new Bun.CryptoHasher('sha256')
  let received = await sizeOf(staging)
  const headers: Record<string, string> = { ...(spec.headers ?? {}) }
  if (received > 0) {
    await rehash(staging, hasher)
    headers.range = `bytes=${received}-`
  }

  const res = await fetch(spec.url, { signal, headers })
  if (res.status === 416 && received > 0) {
    // The staging file already holds the whole artifact; verify it as it is.
    await finish(spec, staging, hasher.digest('hex'))
    return
  }
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)

  // A server that ignores Range answers 200 with the whole body: start over.
  const resumed = res.status === 206 && received > 0
  if (!resumed) {
    hasher = new Bun.CryptoHasher('sha256')
    received = 0
    await rm(staging, { force: true })
  }

  const remaining = Number(res.headers.get('content-length')) || 0
  const total = resumed ? received + remaining : remaining || spec.size

  // Hash while streaming rather than re-reading the file afterwards.
  await writeBody(res.body, staging, resumed, (chunk) => {
    hasher.update(chunk)
    received += chunk.byteLength
    onProgress?.(received, total)
  })

  await finish(spec, staging, hasher.digest('hex'))
}

/**
 * Unpack an archive into a directory using the system `tar`.
 *
 * bsdtar (Windows 10 build 17063+, macOS) reads .zip and .tar.gz alike with `-xf`; GNU tar
 * on Linux handles the .tar.gz that Linux assets ship as. The archive has already been
 * checksum-verified by the caller before this runs.
 */
/**
 * On Windows prefer the bsdtar in System32 over whatever is first on PATH: a Git-for-Windows
 * shell puts GNU tar there, which reads `C:\...` as a remote host ("Cannot connect to C").
 */
export function tarBinary(): string | null {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    const system = `${root}\\System32\\tar.exe`
    if (Bun.spawnSync([system, '--version'], { stderr: 'ignore', stdout: 'ignore' }).exitCode === 0) return system
  }
  return Bun.which('tar')
}

export async function extractArchive(archive: string, intoDir: string): Promise<void> {
  await mkdir(intoDir, { recursive: true })
  const tar = tarBinary()
  if (!tar) throw new Error('`tar` was not found, so the archive cannot be unpacked.')

  const proc = Bun.spawn([tar, '-xf', archive, '-C', intoDir], {
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`tar exited with ${code}: ${stderr.slice(0, 400)}`)
}

export const humanBytes = (n: number) =>
  n >= 1 << 30
    ? `${(n / (1 << 30)).toFixed(2)} GB`
    : n >= 1 << 20
      ? `${(n / (1 << 20)).toFixed(1)} MB`
      : `${(n / 1024).toFixed(0)} KB`
