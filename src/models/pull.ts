/**
 * `obrew models pull`: fetch a GGUF (and optionally its mmproj) from Hugging Face.
 *
 * Port of the useful parts of obrew-engine's DownloadManager: progress, cancel, resume of a
 * partial file, and the linked mmproj download. Gone: the worker pool and the multiprocessing
 * queue — one download at a time, in this process, with an AbortSignal.
 */
import { basename, join } from 'node:path'
import { downloadVerified } from '../shared/download'
import { modelsDir } from '../shared/paths'
import { authHeaders, chooseGguf, chooseMmproj, fileName, listRepoFiles, modelId, parseModelSpec, projectorFor, resolveUrl, type HfFile } from './hf'
import { addModel, loadRegistry, findModel, isOnDisk, projectorPath, setDefault, type ModelEntry } from './registry'

export interface PullOptions {
  /** `org/repo[:file]` */
  spec: string
  /** `true` = pick the repo's mmproj automatically; a string names one. The pull fails without it. */
  mmproj?: boolean | string
  /**
   * A projector `mmproj` did not ask for. `fetch` is `obrew login`'s default: the one the repo
   * publishes for this model comes with it, and never fails the pull. `mmproj: true` throws for
   * a text-only repo, so a host cannot pass it blindly, and a bare login used to leave every
   * vision model blind (MotionBuff job job-20260921211527-3d1aba52b673 critiqued five stills it
   * was never shown). `skip` is `login --no-mmproj`: none is fetched, and the entry records that
   * so a later `fetch` leaves it alone too. Absent (`obrew models pull`): the entry keeps the
   * projector it has, and gets back one it lost.
   */
  optionalMmproj?: 'fetch' | 'skip'
  /** How long a listing made only to look for an optional projector may take. */
  checkTimeoutMs?: number
  /** Make it the default once it is installed. `obrew login` does; `obrew models pull` does not. */
  makeDefault?: boolean
  token?: string
  signal: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

/**
 * The default for `checkTimeoutMs`. Without a bound, a network that drops packets holds a login
 * on a model that is already installed for minutes, and again at every login after it, since a
 * check that never answered records nothing.
 */
const CHECK_TIMEOUT_MS = 10_000

const repoDir = (repoId: string) => join(modelsDir(), repoId.replace('/', '--'))
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function fetchFile(repoId: string, file: HfFile, opts: PullOptions): Promise<string> {
  const dest = join(repoDir(repoId), fileName(file.path))
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

  // Which model this is comes first, since everything below turns on its entry. A spec that
  // names no file leaves that to the listing, which it then needs whatever is on disk.
  let files: HfFile[] | null = file ? null : await listRepoFiles(repoId, opts.token, opts.signal)
  const picked = files ? chooseGguf(files, null) : null
  const name = picked ? fileName(picked.path) : fileName(file!)
  const existing = findModel(await loadRegistry(), modelId(repoId, name))

  // On disk as it was downloaded: then the model is never fetched again, whatever else this pull
  // does. A listing may advertise no size to check the file against, or no longer carry it.
  const installed = existing && (await isOnDisk(existing)) ? existing : null
  const strict = !!opts.mmproj
  // `--no-mmproj`, at this login or an earlier one; `mmproj` asking for a projector outranks both.
  const declined = !strict && (opts.optionalMmproj === 'skip' || !!existing?.mmprojDeclined)
  const hasProjector = !!existing && (await projectorPath(existing)) !== null
  // A projector the entry records but no longer has, which a pull fetches back unless it was
  // declined: an `--image` run would otherwise get no vision out of it.
  const projectorGone = !!existing?.mmprojPath && !hasProjector
  // An optional projector is worth a listing while the entry lacks one, unless an earlier listing
  // saw that the repo has none for it. An entry written before `mmprojPublished` existed was never
  // checked, so it asks once; a model to download is listed anyway, so that asks again for free.
  const worthAsking = !installed || existing?.mmprojPublished !== false
  const wantsProjector =
    strict || (!declined && (projectorGone || (opts.optionalMmproj === 'fetch' && !hasProjector && worthAsking)))

  // An installed entry that this pull downloads nothing for. A `--no-mmproj` is recorded all the
  // same, or the next bare login would fetch what it declined, and a declined projector that is
  // gone is dropped from the entry rather than left for something to look for.
  const keep = async (entry: ModelEntry): Promise<ModelEntry> => {
    opts.onLog?.(`${entry.id} is already installed`)
    if (!declined || (entry.mmprojDeclined && !projectorGone)) {
      if (opts.makeDefault) await setDefault(entry.id)
      return entry
    }
    const settled = { ...entry, mmprojPath: projectorGone ? null : entry.mmprojPath, mmprojDeclined: true }
    await addModel(settled, { makeDefault: opts.makeDefault })
    return settled
  }
  if (installed && !wantsProjector) return keep(installed)

  // Listed only for a projector the pull can do without: then the listing is bounded, and its
  // failure leaves the installed model as it is, for the next login to try again.
  const onlyProjector = strict ? null : installed
  if (!files) {
    const signal = onlyProjector
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS)])
      : opts.signal
    try {
      files = await listRepoFiles(repoId, opts.token, signal)
    } catch (err) {
      if (!onlyProjector || opts.signal.aborted) throw err
      opts.onLog?.(`could not check ${repoId} for a vision projector: ${errorText(err)}`)
      return keep(onlyProjector)
    }
  }

  // Where the model sits in the repo decides which projector is its own. One on disk is found in
  // the listing by name, and taken to sit at the top when upstream has since renamed or dropped
  // it: it is not fetched again, so the listing need not have it.
  const gguf = installed ? null : (picked ?? chooseGguf(files, file))
  const modelPath = gguf?.path ?? files.find((f) => fileName(f.path) === name)?.path ?? name
  const offered = projectorFor(files, modelPath)
  let proj: HfFile | null = null
  if (strict) {
    // Chosen before anything downloads, so a repo without one fails the pull before it costs a
    // model download: the one named, else the model's own, else the repo's.
    proj = typeof opts.mmproj === 'string' ? chooseMmproj(files, opts.mmproj) : (offered ?? chooseMmproj(files, null))
  } else if (wantsProjector) {
    // A lost projector comes back as the same file where the repo still has it, since
    // `--mmproj-file` may have picked another than the model's own. Files are stored flat, so its
    // name is all the entry kept.
    const lost = existing?.mmprojPath ? basename(existing.mmprojPath) : null
    proj = [offered, ...files].find((f) => f && fileName(f.path) === lost) ?? offered
  }

  // A projector the repo no longer has, or one declined, leaves a text-only entry rather than a
  // failed pull. One that fails to download stays recorded, so the next pull tries it again.
  let mmprojPath = projectorGone && !proj ? null : (existing?.mmprojPath ?? null)
  // The projector before the model: it is small, and a strict pull that fails on it then fails
  // before the model download instead of after it.
  if (proj) {
    try {
      mmprojPath = await fetchFile(repoId, proj, opts)
    } catch (err) {
      // Only `mmproj` makes a projector a condition of the pull. Otherwise the model installs
      // without one and runs as text, which is what it is still good for.
      if (strict || opts.signal.aborted) throw err
      opts.onLog?.(`could not download ${proj.path} (${errorText(err)}), so ${modelId(repoId, name)} has no vision yet; the next \`obrew login\` tries again`)
    }
  }
  const path = installed ? installed.path : await fetchFile(repoId, gguf!, opts)

  const entry: ModelEntry = {
    id: modelId(repoId, name),
    repoId,
    file: name,
    path,
    mmprojPath,
    mmprojPublished: offered !== null || proj !== null,
    ...(declined ? { mmprojDeclined: true } : {}),
    // The bytes that were written, not the size the listing advertised: `isOnDisk` compares
    // against this, and a listing that is stale or carries no size would otherwise mark a
    // download that verified against its SHA-256 as incomplete on every later run.
    sizeBytes: Bun.file(path).size,
    // When the model was first installed, which `/v1/models` reports as `created`: not moved by a
    // pull that repairs the entry or adds a projector to it.
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  }
  await addModel(entry, { makeDefault: opts.makeDefault })
  opts.onLog?.(`installed ${entry.id}`)
  return entry
}
