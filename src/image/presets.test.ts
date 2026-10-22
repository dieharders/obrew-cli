/**
 * The curated presets as data — pinned to a commit, a hash and a size, permissively licensed,
 * consistent with their kind — and the helpers on top: which tier a memory budget gets, which
 * files a tier installs, and how many bytes that is.
 */
import { describe, expect, test } from 'bun:test'
import { GIB } from './engine/hardware'
import {
  DEFAULT_EDITOR,
  DEFAULT_GENERATOR,
  DEFAULT_UPSCALER,
  findPreset,
  PRESETS,
  presetBytes,
  presetFiles,
  ROLES,
  SMALL_TIER_BELOW,
  tierFor,
  type PinnedFile,
} from './presets'

const MIB = 1024 * 1024
const pinnedFiles = (): PinnedFile[] =>
  PRESETS.flatMap((p) => p.components.flatMap((c) => (c.small ? [c.file, c.small] : [c.file])))

describe('PRESETS', () => {
  test('ids are unique, and the three defaults are among them with the abilities their slot needs', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length)
    expect(findPreset(DEFAULT_GENERATOR)?.caps.generate).toBe(true)
    expect(findPreset(DEFAULT_EDITOR)?.caps).toMatchObject({ generate: true, edit: true })
    expect(findPreset(DEFAULT_EDITOR)!.caps.maxRefs).toBeGreaterThan(0)
    expect(findPreset(DEFAULT_UPSCALER)?.caps).toMatchObject({ upscale: true, scale: 4 })
  })

  test('every file is pinned: repo, a 40-hex commit, a path, a SHA-256 and a size', () => {
    for (const f of pinnedFiles()) {
      expect(f.repo).toMatch(/^[\w.-]+\/[\w.-]+$/)
      expect(f.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(f.path.length).toBeGreaterThan(0)
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Number.isInteger(f.size) && f.size > 0).toBe(true)
    }
  })

  test('permissively licensed, with a known role per component and no role twice', () => {
    for (const p of PRESETS) {
      expect(['Apache-2.0', 'BSD-3-Clause', 'MIT']).toContain(p.license)
      const roles = p.components.map((c) => c.role)
      for (const role of roles) expect(ROLES).toContain(role)
      expect(new Set(roles).size).toBe(roles.length)
    }
  })

  test('generators generate at multiples of 16; upscalers are one upscaler file', () => {
    for (const p of PRESETS) {
      if (p.kind === 'generator') {
        expect(p.caps).toMatchObject({ generate: true, upscale: false })
        expect(p.align).toBe(16)
        expect(p.maxPixels).toBeGreaterThanOrEqual(1024 * 1024)
        expect(p.defaults.steps).toBeGreaterThan(0)
      } else {
        expect(p.caps).toMatchObject({ generate: false, upscale: true })
        expect(p.components.map((c) => c.role)).toEqual(['upscaler'])
      }
    }
  })

  test('a small file is the same role from the same repo and commit, and smaller', () => {
    for (const c of PRESETS.flatMap((p) => p.components)) {
      if (!c.small) continue
      expect(c.small).toMatchObject({ repo: c.file.repo, revision: c.file.revision })
      expect(c.small.size).toBeLessThan(c.file.size)
      expect(c.small.sha256).not.toBe(c.file.sha256)
    }
  })

  test('Z-Image-Turbo and FLUX.2 klein share one Qwen3-4B file, so it is stored once', () => {
    const llm = (id: string) => findPreset(id)!.components.find((c) => c.role === 'llm')!.file
    expect(llm(DEFAULT_GENERATOR)).toEqual(llm(DEFAULT_EDITOR))
  })

  test('one hash is always the same pinned file', () => {
    const byHash = new Map<string, PinnedFile>()
    for (const f of pinnedFiles()) {
      const seen = byHash.get(f.sha256)
      if (seen) expect(f).toEqual(seen)
      else byHash.set(f.sha256, f)
    }
  })
})

describe('tierFor', () => {
  test('small below 7.5 GiB; an "8 GB" card (7.99 GiB) and an unknown budget get the default', () => {
    expect(SMALL_TIER_BELOW).toBe(7.5 * GIB)
    expect(tierFor(6 * GIB)).toBe('small')
    expect(tierFor(7.5 * GIB - 1)).toBe('small')
    expect(tierFor(7.5 * GIB)).toBe('default')
    expect(tierFor(8188 * MIB)).toBe('default')
    expect(tierFor(24 * GIB)).toBe('default')
    expect(tierFor(null)).toBe('default')
  })
})

describe('presetFiles and presetBytes', () => {
  const turbo = findPreset('z-image-turbo')!

  test('the small tier swaps in the small files and keeps the rest', () => {
    const def = presetFiles(turbo, 'default')
    const small = presetFiles(turbo, 'small')
    expect(def.map((f) => f.role)).toEqual(['diffusion', 'llm', 'vae'])
    expect(small.map((f) => f.role)).toEqual(['diffusion', 'llm', 'vae'])
    expect(small[0]!.file).toEqual(turbo.components[0]!.small!)
    expect(def[0]!.file).toEqual(turbo.components[0]!.file)
    expect(small.slice(1)).toEqual(def.slice(1))
  })

  test('a preset without small files is the same at either tier', () => {
    const upscaler = findPreset(DEFAULT_UPSCALER)!
    expect(presetFiles(upscaler, 'small')).toEqual(presetFiles(upscaler, 'default'))
  })

  test('bytes are the sum of the tier’s files', () => {
    expect(presetBytes(turbo, 'default')).toBe(4_542_547_904 + 2_497_281_312 + 335_304_388)
    expect(presetBytes(turbo, 'small')).toBe(3_864_250_304 + 2_497_281_312 + 335_304_388)
    for (const p of PRESETS) {
      for (const tier of ['default', 'small'] as const) {
        expect(presetBytes(p, tier)).toBe(presetFiles(p, tier).reduce((n, f) => n + f.file.size, 0))
      }
    }
  })
})

describe('findPreset', () => {
  test('by id only', () => {
    expect(findPreset('flux2-klein-4b')?.title).toBe('FLUX.2 [klein] 4B')
    expect(findPreset('FLUX.2 [klein] 4B')).toBeUndefined()
    expect(findPreset('nope')).toBeUndefined()
  })
})
