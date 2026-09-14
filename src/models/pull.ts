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
import { authHeaders, chooseGguf, chooseMmproj, listRepoFiles, modelId, parseModelSpec, resolveUrl, type HfFile } from './hf'
import { addModel, loadRegistry, findModel, isOnDisk, type ModelEntry } from './registry'

export interface PullOptions {
  /** `org/repo[:file]` */
  spec: string
  /** `true` = pick the repo's mmproj automatically; a string names one. */
  mmproj?: boolean | string
  token?: string
  signal: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

const repoDir = (repoId: string) => join(modelsDir(), repoId.replace('/', '--'))

async function fetchFile(repoId: string, file: HfFile, opts: PullOptions): Promise<string> {
  const dest = join(repoDir(repoId), file.path.split('/').pop()!)
  if ((await Bun.file(dest).exists()) && Bun.file(dest).size === file.size) {
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
  // that is missing or of another size is not that model, and is fetched again.
  const registry = await loadRegistry()
  const existing = file ? findModel(registry, modelId(repoId, file)) : null
  if (existing && !opts.mmproj && (await isOnDisk(existing))) {
    opts.onLog?.(`${existing.id} is already installed`)
    return existing
  }

  const files = await listRepoFiles(repoId, opts.token, opts.signal)
  const gguf = chooseGguf(files, file)
  const path = await fetchFile(repoId, gguf, opts)

  let mmprojPath: string | null = existing?.mmprojPath ?? null
  if (opts.mmproj) {
    const proj = chooseMmproj(files, typeof opts.mmproj === 'string' ? opts.mmproj : null)
    mmprojPath = await fetchFile(repoId, proj, opts)
  }

  const entry: ModelEntry = {
    id: modelId(repoId, gguf.path.split('/').pop()!),
    repoId,
    file: gguf.path.split('/').pop()!,
    path,
    mmprojPath,
    sizeBytes: gguf.size,
    addedAt: new Date().toISOString(),
  }
  await addModel(entry)
  opts.onLog?.(`installed ${entry.id}`)
  return entry
}
