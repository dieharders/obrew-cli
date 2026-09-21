/**
 * Install the tool model: Cactus Compute's Needle 3.
 *
 * Needle is not a GGUF and llama.cpp cannot load it — its architecture has no ggml equivalent
 * and there is no converter. It ships on Hugging Face as one weights file (`needle3.cact`,
 * 35 MB) plus a self-contained runner per platform (about 1 MB), so obrew fetches exactly those
 * two files and runs the runner as its own process beside llama-server (see ./sidecar.ts).
 *
 * The repo is pinned to a COMMIT (`needle_rev` in package.json, the same one-line-bump rule as
 * `llamacpp_tag`): this is an executable obrew runs, so `main` moving under us is not
 * acceptable, and every file at a commit carries the SHA-256 the download is verified against.
 * Files live under `<data>/needle/<rev>/`.
 *
 * A platform with no published runner (an Intel mac) simply has no tool model: every caller
 * treats "not installed" as "use the baseline model under a grammar", which is what obrew did
 * before Needle existed.
 */
import { join } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { authHeaders, listRepoFiles, resolveUrl } from '../models/hf'
import { downloadVerified } from '../shared/download'
import { ObrewError } from '../shared/errors'
import { needleDir } from '../shared/paths'

export const NEEDLE_REPO = 'Cactus-Compute/needle3'
export const NEEDLE_REV: string = pkg.needle_rev
export const NEEDLE_WEIGHTS = 'needle3.cact'
/** The id a user, a host and the status output call the built-in tool model. */
export const NEEDLE_ID = 'needle3'

/** The runner's path inside the repo for this host, or null when none is published. */
export function runnerAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'macos-arm64/needle' : null
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64/needle' : arch === 'x64' ? 'linux-x86_64/needle' : null
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64/needle.exe' : arch === 'x64' ? 'windows-x86_64/needle.exe' : null
  return null
}

export interface NeedleInstall {
  /** Absolute path of the runner executable. */
  runner: string
  /** Absolute path of the `.cact` weights. */
  weights: string
  rev: string
}

const installDir = () => join(needleDir(), NEEDLE_REV)
const runnerName = () => (process.platform === 'win32' ? 'needle.exe' : 'needle')

/**
 * The installed tool model, or null.
 *
 * `OBREW_NEEDLE` is an explicit runner override with the rule `OBREW_LLAMA_SERVER` has: a wrong
 * path is a hard failure, never a silent fall-through. `OBREW_NEEDLE_WEIGHTS` goes with it (a
 * test's fake runner needs no weights, so it may be absent then).
 */
export async function findNeedle(): Promise<NeedleInstall | null> {
  const override = process.env.OBREW_NEEDLE
  if (override) {
    if (!(await Bun.file(override).exists())) {
      throw new ObrewError('engine_missing', `OBREW_NEEDLE points at ${override}, which does not exist`)
    }
    return { runner: override, weights: process.env.OBREW_NEEDLE_WEIGHTS ?? '', rev: 'custom' }
  }
  const runner = join(installDir(), runnerName())
  const weights = join(installDir(), NEEDLE_WEIGHTS)
  if (!(await Bun.file(runner).exists()) || !(await Bun.file(weights).exists())) return null
  return { runner, weights, rev: NEEDLE_REV }
}

export interface NeedleInstallOptions {
  token?: string
  signal: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

/** Fetch the runner and the weights. Returns null when this platform has no runner. */
export async function installNeedle(opts: NeedleInstallOptions): Promise<NeedleInstall | null> {
  const log = opts.onLog ?? (() => {})
  const existing = await findNeedle()
  if (existing) {
    log(`tool model ready (${NEEDLE_ID})`)
    return existing
  }
  const asset = runnerAsset()
  if (!asset) {
    log(`tool model: no ${NEEDLE_ID} runner is published for ${process.platform}-${process.arch}; skipping`)
    return null
  }

  const files = await listRepoFiles(NEEDLE_REPO, opts.token, opts.signal, NEEDLE_REV)
  const wanted: Array<{ path: string; dest: string; executable: boolean }> = [
    { path: asset, dest: join(installDir(), runnerName()), executable: true },
    { path: NEEDLE_WEIGHTS, dest: join(installDir(), NEEDLE_WEIGHTS), executable: false },
  ]
  for (const want of wanted) {
    const file = files.find((f) => f.path === want.path)
    if (!file) throw new ObrewError('bad_request', `${NEEDLE_REPO}@${NEEDLE_REV.slice(0, 7)} has no ${want.path}`)
    // An executable with no published hash is not something to run.
    if (!file.sha256) throw new ObrewError('bad_request', `${NEEDLE_REPO} publishes no SHA-256 for ${want.path}`)
    log(`downloading ${want.path}`)
    await downloadVerified(
      {
        url: resolveUrl(NEEDLE_REPO, want.path, NEEDLE_REV),
        sha256: file.sha256,
        size: file.size,
        dest: want.dest,
        executable: want.executable,
        headers: { ...authHeaders(opts.token), 'user-agent': 'obrew-cli' },
      },
      opts.signal,
      (received, total) => opts.onProgress?.(want.path, received, total),
    )
  }
  log(`tool model installed (${NEEDLE_ID})`)
  return findNeedle()
}
