/**
 * sd-server's command line for one model bundle on this machine, and what makes two engines
 * the same.
 *
 * The model is chosen by STARTUP flags (sd-server preloads it and reports `origin:
 * command_line`), so a different bundle is a different engine. Memory flags come from the
 * hardware, decided against TOTAL memory, not free memory, so the reuse key does not change
 * from one run to the next:
 *
 *   estimated footprint = component bytes × 1.1 + 1.5 GiB (activations, VAE decode at ~1 MP)
 *   fits the budget            nothing extra; sd-server's own auto-fit places the weights
 *   does not fit               --offload-to-cpu --max-vram ⌊budget − 1.5⌋: weights wait in RAM
 *                              and stream to the GPU per segment
 *   budget unknown             --offload-to-cpu
 *   Vulkan / ROCm, or ≤ 8 GiB  --vae-tiling: Mesa RADV caps one allocation at 4 GiB, and a
 *                              1 MP decode is the largest single buffer of a run
 *   Metal                      --batched-cfg off: batched CFG renders white images on Metal
 *                              (stable-diffusion.cpp #2149); our presets run at CFG 1 anyway
 *   cpu variant                --backend cpu
 *
 * `-c max_vram= / offload= / vae_tiling= / backend= / threads=` override each decision. A flag
 * the installed build does not list in its `--help` is dropped with a warning instead of making
 * sd-server refuse to start.
 */
import { ObrewError } from '../../shared/errors'
import { modelRootDir, upscalersDir } from '../paths'
import type { Role } from '../presets'
import type { ResolvedBundle } from '../registry'
import { GIB, memoryBudgetBytes, toGiB, type Hardware } from './hardware'
import { engineEnv, type ImageEngineRecord } from './install'

const ROLE_FLAGS: Record<Role, string> = {
  diffusion: '--diffusion-model',
  model: '--model',
  llm: '--llm',
  vae: '--vae',
  t5xxl: '--t5xxl',
  clip_l: '--clip_l',
  clip_g: '--clip_g',
  tokenizer: '--tokenizer',
  upscaler: '--upscale-model',
}

const bool = (v: unknown, key: string): boolean => {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'on' || v === '1' || v === 1) return true
  if (v === 'false' || v === 'off' || v === '0' || v === 0) return false
  throw new ObrewError('bad_request', `-c ${key} expects true|false, got "${String(v)}"`)
}

/** Bytes the engine will plan for: the files, plus room to compute in. */
export const footprintBytes = (resolved: ResolvedBundle | null): number =>
  resolved ? Math.round(resolved.bytes * 1.1 + 1.5 * GIB) : Math.round(0.5 * GIB)

/** The M5 and later: the Metal tensor API renders blank images there (stable-diffusion.cpp #1990). */
export function metalTensorBroken(hw: Hardware): boolean {
  const m = (hw.chip ?? '').match(/Apple M(\d+)/i)
  return !!m && Number(m[1]) >= 5
}

export interface ServerPlan {
  args: string[]
  env: Record<string, string | undefined>
  /** Launch args minus the port, the bundle, the build and the environment: equal keys are interchangeable. */
  key: string
  footprintBytes: number
  /** Flags dropped because this build does not have them. */
  dropped: string[]
}

export interface ServerPlanInput {
  engine: ImageEngineRecord
  resolved: ResolvedBundle | null
  hardware: Hardware
  pairs?: Record<string, unknown>
  port?: number
}

export function serverPlan(input: ServerPlanInput): ServerPlan {
  const { engine, resolved, hardware } = input
  const pairs = input.pairs ?? {}
  const flags: Array<[string, string?]> = [['--listen-ip', '127.0.0.1']]
  if (input.port !== undefined) flags.push(['--listen-port', String(input.port)])
  // An empty model root: sd-server scans `./models` under its working directory by default.
  flags.push(['--model-dir', modelRootDir()], ['--hires-upscalers-dir', upscalersDir()])

  if (resolved) {
    for (const [role, path] of Object.entries(resolved.paths) as Array<[Role, string]>) {
      if (role !== 'upscaler') flags.push([ROLE_FLAGS[role], path])
    }
    const d = resolved.bundle.defaults
    if (d.steps > 0) flags.push(['--steps', String(d.steps)])
    flags.push(['--cfg-scale', String(d.cfg)])
    if (d.sampler) flags.push(['--sampling-method', d.sampler])
  }

  const footprint = footprintBytes(resolved)
  const budget = memoryBudgetBytes(hardware)
  const variant = engine.variant
  // Decided per variant; an explicit `-c` value wins on every variant. Metal shares memory with
  // the CPU (offloading moves nothing) and the CPU build has no VRAM to plan around.
  const discreteGpu = variant !== 'metal' && variant !== 'cpu'
  const autoOffload = discreteGpu && (budget === null || footprint > budget)
  const offload = pairs.offload !== undefined ? bool(pairs.offload, 'offload') : autoOffload
  if (offload) flags.push(['--offload-to-cpu'])
  if (pairs.max_vram !== undefined) flags.push(['--max-vram', String(pairs.max_vram)])
  else if (offload && discreteGpu && budget !== null) flags.push(['--max-vram', String(Math.max(1, Math.floor(toGiB(budget) - 1.5)))])
  const autoTiling = discreteGpu && (variant === 'vulkan' || variant === 'rocm' || (budget !== null && budget <= 8 * GIB))
  if (pairs.vae_tiling !== undefined ? bool(pairs.vae_tiling, 'vae_tiling') : autoTiling) flags.push(['--vae-tiling'])
  if (variant === 'metal') flags.push(['--batched-cfg', 'off'])
  if (pairs.backend !== undefined) flags.push(['--backend', String(pairs.backend)])
  else if (variant === 'cpu') flags.push(['--backend', 'cpu'])
  if (pairs.threads !== undefined) flags.push(['--threads', String(pairs.threads)])

  // Drop what this build lacks. An override engine (`flags: []`) is taken at its word.
  const known = new Set(engine.flags)
  const supported = ([flag]: [string, string?]) => engine.flags.length === 0 || known.has(flag)
  const kept = flags.filter(supported)
  const dropped = flags.filter((f) => !supported(f)).map(([flag]) => flag)
  const args = kept.flatMap(([flag, value]) => (value === undefined ? [flag] : [flag, value]))

  const env: Record<string, string | undefined> = { ...engineEnv(engine.binDir) }
  if (variant === 'metal' && metalTensorBroken(hardware)) env.GGML_METAL_TENSOR_DISABLE = '1'

  const keyArgs = kept.filter(([flag]) => flag !== '--listen-port').flatMap(([f, v]) => (v === undefined ? [f] : [f, v]))
  const key = new Bun.CryptoHasher('sha256')
    .update(JSON.stringify({ tag: engine.tag, variant, server: engine.server, bundle: resolved?.bundle.id ?? null, hashes: resolved?.hashes ?? null, args: keyArgs, env }))
    .digest('hex')
  return { args, env, key, footprintBytes: footprint, dropped }
}
