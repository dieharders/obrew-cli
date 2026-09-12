/**
 * `obrew engine install`: fetch the pinned llama.cpp release and unpack `llama-server`.
 *
 * Binaries live under `<data>/engines/<tag>-<variant>/`, one directory per build, with an
 * `engine.json` that records where the executable ended up (the archives differ: Windows
 * zips are flat, the macOS / Linux tarballs nest under `build/bin/`). Nothing is bundled into
 * obrew itself — a llama.cpp bump is a one-line change to package.json plus a re-install.
 */
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { loadConfig, saveConfig, type Config, type Variant } from '../shared/config'
import { downloadVerified, extractArchive, type Progress } from '../shared/download'
import { ObrewError } from '../shared/errors'
import { enginesDir, tmpDir } from '../shared/paths'
import { assetNames, detectVariant, hostArch, hostPlatform } from './variant'
import { LLAMACPP_REPO, LLAMACPP_TAG } from './version'

export const EngineRecordSchema = z.object({
  tag: z.string(),
  variant: z.string(),
  /** Absolute path of `llama-server[.exe]`. */
  binary: z.string(),
  installedAt: z.string(),
})
export type EngineRecord = z.infer<typeof EngineRecordSchema>

const ReleaseSchema = z.object({
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
      size: z.number(),
      digest: z.string().nullable().optional(),
    }),
  ),
})

const engineDirFor = (tag: string, variant: string) => join(enginesDir(), `${tag}-${variant}`)
const recordPath = (dir: string) => join(dir, 'engine.json')

async function readRecord(dir: string): Promise<EngineRecord | null> {
  const file = Bun.file(recordPath(dir))
  if (!(await file.exists())) return null
  const parsed = EngineRecordSchema.safeParse(await file.json())
  if (!parsed.success) return null
  if (!(await Bun.file(parsed.data.binary).exists())) return null
  return parsed.data
}

/** Find `llama-server` anywhere under the extraction directory. */
async function findBinary(dir: string): Promise<string | null> {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const glob = new Bun.Glob(`**/${name}`)
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) return join(dir, rel)
  return null
}

export interface InstallOptions {
  tag?: string
  variant?: Variant
  signal: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

export async function installEngine(opts: InstallOptions): Promise<EngineRecord> {
  const config = await loadConfig()
  const tag = opts.tag ?? LLAMACPP_TAG
  const variant = opts.variant ?? config.variant ?? detectVariant()
  const platform = hostPlatform()
  const arch = hostArch()
  const log = opts.onLog ?? (() => {})

  const names = assetNames(tag, variant, platform, arch)
  if (!names) {
    throw new ObrewError(
      'engine_failed',
      `no llama.cpp build for variant "${variant}" on ${platform}-${arch}; try --variant cpu`,
    )
  }

  log(`fetching release ${tag} of ${LLAMACPP_REPO}`)
  // `OBREW_RELEASE_API` lets tests (and mirrors) stand in for api.github.com.
  const api = (process.env.OBREW_RELEASE_API ?? 'https://api.github.com').replace(/\/$/, '')
  const res = await fetch(`${api}/repos/${LLAMACPP_REPO}/releases/tags/${tag}`, {
    signal: opts.signal,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'obrew-cli' },
  })
  if (!res.ok) throw new ObrewError('engine_failed', `GitHub release lookup failed: HTTP ${res.status}`)
  const release = ReleaseSchema.parse(await res.json())

  const dir = engineDirFor(tag, variant)
  const staging = join(tmpDir(), `engine-${tag}-${variant}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  try {
    for (const name of names) {
      const asset = release.assets.find((a) => a.name === name)
      if (!asset) {
        const similar = release.assets
          .map((a) => a.name)
          .filter((n) => n.includes(platform === 'win32' ? 'win' : platform === 'darwin' ? 'macos' : 'ubuntu'))
        throw new ObrewError(
          'engine_failed',
          `asset ${name} not found on release ${tag}. Published: ${similar.join(', ')}`,
        )
      }
      const archive = join(staging, name)
      log(`downloading ${name}`)
      const progress: Progress = (received, total) => opts.onProgress?.(name, received, total)
      await downloadVerified(
        {
          url: asset.browser_download_url,
          sha256: asset.digest?.replace(/^sha256:/, '') ?? null,
          size: asset.size,
          dest: archive,
        },
        opts.signal,
        progress,
      )
      log(`unpacking ${name}`)
      await extractArchive(archive, dir)
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }

  const binary = await findBinary(dir)
  if (!binary) throw new ObrewError('engine_failed', `llama-server not found inside ${dir}`)

  const record: EngineRecord = { tag, variant, binary, installedAt: new Date().toISOString() }
  await Bun.write(recordPath(dir), JSON.stringify(record, null, 2) + '\n')
  await saveConfig({ ...config, variant })
  log(`installed ${basename(binary)} → ${dirname(binary)}`)
  return record
}

export interface EngineStatus {
  installed: boolean
  tag: string
  variant: string
  binary: string | null
}

/**
 * The engine to run, or null.
 *
 * `OBREW_LLAMA_SERVER` is an explicit override: a wrong path is a hard failure, never a
 * silent fall-through (the same rule motionbuff's discovery applies to `MC_*_PATH`).
 * Otherwise the configured / detected variant for the pinned tag, then any other variant of
 * the pinned tag that happens to be installed (a user who ran `--variant cpu` on an NVIDIA box).
 */
export async function findEngine(config?: Config): Promise<EngineRecord | null> {
  const override = process.env.OBREW_LLAMA_SERVER
  if (override) {
    if (!(await Bun.file(override).exists())) {
      throw new ObrewError('engine_missing', `OBREW_LLAMA_SERVER points at ${override}, which does not exist`)
    }
    return { tag: 'custom', variant: 'custom', binary: override, installedAt: '' }
  }
  const cfg = config ?? (await loadConfig())
  const preferred = cfg.variant ?? detectVariant()
  const first = await readRecord(engineDirFor(LLAMACPP_TAG, preferred))
  if (first) return first

  const glob = new Bun.Glob(`${LLAMACPP_TAG}-*/engine.json`)
  try {
    for await (const rel of glob.scan({ cwd: enginesDir(), onlyFiles: true })) {
      const record = await readRecord(join(enginesDir(), dirname(rel)))
      if (record) return record
    }
  } catch {
    // No engines directory yet.
  }
  return null
}

export async function engineStatus(config?: Config): Promise<EngineStatus> {
  const cfg = config ?? (await loadConfig())
  const found = await findEngine(cfg)
  return {
    installed: found !== null,
    tag: found?.tag ?? LLAMACPP_TAG,
    variant: found?.variant ?? cfg.variant ?? detectVariant(),
    binary: found?.binary ?? null,
  }
}

export async function requireEngine(config?: Config): Promise<EngineRecord> {
  const found = await findEngine(config)
  if (!found) throw new ObrewError('engine_missing', 'llama-server is not installed; run `obrew login` or `obrew engine install`')
  return found
}
