/**
 * `<data>/image/models.json`: which image models are installed, and which are the defaults.
 *
 * An image model is a BUNDLE of files from several repos (diffusion weights, a text encoder, a
 * VAE), so the registry has two levels:
 *
 *   files     keyed by SHA-256: where the bytes are and which repo/revision/path they came from.
 *             Shared: Z-Image and FLUX.2 klein use the same Qwen3-4B file, stored once.
 *   bundles   a model as the engine sees it: role → file hash, plus its defaults and what it
 *             can do (generate, img2img, edit with references, upscale).
 *
 * Three defaults, each `null` until chosen (then the built-in preset id applies): the generator,
 * the editor `--ref` runs fall back to, and the upscaler. Reference counts are computed, never
 * stored, so removing a bundle deletes exactly the files no other bundle uses.
 */
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { ObrewError } from '../shared/errors'
import { imageRegistryPath } from './paths'
import { DEFAULT_EDITOR, DEFAULT_GENERATOR, DEFAULT_UPSCALER, ROLES, type Role } from './presets'

export const FileEntrySchema = z.object({
  size: z.number(),
  path: z.string(),
  sources: z.array(z.object({ repo: z.string(), revision: z.string(), path: z.string() })),
})
export type FileEntry = z.infer<typeof FileEntrySchema>

export const CapsSchema = z.object({
  generate: z.boolean(),
  img2img: z.boolean(),
  edit: z.boolean(),
  upscale: z.boolean(),
  maxRefs: z.number(),
  scale: z.number().optional(),
})

export const BundleSchema = z.object({
  id: z.string(),
  /** The preset it was installed from, or null for a custom bundle. */
  preset: z.string().nullable(),
  kind: z.enum(['generator', 'upscaler']),
  title: z.string(),
  license: z.string().nullable(),
  // A string, not z.enum(ROLES): a role added later (as `tokenizer` was) must make only the bundle
  // that uses it unusable to this build, not the whole registry unreadable. See resolveBundle.
  components: z.array(z.object({ role: z.string(), sha256: z.string() })),
  defaults: z.object({ steps: z.number(), cfg: z.number(), sampler: z.string().optional() }),
  caps: CapsSchema,
  align: z.number(),
  maxPixels: z.number(),
  addedAt: z.string(),
})
export type Bundle = z.infer<typeof BundleSchema>

export const ImageRegistrySchema = z.object({
  version: z.literal(1),
  default: z.string().nullable(),
  defaultEdit: z.string().nullable(),
  upscaler: z.string().nullable(),
  files: z.record(z.string(), FileEntrySchema),
  bundles: z.array(BundleSchema),
})
export type ImageRegistry = z.infer<typeof ImageRegistrySchema>

const empty = (): ImageRegistry => ({ version: 1, default: null, defaultEdit: null, upscaler: null, files: {}, bundles: [] })

