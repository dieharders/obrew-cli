/**
 * Install an image model bundle: a curated preset, or components named one by one.
 *
 * The order of operations is the design:
 *  1. the plan — every file, its size, and whether it is already here — goes out FIRST as one
 *     `download.plan` event, so a host can show "7.4 GB to download" before a byte moves;
 *  2. free disk space is checked against what remains to fetch;
 *  3. files are fetched SMALLEST first, so a 404, an auth wall or a bad pin fails in seconds,
 *     not after the 4.5 GB file;
 *  4. each file is `downloadVerified` (resumable, SHA-256-checked) and registered as it lands, so
 *     an interrupted setup keeps what finished and resumes the rest;
 *  5. the bundle is written only when every component is verified, so a half-pulled model is
 *     never resolvable.
 *
 * A file already in the registry is not fetched again, whichever bundle brought it (the shared
 * Qwen3-4B). A file found at its destination but not in the registry — a registry that was lost,
 * a pre-seeded download — is hashed, and adopted when it matches rather than downloaded again.
 */
import { rm, statfs } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { authHeaders, listRepoFiles, resolveUrl } from '../models/hf'
import { downloadVerified, humanBytes } from '../shared/download'
import { ObrewError } from '../shared/errors'
import { imageModelsDir, upscalersDir } from './paths'
import { findPreset, presetFiles, ROLES, type Caps, type Defaults, type PinnedFile, type Preset, type Role, type Tier } from './presets'
import { assertSlot, loadImageRegistry, updateImageRegistry, type Bundle, type ImageRegistry, type Slot } from './registry'

export interface PlanFile {
  role: Role
  file: PinnedFile
  dest: string
  cached: boolean
}

export interface PullCallbacks {
  token?: string
  signal: AbortSignal
  onPlan?: (files: PlanFile[], totalBytes: number) => void
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

/** `<models>/<org>--<repo>/<path in repo>`; upscalers flat, where sd-server scans for them. */
export function destFor(role: Role, file: PinnedFile): string {
  if (role === 'upscaler') return join(upscalersDir(), basename(file.path))
  return join(imageModelsDir(), file.repo.replace('/', '--'), ...file.path.split('/'))
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) hasher.update(chunk)
  return hasher.digest('hex')
}

/** `name.gguf` → `name@<sha12>.gguf`: the destination when another file already lives at `dest`. */
const distinctPath = (dest: string, sha256: string) => {
  const ext = extname(dest)
  return `${dest.slice(0, dest.length - ext.length)}@${sha256.slice(0, 12)}${ext}`
}

/**
 * Whether `file` is here: registered and on disk, or on disk at its destination with matching
 * bytes. Two files can want one destination — another revision of the same path, two upscalers
 * of the same name — so a destination registered to OTHER bytes is never touched: this file
 * gets a name of its own instead.
 */
async function locate(registry: ImageRegistry, role: Role, file: PinnedFile, log: (m: string) => void): Promise<{ dest: string; cached: boolean; adopt: boolean }> {
  const known = registry.files[file.sha256]
  if (known) {
    const f = Bun.file(known.path)
    if ((await f.exists()) && f.size === known.size) return { dest: known.path, cached: true, adopt: false }
  }
  let dest = destFor(role, file)
  if (Object.entries(registry.files).some(([sha, entry]) => sha !== file.sha256 && entry.path === dest)) dest = distinctPath(dest, file.sha256)
  const f = Bun.file(dest)
  // A listing with no sizes (size 0) gives nothing to compare: the hash decides.
  if ((await f.exists()) && (file.size <= 0 || f.size === file.size)) {
    log(`verifying ${file.path} already on disk`)
    if ((await sha256Of(dest)) === file.sha256) return { dest, cached: true, adopt: true }
    log(`${file.path} on disk does not match its checksum; downloading it again`)
    await rm(dest, { force: true })
  }
  return { dest, cached: false, adopt: false }
}

async function freeBytes(dir: string): Promise<number | null> {
  // The directory may not exist yet: ask about the nearest one that does.
  for (let d = dir; ; d = dirname(d)) {
    try {
      const s = await statfs(d)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      if (dirname(d) === d) return null
    }
  }
}

/**
 * Record a verified file where its bytes ARE, at the size they ARE: a re-fetch into another
 * repo's directory moves the entry with it, and a listing that advertised no size (0) is not
 * what `isComplete` later compares the file against.
 */
const register = (registry: ImageRegistry, file: PinnedFile, dest: string) => {
  const sources = registry.files[file.sha256]?.sources ?? []
  if (!sources.some((s) => s.repo === file.repo && s.revision === file.revision && s.path === file.path)) {
    sources.push({ repo: file.repo, revision: file.revision, path: file.path })
  }
  registry.files[file.sha256] = { size: Bun.file(dest).size, path: dest, sources }
}

export interface BundleDefinition {
  id: string
  preset: string | null
  kind: Bundle['kind']
  title: string
  license: string | null
  files: Array<{ role: Role; file: PinnedFile }>
  defaults: Defaults
  caps: Caps
  align: number
  maxPixels: number
}

export const definitionFromPreset = (preset: Preset, tier: Tier): BundleDefinition => ({
  id: preset.id,
  preset: preset.id,
  kind: preset.kind,
  title: preset.title,
  license: preset.license,
  files: presetFiles(preset, tier),
  defaults: preset.defaults,
  caps: preset.caps,
  align: preset.align,
  maxPixels: preset.maxPixels,
})

