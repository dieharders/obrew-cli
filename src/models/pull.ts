/**
 * `obrew models pull`: fetch a GGUF (and optionally its mmproj) from Hugging Face.
 *
 * Port of the useful parts of obrew-engine's DownloadManager: progress, cancel, resume of a
 * partial file, and the linked mmproj download. Gone: the worker pool and the multiprocessing
 * queue — one download at a time, in this process, with an AbortSignal.
 */
import { join } from 'node:path'
import { downloadVerified } from '../shared/download'
import { modelsDir } from '../shared/paths'
import { authHeaders, chooseGguf, chooseMmproj, isMmproj, listRepoFiles, modelId, parseModelSpec, resolveUrl, type HfFile } from './hf'
import { addModel, loadRegistry, findModel, isOnDisk, projectorPath, setDefault, type ModelEntry } from './registry'

export interface PullOptions {
  /** `org/repo[:file]` */
  spec: string
  /** `true` = pick the repo's mmproj automatically; a string names one. */
  mmproj?: boolean | string
  /** Make it the default once it is installed. `obrew login` does; `obrew models pull` does not. */
  makeDefault?: boolean
  token?: string
  signal: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

const repoDir = (repoId: string) => join(modelsDir(), repoId.replace('/', '--'))

async function fetchFile(repoId: string, file: HfFile, opts: PullOptions): Promise<string> {
  const dest = join(repoDir(repoId), file.path.split('/').pop()!)
  // `file.size` is what the listing advertised, and a repo that advertises none gives 0 — which
  // must not let an empty leftover file pass for the artifact.
  if (file.size > 0 && (await Bun.file(dest).exists()) && Bun.file(dest).size === file.size) {
    opts.onLog?.(`${file.path} already present`)
    return dest
  }
  opts.onLog?.(`downloading ${repoId}/${file.path}`)
  await downloadVerified(
    {
      url: resolveUrl(repoId, file.path),
      sha256: file.sha256,
      size: file.size,
      dest,
      headers: authHeaders(opts.token),
    },
    opts.signal,
    (received, total) => opts.onProgress?.(file.path, received, total),
  )
  return dest
}

export async function pullModel(opts: PullOptions): Promise<ModelEntry> {
  const { repoId, file } = parseModelSpec(opts.spec)

  // Already on disk under that exact id: nothing to fetch (mmproj may still be added). A file
  // that is missing or of another size is not that model, and is fetched again — and so is a
  // projector the entry claims but no longer has, since an `--image` run would otherwise hand
  // llama-server an `--mmproj` path that is not there.
  const registry = await loadRegistry()
  const existing = file ? findModel(registry, modelId(repoId, file)) : null
  const projectorGone = !!existing?.mmprojPath && (await projectorPath(existing)) === null
  if (existing && !opts.mmproj && !projectorGone && (await isOnDisk(existing))) {
    opts.onLog?.(`${existing.id} is already installed`)
    if (opts.makeDefault) await setDefault(existing.id)
    return existing
  }

  const files = await listRepoFiles(repoId, opts.token, opts.signal)
  const gguf = chooseGguf(files, file)
  const path = await fetchFile(repoId, gguf, opts)

  let mmprojPath: string | null = existing?.mmprojPath ?? null
  if (opts.mmproj) {
    const proj = chooseMmproj(files, typeof opts.mmproj === 'string' ? opts.mmproj : null)
    mmprojPath = await fetchFile(repoId, proj, opts)
  } else if (projectorGone) {
    // Repairing what the entry recorded, not a request for vision: a repo that no longer
    // publishes a projector drops back to a text-only entry instead of failing the pull.
    const proj = files.some((f) => isMmproj(f.path)) ? chooseMmproj(files, null) : null
    mmprojPath = proj ? await fetchFile(repoId, proj, opts) : null
  }

  const entry: ModelEntry = {
    id: modelId(repoId, gguf.path.split('/').pop()!),
    repoId,
    file: gguf.path.split('/').pop()!,
    path,
    mmprojPath,
    // The bytes that were written, not the size the listing advertised: `isOnDisk` compares
    // against this, and a listing that is stale or carries no size would otherwise mark a
    // download that verified against its SHA-256 as incomplete on every later run.
    sizeBytes: Bun.file(path).size,
    addedAt: new Date().toISOString(),
  }
  await addModel(entry, { makeDefault: opts.makeDefault })
  opts.onLog?.(`installed ${entry.id}`)
  return entry
}
