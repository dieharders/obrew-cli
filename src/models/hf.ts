/**
 * Hugging Face Hub, without the SDK: two public endpoints and a naming rule.
 *
 *   GET https://huggingface.co/api/models/<repo>/tree/main?recursive=true   file list
 *   GET https://huggingface.co/<repo>/resolve/main/<path>                    bytes
 *
 * GGUF files are LFS objects, and the tree listing carries each one's `lfs.oid`, which is
 * its SHA-256 — so a pulled model is verified against what the Hub says it published, the
 * same guarantee obrew-engine got from `huggingface_hub`.
 */
import { z } from 'zod'
import { ObrewError } from '../shared/errors'

export interface HfFile {
  path: string
  size: number
  /** SHA-256 for LFS objects; null for small regular files. */
  sha256: string | null
}

export interface ModelSpec {
  repoId: string
  file: string | null
}

/** `org/repo` or `org/repo:file.gguf`. */
export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim()
  const colon = trimmed.indexOf(':')
  const repoId = colon === -1 ? trimmed : trimmed.slice(0, colon)
  const file = colon === -1 ? null : trimmed.slice(colon + 1)
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoId)) {
    throw new ObrewError('bad_request', `"${spec}" is not a Hugging Face repo id (expected org/repo[:file])`)
  }
  return { repoId, file: file || null }
}

export const modelId = (repoId: string, file: string) => `${repoId}:${file}`

const TreeSchema = z.array(
  z.object({
    type: z.string(),
    path: z.string(),
    size: z.number().optional(),
    lfs: z.object({ oid: z.string(), size: z.number().optional() }).optional(),
  }),
)

/** `HF_ENDPOINT` is the Hub's own override variable (mirrors, tests). */
export const hfBase = () => (process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/$/, '')

export const resolveUrl = (repoId: string, path: string) =>
  `${hfBase()}/${repoId}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`

export function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

export async function listRepoFiles(repoId: string, token?: string, signal?: AbortSignal): Promise<HfFile[]> {
  const url = `${hfBase()}/api/models/${repoId}/tree/main?recursive=true`
  const res = await fetch(url, { signal, headers: { ...authHeaders(token), 'user-agent': 'obrew-cli' } })
  if (res.status === 401 || res.status === 403) {
    throw new ObrewError('bad_request', `${repoId} is gated or private; set HF_TOKEN to a token that can read it`)
  }
  if (res.status === 404) throw new ObrewError('bad_request', `${repoId} was not found on Hugging Face`)
  if (!res.ok) throw new ObrewError('bad_request', `Hugging Face listing failed: HTTP ${res.status}`)
  const tree = TreeSchema.parse(await res.json())
  return tree
    .filter((e) => e.type === 'file')
    .map((e) => ({ path: e.path, size: e.lfs?.size ?? e.size ?? 0, sha256: e.lfs?.oid ?? null }))
}

export const isGguf = (path: string) => path.toLowerCase().endsWith('.gguf')
export const isMmproj = (path: string) => /mmproj/i.test(path) && isGguf(path)

/** A Hub path's last segment, which is the name a file is stored under (flat, per repo). */
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** A Hub path's directory, `''` at the top of the repo. */
const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** Quantisation preference when the user did not name a file. */
const PREFERRED_QUANTS = ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q8_0', 'Q6_K', 'Q4_0', 'F16', 'BF16']

/**
 * Which .gguf to pull. An explicit file wins; otherwise the sole model file, or the best
 * quantisation in PREFERRED_QUANTS. Multi-part files (`-00001-of-00003.gguf`) are not
 * supported yet and are excluded from auto-selection.
 */
export function chooseGguf(files: HfFile[], explicit: string | null): HfFile {
  const models = files.filter((f) => isGguf(f.path) && !isMmproj(f.path))
  if (explicit) {
    const exact = models.find((f) => f.path === explicit || f.path.endsWith(`/${explicit}`))
    if (exact) return exact
    const names = models.map((f) => f.path)
    throw new ObrewError('bad_request', `file "${explicit}" not found. Available: ${names.join(', ') || '(none)'}`)
  }
  const single = models.filter((f) => !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path))
  if (single.length === 1) return single[0]!
  for (const quant of PREFERRED_QUANTS) {
    const hit = single.find((f) => f.path.toUpperCase().includes(quant))
    if (hit) return hit
  }
  if (single.length === 0) throw new ObrewError('bad_request', 'no .gguf files in that repo')
  throw new ObrewError(
    'bad_request',
    `several .gguf files; name one with repo:file. Available: ${single.map((f) => f.path).join(', ')}`,
  )
}

/** The multimodal projector for a vision model: an explicit name, else prefer f16. */
export function chooseMmproj(files: HfFile[], explicit: string | null): HfFile {
  const projs = files.filter((f) => isMmproj(f.path))
  if (explicit) {
    const exact = projs.find((f) => f.path === explicit || f.path.endsWith(`/${explicit}`))
    if (exact) return exact
    throw new ObrewError('bad_request', `mmproj "${explicit}" not found. Available: ${projs.map((f) => f.path).join(', ') || '(none)'}`)
  }
  if (projs.length === 0) throw new ObrewError('bad_request', 'no mmproj file in that repo')
  // `f16` but not `bf16`: the plain half-precision projector is the safe default.
  return projs.find((f) => /(?<![a-z])f16/i.test(f.path)) ?? projs.find((f) => /bf16/i.test(f.path)) ?? projs[0]!
}

/**
 * The projector the repo publishes for this model, or null when none clearly is its own. A
 * repo can hold several models, in subfolders or side by side, and llama-server does not start
 * with another model's projector — so only one in the model's own directory counts, and only
 * when its name names no model (`mmproj-F16.gguf`, `mmproj-model-f16.gguf`) or names this one
 * (`mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf` beside `Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf`, not
 * beside the text-only `Qwen2.5-7B-Instruct-Q4_K_M.gguf`). Anything less certain is left for
 * `--mmproj` to ask for.
 */
export function projectorFor(files: HfFile[], modelPath: string): HfFile | null {
  const dir = dirName(modelPath)
  const model = new Set(words(fileName(modelPath)))
  const own = files.filter((f) => isMmproj(f.path) && dirName(f.path) === dir && projectorNames(f.path).every((w) => model.has(w)))
  return own.length > 0 ? chooseMmproj(own, null) : null
}

/** The words a projector's file name says about its model: not its precision, `mmproj`, `model`. */
function projectorNames(path: string): string[] {
  const stem = fileName(path)
    .replace(/\.gguf$/i, '')
    .replace(/[-_.](?:b?f(?:16|32)|fp(?:16|32)|i?q\d+(?:_[a-z0-9]+)*)$/i, '')
  return words(stem).filter((w) => w !== 'mmproj' && w !== 'model')
}