/** Fetch whatever of `def` is missing, then record the bundle (and, if asked, make it a default). */
export async function pullBundle(def: BundleDefinition, cb: PullCallbacks & { makeDefault?: Slot[] }): Promise<Bundle> {
  const log = cb.onLog ?? (() => {})
  for (const slot of cb.makeDefault ?? []) assertSlot(def, slot)
  const registry = await loadImageRegistry()

  const plan: PlanFile[] = []
  const adopt: PlanFile[] = []
  for (const { role, file } of def.files) {
    const where = await locate(registry, role, file, log)
    const item = { role, file, dest: where.dest, cached: where.cached }
    plan.push(item)
    if (where.adopt) adopt.push(item)
  }
  const missing = plan.filter((p) => !p.cached)
  const totalBytes = missing.reduce((n, p) => n + p.file.size, 0)
  cb.onPlan?.(plan, totalBytes)
  if (adopt.length) await updateImageRegistry((r) => adopt.forEach((p) => register(r, p.file, p.dest)))

  if (missing.length) {
    const free = await freeBytes(imageModelsDir())
    const margin = 1024 ** 3
    if (free !== null && free < totalBytes + margin) {
      throw new ObrewError('bad_request', `not enough disk space for ${def.id}: ${humanBytes(totalBytes)} to download, ${humanBytes(free)} free`)
    }
  }

  // Smallest first: a wrong pin or an auth wall fails before the big transfer.
  for (const item of [...missing].sort((a, b) => a.file.size - b.file.size)) {
    const { file } = item
    log(`downloading ${file.repo}/${file.path} (${humanBytes(file.size)})`)
    await downloadVerified(
      {
        url: resolveUrl(file.repo, file.path, file.revision),
        sha256: file.sha256,
        size: file.size,
        dest: item.dest,
        headers: authHeaders(cb.token),
      },
      cb.signal,
      (received, total) => cb.onProgress?.(file.path, received, total),
    )
    await updateImageRegistry((r) => register(r, file, item.dest))
  }

  const bundle: Bundle = {
    id: def.id,
    preset: def.preset,
    kind: def.kind,
    title: def.title,
    license: def.license,
    components: def.files.map(({ role, file }) => ({ role, sha256: file.sha256 })),
    defaults: def.defaults,
    caps: def.caps,
    align: def.align,
    maxPixels: def.maxPixels,
    addedAt: new Date().toISOString(),
  }
  await updateImageRegistry((r) => {
    for (const p of plan) register(r, p.file, p.dest)
    const existing = r.bundles.find((b) => b.id === bundle.id)
    if (existing) bundle.addedAt = existing.addedAt
    r.bundles = r.bundles.filter((b) => b.id !== bundle.id)
    r.bundles.push(bundle)
    for (const slot of cb.makeDefault ?? []) {
      if (slot === 'generator') r.default = bundle.id
      else if (slot === 'edit') r.defaultEdit = bundle.id
      else r.upscaler = bundle.id
    }
  })
  log(missing.length ? `installed ${bundle.id}` : `${bundle.id} is already installed`)
  return bundle
}

export async function pullPreset(id: string, tier: Tier, cb: PullCallbacks & { makeDefault?: Slot[] }): Promise<Bundle> {
  const preset = findPreset(id)
  if (!preset) throw new ObrewError('bad_request', `"${id}" is not a curated image model; see \`obrew image models list\``)
  return pullBundle(definitionFromPreset(preset, tier), cb)
}

/** `org/repo[@revision]:path/in/repo` */
export function parseComponentSpec(spec: string): { repo: string; revision: string; path: string } {
  const m = spec.trim().match(/^([\w.-]+\/[\w.-]+)(?:@([\w.-]+))?:(.+)$/)
  if (!m) throw new ObrewError('bad_request', `"${spec}" is not org/repo[@revision]:path`)
  return { repo: m[1]!, revision: m[2] ?? 'main', path: m[3]! }
}

export interface CustomBundle {
  name: string
  components: Array<{ role: Role; spec: string }>
  defaults: Defaults
  caps: Partial<Caps>
}

/** A bundle from named components: each one's hash and size come from the Hub's listing. */
export async function pullCustom(custom: CustomBundle, cb: PullCallbacks & { makeDefault?: Slot[] }): Promise<Bundle> {
  if (custom.components.length === 0) throw new ObrewError('bad_request', 'name at least one component (--diffusion, --model, --llm, --vae, …)')
  const files: BundleDefinition['files'] = []
  for (const { role, spec } of custom.components) {
    if (!ROLES.includes(role)) throw new ObrewError('bad_request', `unknown role ${role}`)
    const { repo, revision, path } = parseComponentSpec(spec)
    const listing = await listRepoFiles(repo, cb.token, cb.signal, revision)
    const hit = listing.find((f) => f.path === path)
    if (!hit) throw new ObrewError('bad_request', `${path} is not in ${repo}@${revision}`)
    if (!hit.sha256) throw new ObrewError('bad_request', `${repo}/${path} is not an LFS file, so the Hub gives no checksum to verify it against`)
    files.push({ role, file: { repo, revision, path, sha256: hit.sha256, size: hit.size } })
  }
  const isUpscaler = files.length === 1 && files[0]!.role === 'upscaler'
  return pullBundle(
    {
      id: custom.name,
      preset: null,
      kind: isUpscaler ? 'upscaler' : 'generator',
      title: custom.name,
      license: null,
      files,
      defaults: custom.defaults,
      caps: {
        generate: !isUpscaler,
        img2img: !isUpscaler,
        edit: false,
        upscale: isUpscaler,
        maxRefs: 0,
        ...(isUpscaler ? { scale: 4 } : {}),
        ...custom.caps,
      },
      align: 16,
      maxPixels: 1_100_000,
    },
    cb,
  )
}
