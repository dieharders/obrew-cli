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
  /**
   * Fetch the repo's projector when it publishes one, and never fail when it does not. This is
   * `obrew login`'s default: `mmproj: true` throws for a text-only repo, so a host cannot pass
   * it blindly, and a bare login used to leave every vision model blind (MotionBuff job
   * job-20260921211527-3d1aba52b673 critiqued five stills it was never shown).
   */
  mmprojIfPublished?: boolean
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
  // The entry itself while its model needs nothing fetched, so the checks below narrow on it.
  const installed = existing && !opts.mmproj && !projectorGone && (await isOnDisk(existing)) ? existing : null
  // An installed model with no projector is still worth one listing request when the caller
  // wants vision wherever it is on offer, unless an earlier pull saw that the repo has none.
  // An entry written before `mmprojPublished` existed has never been checked, so it asks once.
  const checkProjector = !!opts.mmprojIfPublished && !existing?.mmprojPath && existing?.mmprojPublished !== false
  const alreadyInstalled = async (entry: ModelEntry) => {
    opts.onLog?.(`${entry.id} is already installed`)
    if (opts.makeDefault) await setDefault(entry.id)
    return entry
  }
  if (installed && !checkProjector) return alreadyInstalled(installed)

  let files: HfFile[]
  try {
    files = await listRepoFiles(repoId, opts.token, opts.signal)
  } catch (err) {
    // The model is here and only the optional projector was being looked for: a machine that
    // is offline stays set up, and the next login asks again.
    if (!installed || opts.signal.aborted) throw err
    opts.onLog?.(`could not check ${repoId} for a vision projector: ${err instanceof Error ? err.message : String(err)}`)
    return alreadyInstalled(installed)
  }
  const gguf = chooseGguf(files, file)
  // An installed model is never fetched again on the projector's account. `fetchFile` would skip
  // it by size, but a listing that advertises no size skips nothing.
  const path = installed ? installed.path : await fetchFile(repoId, gguf, opts)

  const mmprojPublished = files.some((f) => isMmproj(f.path))
  let mmprojPath: string | null = existing?.mmprojPath ?? null
  if (opts.mmproj) {
    const proj = chooseMmproj(files, typeof opts.mmproj === 'string' ? opts.mmproj : null)
    mmprojPath = await fetchFile(repoId, proj, opts)
  } else if (projectorGone || (opts.mmprojIfPublished && !mmprojPath)) {
    // Repairing what the entry recorded, or taking vision where it is on offer; neither is a
    // demand for it. A repo that publishes no projector gives a text-only entry instead of
    // failing the pull.
    mmprojPath = mmprojPublished ? await fetchFile(repoId, chooseMmproj(files, null), opts) : null
  }

  const entry: ModelEntry = {
    id: modelId(repoId, gguf.path.split('/').pop()!),
    repoId,
    file: gguf.path.split('/').pop()!,
    path,
    mmprojPath,
    mmprojPublished,
    // The bytes that were written, not the size the listing advertised: `isOnDisk` compares
    // against this, and a listing that is stale or carries no size would otherwise mark a
    // download that verified against its SHA-256 as incomplete on every later run.
    sizeBytes: Bun.file(path).size,
    addedAt: installed?.addedAt ?? new Date().toISOString(),
  }
  await addModel(entry, { makeDefault: opts.makeDefault })
  opts.onLog?.(`installed ${entry.id}`)
  return entry
}
