/**
 * Which stable-diffusion.cpp build a machine gets: the asset patterns against master-987's
 * recorded asset list (each pattern matches exactly one asset), the combinations nothing is
 * published for, the default variant per machine, the CUDA driver-version comparison, and the
 * setup hints.
 */
import { describe, expect, test } from 'bun:test'
import {
  fakeHardware,
  MASTER_987_ASSETS,
  type HardwareOverrides,
} from '../../../test/fixtures/image'
import type { Arch, Platform } from '../../engine/variant'
import { GIB } from './hardware'
import {
  assetPatterns,
  CUDA_MIN,
  detectImageVariant,
  IMAGE_VARIANTS,
  publishedVariants,
  variantHint,
  versionAtLeast,
  type ImageVariant,
} from './variant'

/** For each pattern of the combination, every recorded asset it matches. */
const hits = (variant: ImageVariant, platform: Platform, arch: Arch): string[][] | null =>
  assetPatterns(variant, platform, arch)?.map((p) =>
    MASTER_987_ASSETS.filter((name) => p.test(name)),
  ) ?? null

const DARWIN = 'sd-master-a77d362-bin-Darwin-macOS-26.6.2-arm64.zip'

describe('assetPatterns', () => {
  const published: Array<[ImageVariant, Platform, Arch, string[]]> = [
    ['cpu', 'win32', 'x64', ['sd-master-a77d362-bin-win-cpu-x64.zip']],
    ['vulkan', 'win32', 'x64', ['sd-master-a77d362-bin-win-vulkan-x64.zip']],
    [
      'cuda',
      'win32',
      'x64',
      ['sd-master-a77d362-bin-win-cuda12-x64.zip', 'cudart-sd-bin-win-cu12-x64.zip'],
    ],
    ['rocm', 'win32', 'x64', ['sd-master-a77d362-bin-win-rocm-10.1.0-x64.zip']],
    ['cpu', 'linux', 'x64', ['sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64.zip']],
    ['vulkan', 'linux', 'x64', ['sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip']],
    ['rocm', 'linux', 'x64', ['sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-rocm-10.1.0.zip']],
    // One universal macOS zip with Metal compiled in; `cpu` runs the same binaries.
    ['metal', 'darwin', 'arm64', [DARWIN]],
    ['cpu', 'darwin', 'arm64', [DARWIN]],
    ['metal', 'darwin', 'x64', [DARWIN]],
  ]

  test.each(published)(
    '%s on %s-%s: each pattern matches exactly one asset, in extraction order',
    (variant, platform, arch, expected) => {
      const found = hits(variant, platform, arch)!
      for (const names of found) expect(names).toHaveLength(1)
      expect(found.map((names) => names[0])).toEqual(expected)
    },
  )

  test('every recorded asset belongs to some variant', () => {
    const claimed = new Set(
      published.flatMap(([variant, platform, arch]) => hits(variant, platform, arch)!.flat()),
    )
    expect([...claimed].sort()).toEqual([...MASTER_987_ASSETS].sort())
  })

  test('a later build, with a new commit hash and newer runners, still matches', () => {
    const later = [
      'sd-master-1042-0f3c9e1-bin-Darwin-macOS-27.1-arm64.zip',
      'sd-master-1042-0f3c9e1-bin-Linux-Ubuntu-26.04-x86_64-rocm-11.0.zip',
      'sd-master-1042-0f3c9e1-bin-win-rocm-11.0-x64.zip',
    ]
    expect(assetPatterns('metal', 'darwin', 'arm64')![0]!.test(later[0]!)).toBe(true)
    expect(assetPatterns('rocm', 'linux', 'x64')![0]!.test(later[1]!)).toBe(true)
    expect(assetPatterns('rocm', 'win32', 'x64')![0]!.test(later[2]!)).toBe(true)
  })

  test('unpublished combinations are null, not a guess', () => {
    expect(assetPatterns('cuda', 'linux', 'x64')).toBeNull()
    expect(assetPatterns('metal', 'linux', 'x64')).toBeNull()
    expect(assetPatterns('metal', 'win32', 'x64')).toBeNull()
    for (const v of ['cuda', 'vulkan', 'rocm'] as const)
      expect(assetPatterns(v, 'darwin', 'arm64')).toBeNull()
    for (const v of IMAGE_VARIANTS) {
      expect(assetPatterns(v, 'linux', 'arm64')).toBeNull()
      expect(assetPatterns(v, 'win32', 'arm64')).toBeNull()
    }
  })
})

describe('publishedVariants', () => {
  test('what each platform can be offered', () => {
    expect(publishedVariants('win32', 'x64')).toEqual(['cpu', 'cuda', 'vulkan', 'rocm'])
    expect(publishedVariants('linux', 'x64')).toEqual(['cpu', 'vulkan', 'rocm'])
    expect(publishedVariants('darwin', 'arm64')).toEqual(['cpu', 'metal'])
    expect(publishedVariants('darwin', 'x64')).toEqual(['cpu', 'metal'])
    expect(publishedVariants('linux', 'arm64')).toEqual([])
    expect(publishedVariants('win32', 'arm64')).toEqual([])
  })
})

