/**
 * Image models for tests: the three presets' bundles, registered under their real ids and
 * capabilities but backed by tiny files, so every code path runs without gigabytes of weights.
 * The fake sd-server (./fake-sd-server.ts) never reads them; it only needs the paths on its
 * command line.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { imageModelsDir, upscalersDir } from '../../src/image/paths'
import { PRESETS, type Role } from '../../src/image/presets'
import { saveImageRegistry, type Bundle, type ImageRegistry } from '../../src/image/registry'

const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')

/** Register `ids` (default: all three presets) as installed, with tiny files on disk. */
export async function seedImageModels(ids: string[] = PRESETS.map((p) => p.id), defaults: Partial<Pick<ImageRegistry, 'default' | 'defaultEdit' | 'upscaler'>> = {}): Promise<ImageRegistry> {
  const registry: ImageRegistry = { version: 1, default: null, defaultEdit: null, upscaler: null, files: {}, bundles: [], ...defaults }
  for (const id of ids) {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) throw new Error(`no preset ${id}`)
    const components: Bundle['components'] = []
    for (const c of preset.components) {
      // Shared files (the Qwen3-4B encoder) get the same bytes, so they dedupe as in real life.
      const bytes = new TextEncoder().encode(`fake ${c.file.repo}/${c.file.path}`)
      const hash = sha(bytes)
      const dir = c.role === 'upscaler' ? upscalersDir() : join(imageModelsDir(), c.file.repo.replace('/', '--'))
      const path = join(dir, c.file.path.split('/').at(-1)!)
      await mkdir(dir, { recursive: true })
      await Bun.write(path, bytes)
      registry.files[hash] = { size: bytes.byteLength, path, sources: [{ repo: c.file.repo, revision: c.file.revision, path: c.file.path }] }
      components.push({ role: c.role as Role, sha256: hash })
    }
    registry.bundles.push({
      id: preset.id,
      preset: preset.id,
      kind: preset.kind,
      title: preset.title,
      license: preset.license,
      components,
      defaults: preset.defaults,
      caps: preset.caps,
      align: preset.align,
      maxPixels: preset.maxPixels,
      addedAt: new Date().toISOString(),
    })
  }
  await saveImageRegistry(registry)
  return registry
}
