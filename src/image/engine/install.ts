/**
 * `obrew image engine install`: fetch the pinned stable-diffusion.cpp release and unpack
 * `sd-server` (and `sd-cli`) under `<data>/image/engines/<tag>-<variant>/`.
 *
 * Differences from the text engine's installer, each for a reason:
 *  - assets are found by pattern (./variant.ts) and must carry a GitHub digest: an asset with no
 *    checksum is refused rather than installed unverified;
 *  - the 537 MB CUDA runtime zip is kept, by digest, in `engines/.cache/`, so a tag bump that
 *    leaves it unchanged does not download it again;
 *  - the zips nest differently per platform (flat on Windows and macOS, `build/bin/` in the
 *    Linux ROCm zip), so the shallowest `sd-server` wins and its directory is the binary dir,
 *    which is also the working directory it runs in (its DLLs / dylibs / .so files sit beside it);
 *  - after unpacking, the build is RUN: `sd-server --help` records which flags this build has
 *    (stable-diffusion.cpp renames flags between releases, and ./flags.ts drops what it lacks),
 *    and `--list-devices` records which GPUs it can see. A build that cannot start at all — a
 *    Linux glibc older than the Ubuntu 24.04 it was built on, a Windows machine missing the
 *    Visual C++ runtime — fails the install with that reason instead of failing every run later.
 */
import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { hostArch, hostPlatform } from '../../engine/variant'
import { downloadVerified, extractArchive } from '../../shared/download'
import { ObrewError } from '../../shared/errors'
import { assetSha256, fetchRelease, type ReleaseAsset } from '../../shared/release'
import { loadImageConfig, saveImageConfig, type ImageConfig } from '../config'
import { imageCacheDir, imageEnginesDir, imageTmpDir } from '../paths'
import { detectHardware } from './hardware'
import { assetPatterns, detectImageVariant, publishedVariants, variantHint, type ImageVariant } from './variant'
import { SDCPP_REPO, SDCPP_TAG } from './version'

export const ImageEngineRecordSchema = z.object({
  tag: z.string(),
  variant: z.string(),
  /** Absolute path of `sd-server[.exe]`. */
  server: z.string(),
  cli: z.string().nullable(),
  /** The directory the binaries (and their libraries) live in; their working directory. */
  binDir: z.string(),
  /** Every `--flag` this build's `--help` lists. Empty = unknown (an override): nothing is dropped. */
  flags: z.array(z.string()),
  /** `--list-devices` names, e.g. `MTL0`, `Vulkan0`, `CUDA0`, `CPU`. */
  devices: z.array(z.string()),
  installedAt: z.string(),
})
export type ImageEngineRecord = z.infer<typeof ImageEngineRecordSchema>

const engineDirFor = (tag: string, variant: string) => join(imageEnginesDir(), `${tag}-${variant}`)
const recordPath = (dir: string) => join(dir, 'engine.json')
const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

async function readRecord(dir: string): Promise<ImageEngineRecord | null> {
  const file = Bun.file(recordPath(dir))
  if (!(await file.exists())) return null
  try {
    const parsed = ImageEngineRecordSchema.safeParse(await file.json())
    if (!parsed.success) return null
    if (!(await Bun.file(parsed.data.server).exists())) return null
    return parsed.data
  } catch {
    return null
  }
}

/** The shallowest match: archives that ship a second copy deeper down must not win. */
async function findShallowest(dir: string, name: string): Promise<string | null> {
  let best: string | null = null
  for await (const rel of new Bun.Glob(`**/${name}`).scan({ cwd: dir, onlyFiles: true })) {
    if (!best || rel.split(/[\\/]/).length < best.split(/[\\/]/).length) best = rel
  }
  return best ? join(dir, best) : null
}

/** The environment sd-server and sd-cli run with: their own directory first for libraries. */
export function engineEnv(binDir: string): Record<string, string | undefined> {
  if (process.platform !== 'linux') return {}
  const prior = process.env.LD_LIBRARY_PATH
  return { LD_LIBRARY_PATH: prior ? `${binDir}:${prior}` : binDir }
}

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