describe('detectImageVariant', () => {
  const win = (gpu: HardwareOverrides['gpu'], vulkan = true) =>
    fakeHardware({ platform: 'win32', glibc: null, vulkan, gpu })
  const linux = (over: HardwareOverrides) => fakeHardware({ platform: 'linux', ...over })
  const nvidia = (cuda: string | null) => ({
    vendor: 'nvidia' as const,
    name: 'NVIDIA GeForce RTX 4060',
    vramBytes: 8 * GIB,
    cuda,
  })
  const cases: Array<[string, ReturnType<typeof fakeHardware>, ImageVariant]> = [
    ['Windows NVIDIA, driver supports CUDA 12.6', win(nvidia('12.6')), 'vulkan'],
    ['Windows NVIDIA, CUDA 12.8', win(nvidia('12.8')), 'cuda'],
    ['Windows NVIDIA, CUDA 12.10', win(nvidia('12.10')), 'cuda'],
    ['Windows NVIDIA, CUDA 13.0', win(nvidia('13.0')), 'cuda'],
    ['Windows NVIDIA, CUDA version unknown', win(nvidia(null)), 'vulkan'],
    ['Windows AMD', win({ vendor: 'amd', vramBytes: 8 * GIB }), 'vulkan'],
    ['Windows Intel', win({ vendor: 'intel' }), 'vulkan'],
    ['Windows, an unnamed GPU with a Vulkan loader', win({ vendor: 'unknown' }), 'vulkan'],
    ['Windows, an unnamed GPU and no Vulkan', win({ vendor: 'unknown' }, false), 'cpu'],
    ['Windows, no GPU', win({ vendor: 'none' }, false), 'cpu'],
    [
      'Linux NVIDIA with Vulkan (no Linux CUDA build)',
      linux({ vulkan: true, gpu: nvidia('12.8') }),
      'vulkan',
    ],
    ['Linux NVIDIA without Vulkan', linux({ gpu: nvidia('12.8') }), 'cpu'],
    [
      'Linux AMD, no Vulkan, /dev/kfd',
      linux({ rocm: true, gpu: { vendor: 'amd', vramBytes: 16 * GIB } }),
      'rocm',
    ],
    [
      'Linux AMD with Vulkan and ROCm: ROCm stays opt-in',
      linux({ vulkan: true, rocm: true, gpu: { vendor: 'amd' } }),
      'vulkan',
    ],
    ['Linux AMD with neither', linux({ gpu: { vendor: 'amd' } }), 'cpu'],
    ['Linux, no GPU, even with a Vulkan loader', linux({ vulkan: true }), 'cpu'],
    ['Linux arm64', linux({ arch: 'arm64', vulkan: true, gpu: { vendor: 'unknown' } }), 'cpu'],
    [
      'macOS, Apple silicon',
      fakeHardware({
        platform: 'darwin',
        arch: 'arm64',
        chip: 'Apple M4',
        gpu: { vendor: 'apple' },
      }),
      'metal',
    ],
    [
      'macOS, Intel',
      fakeHardware({ platform: 'darwin', arch: 'x64', gpu: { vendor: 'unknown' } }),
      'metal',
    ],
  ]

  test.each(cases)('%s → %s', (_label, hw, variant) => {
    expect(detectImageVariant(hw)).toBe(variant)
  })

  test('the variant chosen is always one published for that machine, where any is', () => {
    for (const [, hw] of cases) {
      const published = publishedVariants(hw.platform, hw.arch)
      if (published.length) expect(published).toContain(detectImageVariant(hw))
    }
  })
})

describe('versionAtLeast', () => {
  test('compares numerically, part by part', () => {
    expect(versionAtLeast('12.10', '12.8')).toBe(true)
    expect(versionAtLeast('12.8', CUDA_MIN)).toBe(true)
    expect(versionAtLeast('12.8.1', '12.8')).toBe(true)
    expect(versionAtLeast('13.0', '12.8')).toBe(true)
    expect(versionAtLeast('12.6', '12.8')).toBe(false)
    expect(versionAtLeast('12', '12.8')).toBe(false)
    expect(versionAtLeast('11.99', '12.8')).toBe(false)
  })

  test('an unknown version is not enough', () => {
    expect(versionAtLeast(null, '12.8')).toBe(false)
    expect(versionAtLeast('', '12.8')).toBe(false)
  })
})

describe('variantHint', () => {
  test('Windows NVIDIA on a driver too old for the CUDA build says what to update', () => {
    const hw = fakeHardware({ platform: 'win32', gpu: { vendor: 'nvidia', cuda: '12.6' } })
    expect(variantHint(hw, 'vulkan')).toContain('CUDA 12.6')
    expect(variantHint(hw, 'vulkan')).toContain(`CUDA ${CUDA_MIN} or later`)
    expect(
      variantHint(
        fakeHardware({ platform: 'win32', gpu: { vendor: 'nvidia', cuda: null } }),
        'vulkan',
      ),
    ).toContain('CUDA unknown')
    expect(
      variantHint(
        fakeHardware({ platform: 'win32', gpu: { vendor: 'nvidia', cuda: '12.8' } }),
        'cuda',
      ),
    ).toBeNull()
  })

  test('a Linux GPU with no Vulkan loader says to install one', () => {
    expect(variantHint(fakeHardware({ gpu: { vendor: 'amd' } }), 'cpu')).toContain('libvulkan.so.1')
    expect(variantHint(fakeHardware({ vulkan: true, gpu: { vendor: 'amd' } }), 'vulkan')).toBeNull()
    expect(variantHint(fakeHardware(), 'cpu')).toBeNull()
  })

  test('nothing to say on macOS', () => {
    expect(
      variantHint(
        fakeHardware({ platform: 'darwin', arch: 'arm64', gpu: { vendor: 'apple' } }),
        'metal',
      ),
    ).toBeNull()
  })
})
