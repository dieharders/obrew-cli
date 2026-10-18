/**
 * `obrew engine install`: fetch a pinned GitHub release and unpack its binary.
 *
 * Two products share this path. The LLM engine is llama.cpp's `llama-server`; the speech
 * engine is qwentts.cpp's `tts-server`. Each is one directory per build under
 * `<data>/engines/` — `<tag>-<variant>/` for llama.cpp (unchanged from before speech existed)
 * and `tts-<tag>-<variant>/` for qwentts — with an `engine.json` recording where the
 * executable ended up (archives differ: Windows zips are flat, tarballs nest under
 * `build/bin/`). Nothing is bundled into obrew itself: a bump is one line in package.json.
 */
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { loadConfig, saveConfig, type Config, type Variant } from '../shared/config'
import { downloadVerified, extractArchive, type Progress } from '../shared/download'
import { ObrewError } from '../shared/errors'
import { enginesDir, tmpDir } from '../shared/paths'
import { assetNames, detectVariant, hostArch, hostPlatform, ttsAssetNames } from './variant'
import { LLAMACPP_REPO, LLAMACPP_TAG, QWENTTS_REPO, QWENTTS_TAG } from './version'

export const EngineRecordSchema = z.object({
  tag: z.string(),
  variant: z.string(),
  /** Absolute path of the executable (`llama-server[.exe]` or `tts-server[.exe]`). */
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
const ttsEngineDirFor = (tag: string, variant: string) => join(enginesDir(), `tts-${tag}-${variant}`)
const recordPath = (dir: string) => join(dir, 'engine.json')

async function readRecord(dir: string): Promise<EngineRecord | null> {
  const file = Bun.file(recordPath(dir))
  if (!(await file.exists())) return null
  const parsed = EngineRecordSchema.safeParse(await file.json())
  if (!parsed.success) return null
  if (!(await Bun.file(parsed.data.binary).exists())) return null
  return parsed.data
}

/** Find a named executable anywhere under the extraction directory. */
async function findBinary(dir: string, name: string): Promise<string | null> {
  const glob = new Bun.Glob(`**/${name}`)
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) return join(dir, rel)
  return null
}

const exeName = (base: string) => (process.platform === 'win32' ? `${base}.exe` : base)

export interface InstallOptions {
  tag?: string
  variant?: Variant
  signal: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

interface ReleaseInstall {
  repo: string
  tag: string
  variant: Variant
  /** The archives to fetch, in order; all extract into `dir`. */
  assets: string[]
  dir: string
  binaryName: string
  signal: AbortSignal
  log: (message: string) => void
  onProgress?: InstallOptions['onProgress']
}

/**
 * Fetch every asset of one pinned release, verify, extract, and record the binary. Shared by
 * both engines so a release-API quirk (rate limits, renamed assets, missing digests) is
 * handled in exactly one place.
 */
async function installRelease(opts: ReleaseInstall): Promise<EngineRecord> {
  opts.log(`fetching release ${opts.tag} of ${opts.repo}`)
  // `OBREW_RELEASE_API` lets tests (and mirrors) stand in for api.github.com.
  const api = (process.env.OBREW_RELEASE_API ?? 'https://api.github.com').replace(/\/$/, '')
  const res = await fetch(`${api}/repos/${opts.repo}/releases/tags/${opts.tag}`, {
    signal: opts.signal,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'obrew-cli' },
  })
  if (res.status === 404) {
    throw new ObrewError('engine_failed', `release ${opts.tag} of ${opts.repo} does not exist (yet)`)
  }
  if (!res.ok) throw new ObrewError('engine_failed', `GitHub release lookup failed: HTTP ${res.status}`)
  const release = ReleaseSchema.parse(await res.json())

  const staging = join(tmpDir(), `engine-${basename(opts.dir)}`)
  await rm(opts.dir, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  const platform = hostPlatform()
  try {
    for (const name of opts.assets) {
      const asset = release.assets.find((a) => a.name === name)
      if (!asset) {
        const similar = release.assets
          .map((a) => a.name)
          .filter((n) => n.includes(platform === 'win32' ? 'win' : platform === 'darwin' ? 'macos' : 'ubuntu'))
        throw new ObrewError(
          'engine_failed',
          `asset ${name} not found on release ${opts.tag}. Published: ${similar.join(', ') || '(none for this platform)'}`,
        )
      }
      const archive = join(staging, name)
      opts.log(`downloading ${name}`)
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
      opts.log(`unpacking ${name}`)
      await extractArchive(archive, opts.dir)
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }

  const binary = await findBinary(opts.dir, opts.binaryName)
  if (!binary) throw new ObrewError('engine_failed', `${opts.binaryName} not found inside ${opts.dir}`)

  const record: EngineRecord = { tag: opts.tag, variant: opts.variant, binary, installedAt: new Date().toISOString() }
  await Bun.write(recordPath(opts.dir), JSON.stringify(record, null, 2) + '\n')
  opts.log(`installed ${basename(binary)} → ${dirname(binary)}`)
  return record
}

export async function installEngine(opts: InstallOptions): Promise<EngineRecord> {
  const config = await loadConfig()
  const tag = opts.tag ?? LLAMACPP_TAG
  const variant = opts.variant ?? config.variant ?? detectVariant()
  const platform = hostPlatform()
  const arch = hostArch()

  const names = assetNames(tag, variant, platform, arch)
  if (!names) {
    throw new ObrewError(
      'engine_failed',
      `no llama.cpp build for variant "${variant}" on ${platform}-${arch}; try --variant cpu`,
    )
  }

  const record = await installRelease({
    repo: LLAMACPP_REPO,
    tag,
    variant,
    assets: names,
    dir: engineDirFor(tag, variant),
    binaryName: exeName('llama-server'),
    signal: opts.signal,
    log: opts.onLog ?? (() => {}),
    onProgress: opts.onProgress,
  })
  await saveConfig({ ...config, variant })
  return record
}

/**
 * `obrew engine install --tts`: the speech engine, qwentts.cpp's `tts-server`.
 *
 * Its variant is chosen like the LLM engine's (the same GPU answers both), remembered in
 * `config.ttsVariant` so a user who picked `--variant cpu` for speech keeps it.
 */
export async function installTtsEngine(opts: InstallOptions): Promise<EngineRecord> {
  const config = await loadConfig()
  const tag = opts.tag ?? QWENTTS_TAG
  const variant = opts.variant ?? config.ttsVariant ?? config.variant ?? detectVariant()
  const platform = hostPlatform()
  const arch = hostArch()

  const names = ttsAssetNames(tag, variant, platform, arch)
  if (!names) {
    throw new ObrewError(
      'engine_failed',
      `no qwentts.cpp build for variant "${variant}" on ${platform}-${arch}; try --variant cpu`,
    )
  }

  const record = await installRelease({
    repo: QWENTTS_REPO,
    tag,
    variant,
    assets: names,
    dir: ttsEngineDirFor(tag, variant),
    binaryName: exeName('tts-server'),
    signal: opts.signal,
    log: opts.onLog ?? (() => {}),
    onProgress: opts.onProgress,
  })
  await saveConfig({ ...config, ttsVariant: variant })
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
  return anyVariant(`${LLAMACPP_TAG}-*/engine.json`)
}

/** The first installed record matching a glob under the engines dir (another variant of the pin). */
async function anyVariant(pattern: string): Promise<EngineRecord | null> {
  const glob = new Bun.Glob(pattern)
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

/**
 * The speech engine to run, or null. `OBREW_TTS_SERVER` overrides, for a locally built
 * `tts-server` before a release carries one for this platform.
 */
export async function findTtsEngine(config?: Config): Promise<EngineRecord | null> {
  const override = process.env.OBREW_TTS_SERVER
  if (override) {
    if (!(await Bun.file(override).exists())) {
      throw new ObrewError('engine_missing', `OBREW_TTS_SERVER points at ${override}, which does not exist`)
    }
    return { tag: 'custom', variant: 'custom', binary: override, installedAt: '' }
  }
  const cfg = config ?? (await loadConfig())
  const preferred = cfg.ttsVariant ?? cfg.variant ?? detectVariant()
  const first = await readRecord(ttsEngineDirFor(QWENTTS_TAG, preferred))
  if (first) return first
  return anyVariant(`tts-${QWENTTS_TAG}-*/engine.json`)
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

export async function ttsEngineStatus(config?: Config): Promise<EngineStatus> {
  const cfg = config ?? (await loadConfig())
  const found = await findTtsEngine(cfg)
  return {
    installed: found !== null,
    tag: found?.tag ?? QWENTTS_TAG,
    variant: found?.variant ?? cfg.ttsVariant ?? cfg.variant ?? detectVariant(),
    binary: found?.binary ?? null,
  }
}

export async function requireEngine(config?: Config): Promise<EngineRecord> {
  const found = await findEngine(config)
  if (!found) throw new ObrewError('engine_missing', 'llama-server is not installed; run `obrew login` or `obrew engine install`')
  return found
}

export async function requireTtsEngine(config?: Config): Promise<EngineRecord> {
  const found = await findTtsEngine(config)
  if (!found) throw new ObrewError('engine_missing', 'tts-server is not installed; run `obrew engine install --tts`')
  return found
}