async function runBinary(argv: string[], cwd: string, timeoutMs: number): Promise<Ran> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...engineEnv(cwd) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/** `--help` → the long flags it lists (`-l, --listen-ip <string>` → `--listen-ip`). */
export const parseHelpFlags = (help: string): string[] =>
  [...new Set([...help.matchAll(/^\s+(?:-[A-Za-z], )?(--[a-z0-9][\w-]*)/gm)].map((m) => m[1]!))]

/** `--list-devices` → `name<TAB>description` per line → the names. */
export const parseDevices = (out: string): string[] =>
  out
    .split(/\r?\n/)
    .map((l) => l.split('\t')[0]!.trim())
    .filter((n) => n && !/\s/.test(n))

/** Why a freshly unpacked build will not start, in terms a user can act on. */
export function launchFailure(run: Ran): string {
  const text = `${run.stderr}\n${run.stdout}`
  const glibc = text.match(/GLIBC_([\d.]+)' not found/)
  if (glibc) {
    return `this stable-diffusion.cpp build needs glibc ${glibc[1]} or newer (it is built on Ubuntu 24.04); this system's is older. Use a newer distribution, or point OBREW_SD_SERVER at an sd-server you built yourself.`
  }
  // STATUS_DLL_NOT_FOUND: a DLL the build links against is not installed, nearly always the
  // Visual C++ runtime on a fresh Windows.
  if (run.code === 0xc0000135 || run.code === -1073741515) {
    return 'sd-server could not start because a DLL is missing; install the Microsoft Visual C++ Redistributable (x64) and run `obrew image engine install` again.'
  }
  const tail = text.trim().split('\n').slice(-8).join('\n')
  return `sd-server did not start (exit ${run.code ?? 'killed'})${tail ? `:\n${tail}` : ''}`
}

export interface ImageInstallOptions {
  tag?: string
  variant?: ImageVariant
  signal: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

function pickAsset(assets: ReleaseAsset[], pattern: RegExp, tag: string): ReleaseAsset {
  const hits = assets.filter((a) => pattern.test(a.name))
  if (hits.length === 1) return hits[0]!
  const names = assets.map((a) => a.name).join(', ')
  throw new ObrewError(
    'engine_failed',
    hits.length === 0
      ? `no asset matching ${pattern} on stable-diffusion.cpp ${tag}. Published: ${names}`
      : `${hits.length} assets match ${pattern} on stable-diffusion.cpp ${tag}: ${hits.map((a) => a.name).join(', ')}`,
  )
}

export async function installImageEngine(opts: ImageInstallOptions): Promise<ImageEngineRecord> {
  const config = await loadImageConfig()
  const hw = await detectHardware()
  const tag = opts.tag ?? SDCPP_TAG
  const variant = opts.variant ?? config.variant ?? detectImageVariant(hw)
  const platform = hostPlatform()
  const arch = hostArch()
  const log = opts.onLog ?? (() => {})

  const patterns = assetPatterns(variant, platform, arch)
  if (!patterns) {
    const here = publishedVariants(platform, arch)
    throw new ObrewError(
      'engine_failed',
      `no stable-diffusion.cpp build for variant "${variant}" on ${platform}-${arch}; ${here.length ? `published here: ${here.join(', ')}` : 'none is published for this platform'}`,
    )
  }
  const hint = variantHint(hw, variant)
  if (hint) log(hint)

  log(`fetching release ${tag} of ${SDCPP_REPO} (${variant})`)
  const release = await fetchRelease(SDCPP_REPO, tag, opts.signal)
  const assets = patterns.map((p) => pickAsset(release.assets, p, tag))
  for (const asset of assets) {
    if (!assetSha256(asset)) throw new ObrewError('engine_failed', `${asset.name} carries no checksum on the release, so it was not installed`)
  }

  const dir = engineDirFor(tag, variant)
  const staging = join(imageTmpDir(), `engine-${tag}-${variant}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    for (const asset of assets) {
      const sha256 = assetSha256(asset)!
      // The CUDA runtime does not change with every sd.cpp commit; keep it across tag bumps.
      const cacheable = /^cudart-/.test(asset.name)
      const archive = cacheable ? join(imageCacheDir(), `${sha256}-${asset.name}`) : join(staging, asset.name)
      const cached = cacheable && (await stat(archive).catch(() => null))?.size === asset.size
      if (cached) {
        log(`using the cached ${asset.name}`)
      } else {
        log(`downloading ${asset.name}`)
        await downloadVerified(
          { url: asset.browser_download_url, sha256, size: asset.size, dest: archive },
          opts.signal,
          (received, total) => opts.onProgress?.(asset.name, received, total),
        )
      }
      log(`unpacking ${asset.name}`)
      await extractArchive(archive, dir)
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }

  const server = await findShallowest(dir, exe('sd-server'))
  if (!server) throw new ObrewError('engine_failed', `sd-server not found inside ${dir}`)
  const cli = await findShallowest(dir, exe('sd-cli'))
  const binDir = dirname(server)
  if (process.platform !== 'win32') {
    for (const bin of [server, cli]) if (bin) await chmod(bin, 0o755)
  }

  log('checking that sd-server runs')
  const help = await runBinary([server, '--help'], binDir, 15_000)
  if (help.code !== 0) throw new ObrewError('engine_failed', launchFailure(help))
  const flags = parseHelpFlags(`${help.stdout}\n${help.stderr}`)
  // Metal compiles its kernel libraries on first use (a few seconds); the rest answer at once.
  const listed = flags.includes('--list-devices') ? await runBinary([server, '--list-devices'], binDir, 60_000) : null
  const devices = listed?.code === 0 ? parseDevices(listed.stdout) : []
  const gpus = devices.filter((d) => !/^(CPU|BLAS)/i.test(d))
  if (variant !== 'cpu' && listed && gpus.length === 0) {
    log(`warning: this ${variant} build found no GPU it can use (devices: ${devices.join(', ') || 'none'}); images will be generated on the CPU, which is slow`)
  } else if (gpus.length) {
    log(`devices: ${devices.join(', ')}`)
  }

  const record: ImageEngineRecord = { tag, variant, server, cli, binDir, flags, devices, installedAt: new Date().toISOString() }
  await Bun.write(recordPath(dir), JSON.stringify(record, null, 2) + '\n')
  await saveImageConfig({ ...config, variant })
  log(`installed ${basename(server)} → ${binDir}`)
  return record
}

/**
 * The image engine to run, or null. `OBREW_SD_SERVER` is an explicit override (tests point it
 * at a fake; developers at their own build), and a wrong path is a hard failure. Otherwise the
 * configured variant for the pinned tag, else any installed variant of the pinned tag. Reads
 * files only — `auth status` calls this and must not spawn anything.
 */
export async function findImageEngine(config?: ImageConfig): Promise<ImageEngineRecord | null> {
  const override = process.env.OBREW_SD_SERVER
  if (override) {
    if (!(await Bun.file(override).exists())) {
      throw new ObrewError('engine_missing', `OBREW_SD_SERVER points at ${override}, which does not exist`)
    }
    return { tag: 'custom', variant: 'custom', server: override, cli: null, binDir: dirname(override), flags: [], devices: [], installedAt: '' }
  }
  const cfg = config ?? (await loadImageConfig())
  if (cfg.variant) {
    const first = await readRecord(engineDirFor(SDCPP_TAG, cfg.variant))
    if (first) return first
  }
  try {
    for await (const rel of new Bun.Glob(`${SDCPP_TAG}-*/engine.json`).scan({ cwd: imageEnginesDir(), onlyFiles: true })) {
      const record = await readRecord(join(imageEnginesDir(), dirname(rel)))
      if (record) return record
    }
  } catch {
    // No engines directory yet.
  }
  return null
}

export interface ImageEngineStatus {
  installed: boolean
  tag: string
  variant: string | null
  server: string | null
}

export async function imageEngineStatus(config?: ImageConfig): Promise<ImageEngineStatus> {
  const cfg = config ?? (await loadImageConfig())
  const found = await findImageEngine(cfg)
  return { installed: found !== null, tag: found?.tag ?? SDCPP_TAG, variant: found?.variant ?? cfg.variant ?? null, server: found?.server ?? null }
}

export async function requireImageEngine(config?: ImageConfig): Promise<ImageEngineRecord> {
  const found = await findImageEngine(config)
  if (!found) throw new ObrewError('engine_missing', 'the image engine is not installed; run `obrew image setup`')
  return found
}
