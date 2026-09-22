/**
 * `<data>/models.json`: which models are installed and which one is the default.
 *
 * Successor to obrew-engine's `settings/installed_models.json` and the HF cache layout it
 * indexed. Files are stored flat (`models/<org>--<repo>/<file>`), so the registry is the only
 * index and a model's id is simply `repo:file`.
 */
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { ObrewError } from '../shared/errors'
import { registryPath } from '../shared/paths'

/**
 * The built-in default chat model: the out-of-the-box default, and what `obrew login` installs
 * on a fresh machine. It applies when nothing else here does; once the user or a host chooses
 * another (`obrew models use <id>`), login installs that one instead and never reinstates this.
 *
 * Gemma 4 E2B at Q8_0 (~5 GB). On the same deck builds it finished in either tool mode with
 * the better content; Qwen3.5-2B finished only under `universal` and overran its time budget.
 * Qwen3-0.6B could fill a plan but not drive a build: it lost count of slides under a long
 * schema and re-issued the same tool call until the loop cut it off. 8-bit rather than Q4
 * because at this size the quantisation error is a real share of the model, and the larger
 * download is cheap next to a tool call that comes out wrong.
 */
export const BUILT_IN_DEFAULT_MODEL = 'unsloth/gemma-4-E2B-it-GGUF:gemma-4-E2B-it-Q8_0.gguf'

export const ModelEntrySchema = z.object({
  id: z.string(),
  repoId: z.string(),
  file: z.string(),
  path: z.string(),
  mmprojPath: z.string().nullable(),
  /**
   * Whether the repo listed a vision projector for this model the last time this entry was
   * pulled. Absent means never checked, which is every entry written before this field existed.
   * `obrew login` reads it to decide whether an installed model with no projector is worth one
   * listing request: `false` is a text-only model, and asking again on every login would be waste.
   */
  mmprojPublished: z.boolean().optional(),
  /**
   * `obrew login --no-mmproj` declined this model's projector. A later bare login fetches none
   * for it, not even one it had and lost, until a pull with `--mmproj` asks for one again.
   */
  mmprojDeclined: z.boolean().optional(),
  sizeBytes: z.number(),
  addedAt: z.string(),
})
export type ModelEntry = z.infer<typeof ModelEntrySchema>

export const RegistrySchema = z.object({
  version: z.literal(1),
  /** The chosen default. `null` means none was chosen, and `defaultModelId` decides. */
  default: z.string().nullable(),
  models: z.array(ModelEntrySchema),
})
export type Registry = z.infer<typeof RegistrySchema>

/**
 * The default model's id: the one chosen with `obrew models use` or `obrew login`, else the
 * built-in one when it is on this machine, else whatever else is. Never absent.
 *
 * That last step is what keeps a machine set up with `obrew models pull` alone usable: nothing
 * was chosen and the built-in model was never downloaded, so the model that IS here is the one
 * an `exec` should run. It applies only while no choice has been made, so the default still
 * never depends on pull order once one has.
 */
export function defaultModelId(registry: Registry): string {
  if (registry.default) return registry.default
  if (registry.models.some((m) => m.id === BUILT_IN_DEFAULT_MODEL)) return BUILT_IN_DEFAULT_MODEL
  return registry.models[0]?.id ?? BUILT_IN_DEFAULT_MODEL
}

/**
 * The default model as a host should see it: which one, whether chosen, whether installed, and
 * its entry when there is one, so a caller never looks it up a second time and differently.
 */
export async function defaultModel(
  registry: Registry,
): Promise<{ id: string; chosen: string | null; installed: boolean; entry: ModelEntry | null }> {
  const id = defaultModelId(registry)
  const entry = findModel(registry, id)
  return { id, chosen: registry.default, installed: entry ? await isOnDisk(entry) : false, entry }
}

/**
 * Whether this entry's model is on disk as it was downloaded. A missing file, or one of another
 * size than the bytes that were written, is not the same model and is pulled again.
 *
 * `sizeBytes` is stat'd from the finished file, never taken from the Hub's listing: a listing
 * that is stale, or that advertises no size at all, would otherwise mark a download that
 * verified against its SHA-256 as incomplete forever. Entries written before that (or by such
 * a listing) carry 0, and then existence is all there is to check.
 */
