/**
 * `LoadOptions` → llama-server argv. Port of the flag mapping in
 * obrew-engine/backends/inference/llama_server.py (`init_kwargs`, `start_server`).
 *
 * `--jinja` is unconditional: it is what makes the model's own chat template — and with it
 * native, grammar-constrained tool calling — available on `/v1/chat/completions`.
 */
import { UsageError } from '../shared/errors'

export interface LoadOptions {
  ctxSize?: number
  /** -1 or undefined → all layers on the GPU (llama.cpp treats 999 as "all"). */
  nGpuLayers?: number
  threads?: number
  batchSize?: number
  seed?: number
  cacheTypeK?: string
  cacheTypeV?: string
  mmap?: boolean
  mlock?: boolean
  mmprojPath?: string
  /** `auto` (default) splits <think> blocks into reasoning_content; `none` leaves them inline. */
  reasoningFormat?: 'auto' | 'none' | 'deepseek' | 'deepseek-legacy'
  /** An embedding server: `--embedding --pooling mean`, no chat. */
  embedding?: boolean
  /** Raw extra flags for anything not modelled here. */
  extra?: string[]
}

export function launchArgs(modelPath: string, port: number | null, opts: LoadOptions = {}): string[] {
  const args = ['-m', modelPath, '--host', '127.0.0.1']
  if (port !== null) args.push('--port', String(port))
  args.push('--jinja')
  args.push('--no-webui')
  // The /slots endpoint is what `POST /slots/0?action=erase` (cancel) needs.
  args.push('--slots')

  const ngl = opts.nGpuLayers === undefined || opts.nGpuLayers < 0 ? 999 : opts.nGpuLayers
  args.push('--n-gpu-layers', String(ngl))
  if (opts.ctxSize !== undefined) args.push('--ctx-size', String(opts.ctxSize))
  if (opts.batchSize !== undefined) args.push('--batch-size', String(opts.batchSize))
  if (opts.threads !== undefined) {
    args.push('--threads', String(opts.threads), '--threads-batch', String(opts.threads))
  }
  if (opts.seed !== undefined) args.push('--seed', String(opts.seed))
  if (opts.mmap === false) args.push('--no-mmap')
  if (opts.mlock) args.push('--mlock')
  if (opts.cacheTypeK) args.push('--cache-type-k', opts.cacheTypeK)
  if (opts.cacheTypeV) args.push('--cache-type-v', opts.cacheTypeV)
  if (opts.mmprojPath) args.push('--mmproj', opts.mmprojPath)
  if (opts.reasoningFormat) args.push('--reasoning-format', opts.reasoningFormat)
  if (opts.embedding) args.push('--embedding', '--pooling', 'mean')
  if (opts.extra) args.push(...opts.extra)
  return args
}

/** The `-c key=value` keys that reach llama-server at launch (as opposed to per request). */
export const LOAD_KEYS = [
  'ctx_size',
  'n_gpu_layers',
  'threads',
  'batch_size',
  'seed',
  'cache_type_k',
  'cache_type_v',
  'mmap',
  'mlock',
] as const

const int = (v: unknown, key: string): number => {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n)) throw new UsageError(`-c ${key} expects an integer, got "${String(v)}"`)
  return n
}
const bool = (v: unknown, key: string): boolean => {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'on' || v === '1') return true
  if (v === 'false' || v === 'off' || v === '0') return false
  throw new UsageError(`-c ${key} expects true|false, got "${String(v)}"`)
}
const str = (v: unknown): string => String(v)

/** Pull the launch-time keys out of a `-c` map; everything else is left for the request. */
export function loadOptionsFrom(pairs: Record<string, unknown>, base: LoadOptions = {}): LoadOptions {
  const out: LoadOptions = { ...base }
  for (const [key, value] of Object.entries(pairs)) {
    switch (key) {
      case 'ctx_size':
        out.ctxSize = int(value, key)
        break
      case 'n_gpu_layers':
        out.nGpuLayers = int(value, key)
        break
      case 'threads':
        out.threads = int(value, key)
        break
      case 'batch_size':
        out.batchSize = int(value, key)
        break
      case 'seed':
        out.seed = int(value, key)
        break
      case 'cache_type_k':
        out.cacheTypeK = str(value)
        break
      case 'cache_type_v':
        out.cacheTypeV = str(value)
        break
      case 'mmap':
        out.mmap = bool(value, key)
        break
      case 'mlock':
        out.mlock = bool(value, key)
        break
      default:
        break
    }
  }
  return out
}