export async function loadImageRegistry(): Promise<ImageRegistry> {
  const file = Bun.file(imageRegistryPath())
  if (!(await file.exists())) return empty()
  const parsed = ImageRegistrySchema.safeParse(await file.json())
  if (!parsed.success) throw new Error(`image/models.json is malformed: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  return parsed.data
}

export async function saveImageRegistry(registry: ImageRegistry): Promise<void> {
  const path = imageRegistryPath()
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(registry, null, 2) + '\n')
}

/** Read-modify-write in one place, so every writer re-reads what a concurrent pull just wrote. */
export async function updateImageRegistry(change: (registry: ImageRegistry) => void): Promise<ImageRegistry> {
  const registry = await loadImageRegistry()
  change(registry)
  await saveImageRegistry(registry)
  return registry
}

export type Slot = 'generator' | 'edit' | 'upscaler'

/** The id each slot resolves to: the chosen one, else the built-in preset. Never absent. */
export function slotId(registry: ImageRegistry, slot: Slot): string {
  if (slot === 'generator') return registry.default ?? DEFAULT_GENERATOR
  if (slot === 'edit') return registry.defaultEdit ?? DEFAULT_EDITOR
  return registry.upscaler ?? DEFAULT_UPSCALER
}

export const findBundle = (registry: ImageRegistry, query: string): Bundle | null =>
  registry.bundles.find((b) => b.id === query) ?? registry.bundles.find((b) => b.preset === query) ?? null

/** Whether every file of the bundle is on disk at the size it was written with. */
export async function isComplete(registry: ImageRegistry, bundle: Bundle): Promise<boolean> {
  for (const c of bundle.components) {
    const entry = registry.files[c.sha256]
    if (!entry) return false
    const file = Bun.file(entry.path)
    if (!(await file.exists()) || file.size !== entry.size) return false
  }
  return true
}

export interface ResolvedBundle {
  bundle: Bundle
  /** Role → absolute path. */
  paths: Partial<Record<Role, string>>
  /** Role → SHA-256, for the engine's reuse key. */
  hashes: Partial<Record<Role, string>>
  /** Total bytes of its files: the basis of the memory estimate. */
  bytes: number
}

export function pathsOf(registry: ImageRegistry, bundle: Bundle): ResolvedBundle {
  const paths: Partial<Record<Role, string>> = {}
  const hashes: Partial<Record<Role, string>> = {}
  let bytes = 0
  for (const c of bundle.components) {
    const entry = registry.files[c.sha256]
    if (!entry) continue
    paths[c.role as Role] = entry.path
    hashes[c.role as Role] = c.sha256
    bytes += entry.size
  }
  return { bundle, paths, hashes, bytes }
}

/**
 * The installed, complete bundle a run uses: the query, else the slot's default. A missing or
 * incomplete one is `model_missing`, whose fix (`obrew image setup`) a host already knows.
 */
export async function resolveBundle(query: string | null | undefined, slot: Slot): Promise<ResolvedBundle> {
  const registry = await loadImageRegistry()
  const wantsDefault = !query || query === 'default'
  const id = wantsDefault ? slotId(registry, slot) : query
  const bundle = findBundle(registry, id)
  if (!bundle) {
    throw new ObrewError(
      'model_missing',
      wantsDefault ? `the default image model ${id} is not installed; run \`obrew image setup\`` : `no installed image model matches "${id}"; see \`obrew image models list\``,
    )
  }
  const unknown = bundle.components.filter((c) => !(ROLES as readonly string[]).includes(c.role)).map((c) => c.role)
  if (unknown.length) throw new ObrewError('bad_request', `image model ${bundle.id} needs a newer obrew (it has a ${unknown.join(', ')} file this version cannot pass to the engine)`)
  if (!(await isComplete(registry, bundle))) {
    const fix = bundle.preset ? `\`obrew image models pull ${bundle.preset}\`` : `pull it again from its parts (\`obrew image models pull --name ${bundle.id} --diffusion …\`)`
    throw new ObrewError('model_missing', `image model ${bundle.id} is missing files; ${fix}`)
  }
  return pathsOf(registry, bundle)
}

/** A slot only for a bundle that can fill it. */
export function assertSlot(bundle: { id: string; caps: Bundle['caps'] }, slot: Slot): void {
  if (slot === 'upscaler' && !bundle.caps.upscale) throw new ObrewError('bad_request', `${bundle.id} is not an upscaler`)
  if (slot === 'edit' && !bundle.caps.edit) throw new ObrewError('bad_request', `${bundle.id} cannot edit with reference images`)
  if (slot === 'generator' && !bundle.caps.generate) throw new ObrewError('bad_request', `${bundle.id} does not generate images`)
}

export async function setSlot(query: string, slot: Slot): Promise<Bundle> {
  let found: Bundle | null = null
  await updateImageRegistry((registry) => {
    const bundle = findBundle(registry, query)
    if (!bundle) throw new ObrewError('model_missing', `no installed image model matches "${query}"`)
    assertSlot(bundle, slot)
    if (slot === 'generator') registry.default = bundle.id
    else if (slot === 'edit') registry.defaultEdit = bundle.id
    else registry.upscaler = bundle.id
    found = bundle
  })
  return found!
}

/** Remove a bundle, and every file no remaining bundle uses. A chosen slot it held is un-chosen. */
export async function removeBundle(query: string): Promise<{ bundle: Bundle; deleted: string[] }> {
  let removed: Bundle | null = null
  const deleted: string[] = []
  await updateImageRegistry((registry) => {
    const bundle = findBundle(registry, query)
    if (!bundle) throw new ObrewError('model_missing', `no installed image model matches "${query}"`)
    registry.bundles = registry.bundles.filter((b) => b.id !== bundle.id)
    if (registry.default === bundle.id) registry.default = null
    if (registry.defaultEdit === bundle.id) registry.defaultEdit = null
    if (registry.upscaler === bundle.id) registry.upscaler = null
    const used = new Set(registry.bundles.flatMap((b) => b.components.map((c) => c.sha256)))
    for (const c of bundle.components) {
      const entry = registry.files[c.sha256]
      if (!entry || used.has(c.sha256)) continue
      deleted.push(entry.path)
      delete registry.files[c.sha256]
    }
    removed = bundle
  })
  for (const path of deleted) await rm(path, { force: true }).catch(() => {})
  return { bundle: removed!, deleted }
}
