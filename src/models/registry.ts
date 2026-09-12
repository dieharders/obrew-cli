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

export const ModelEntrySchema = z.object({
  id: z.string(),
  repoId: z.string(),
  file: z.string(),
  path: z.string(),
  mmprojPath: z.string().nullable(),
  sizeBytes: z.number(),
  addedAt: z.string(),
})
export type ModelEntry = z.infer<typeof ModelEntrySchema>

export const RegistrySchema = z.object({
  version: z.literal(1),
  default: z.string().nullable(),
  models: z.array(ModelEntrySchema),
})
export type Registry = z.infer<typeof RegistrySchema>

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

/** Insert or replace by id. The first model installed becomes the default. */
export async function addModel(entry: ModelEntry): Promise<Registry> {
  const registry = await loadRegistry()
  registry.models = registry.models.filter((m) => m.id !== entry.id)
  registry.models.push(entry)
  if (!registry.default) registry.default = entry.id
  await saveRegistry(registry)
  return registry
}

export async function removeModel(query: string): Promise<ModelEntry> {
  const registry = await loadRegistry()
  const entry = findModel(registry, query)
  if (!entry) throw new ObrewError('model_missing', `no installed model matches "${query}"`)
  registry.models = registry.models.filter((m) => m.id !== entry.id)
  if (registry.default === entry.id) registry.default = registry.models[0]?.id ?? null
  await saveRegistry(registry)
  await rm(entry.path, { force: true })
  if (entry.mmprojPath) await rm(entry.mmprojPath, { force: true })
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

/** The model an `exec` will run: the query, else the default. Its file must still exist. */
export async function resolveModel(query: string | null | undefined): Promise<ModelEntry> {
  const registry = await loadRegistry()
  const key = query && query !== 'default' ? query : registry.default
  if (!key) {
    throw new ObrewError('model_missing', 'no model installed; run `obrew login` or `obrew models pull <repo>`')
  }
  const entry = findModel(registry, key)
  if (!entry) throw new ObrewError('model_missing', `no installed model matches "${key}"`)
  if (!(await Bun.file(entry.path).exists())) {
    throw new ObrewError('model_missing', `model file is missing: ${entry.path}; run \`obrew models pull ${entry.id}\``)
  }
  return entry
}