export async function isOnDisk(entry: ModelEntry): Promise<boolean> {
  const file = Bun.file(entry.path)
  if (!(await file.exists())) return false
  return entry.sizeBytes <= 0 || file.size === entry.sizeBytes
}

/**
 * The vision projector this entry can actually use: its recorded path while that file is on
 * disk, else null. A path that is gone is not vision support — llama-server does not start
 * when `--mmproj` points at nothing — and `obrew models pull <id>` fetches it again.
 */
export async function projectorPath(entry: ModelEntry): Promise<string | null> {
  if (!entry.mmprojPath) return null
  return (await Bun.file(entry.mmprojPath).exists()) ? entry.mmprojPath : null
}

const EMPTY: Registry = { version: 1, default: null, models: [] }

export async function loadRegistry(): Promise<Registry> {
  const file = Bun.file(registryPath())
  if (!(await file.exists())) return { ...EMPTY, models: [] }
  const parsed = RegistrySchema.safeParse(await file.json())
  if (!parsed.success) throw new Error(`models.json is malformed: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  return parsed.data
}

export async function saveRegistry(registry: Registry): Promise<void> {
  const path = registryPath()
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(registry, null, 2) + '\n')
}

/**
 * Insert or replace by id. A plain `obrew models pull` never touches the chosen default, so it
 * does not depend on which model happened to be pulled first; `makeDefault` is `obrew login`
 * and `obrew models use` choosing one, in the same write as the insert so that a concurrent
 * pull cannot be lost between the two.
 */
export async function addModel(entry: ModelEntry, opts: { makeDefault?: boolean } = {}): Promise<Registry> {
  const registry = await loadRegistry()
  registry.models = registry.models.filter((m) => m.id !== entry.id)
  registry.models.push(entry)
  if (opts.makeDefault) registry.default = entry.id
  await saveRegistry(registry)
  return registry
}

export async function removeModel(query: string): Promise<ModelEntry> {
  const registry = await loadRegistry()
  const entry = findModel(registry, query)
  if (!entry) throw new ObrewError('model_missing', `no installed model matches "${query}"`)
  registry.models = registry.models.filter((m) => m.id !== entry.id)
  // Removing the chosen default un-chooses it rather than promoting a replacement; what
  // applies next is `defaultModelId`'s rule, which prefers the built-in model but falls back
  // to a surviving one, so a machine that still has a model it can run stays usable.
  if (registry.default === entry.id) registry.default = null
  await saveRegistry(registry)
  await rm(entry.path, { force: true })
  // Every quant of a repo shares its projector (`models/<org>--<repo>/mmproj-F16.gguf`), so it
  // goes with the last entry that uses it, not with the first one removed.
  const shared = registry.models.some((m) => m.mmprojPath === entry.mmprojPath)
  if (entry.mmprojPath && !shared) await rm(entry.mmprojPath, { force: true })
  return entry
}

export async function setDefault(query: string): Promise<ModelEntry> {
  const registry = await loadRegistry()
  const entry = findModel(registry, query)
  if (!entry) throw new ObrewError('model_missing', `no installed model matches "${query}"`)
  registry.default = entry.id
  await saveRegistry(registry)
  return entry
}

/** Exact id, else a unique match on repo id, else a unique match on file name. */
export function findModel(registry: Registry, query: string): ModelEntry | null {
  const exact = registry.models.find((m) => m.id === query)
  if (exact) return exact
  const byRepo = registry.models.filter((m) => m.repoId === query)
  if (byRepo.length === 1) return byRepo[0]!
  const byFile = registry.models.filter((m) => m.file === query)
  if (byFile.length === 1) return byFile[0]!
  return null
}

/** The model an `exec` will run: the query, else the default. It must be on disk. */
export async function resolveModel(query: string | null | undefined): Promise<ModelEntry> {
  const registry = await loadRegistry()
  const wantsDefault = !query || query === 'default'
  const key = wantsDefault ? defaultModelId(registry) : query
  const entry = findModel(registry, key)
  if (!entry) {
    throw new ObrewError(
      'model_missing',
      wantsDefault ? `the default model ${key} is not installed; run \`obrew login\`` : `no installed model matches "${key}"`,
    )
  }
  if (!(await isOnDisk(entry))) {
    throw new ObrewError('model_missing', `model file is missing or incomplete: ${entry.path}; run \`obrew models pull ${entry.id}\``)
  }
  return entry
}
