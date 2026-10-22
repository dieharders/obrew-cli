/**
 * Which stable-diffusion.cpp build this machine needs, and how to find it on a release.
 *
 * Image variants are their own list, not the text engine's `VARIANTS`: stable-diffusion.cpp
 * ships a ROCm build that llama.cpp's release (as obrew pins it) does not, and the text code
 * switches over its list exhaustively.
 *
 * Asset names are matched by PATTERN, because they embed the build runner's OS version and the
 * commit's short hash (`sd-master-a77d362-bin-Darwin-macOS-26.6.2-arm64.zip`). Each pattern must
 * match exactly one asset, so a renamed or duplicated asset is an error rather than a guess.
 * Published on master-987: Windows cpu / cuda12 (+ a separate CUDA runtime zip) / vulkan / rocm;
 * Linux x86_64 cpu / vulkan / rocm; one universal macOS zip with Metal. No Linux CUDA build and
 * nothing for arm64 Linux or Windows.
 */
import type { Arch, Platform } from '../../engine/variant'
import type { Hardware } from './hardware'

export const IMAGE_VARIANTS = ['cpu', 'cuda', 'vulkan', 'rocm', 'metal'] as const
export type ImageVariant = (typeof IMAGE_VARIANTS)[number]

const SD = String.raw`^sd-.+-bin-`

/** The release assets for (variant, platform, arch), in extraction order; null = not published. */
export function assetPatterns(variant: ImageVariant, platform: Platform, arch: Arch): RegExp[] | null {
  if (platform === 'darwin') {
    // One universal (arm64 + x86_64) build with Metal compiled in. `cpu` is the same binaries
    // run with `--backend cpu`.
    return variant === 'metal' || variant === 'cpu' ? [new RegExp(`${SD}Darwin-macOS-[\\d.]+-arm64\\.zip$`)] : null
  }
  if (arch !== 'x64') return null
  if (platform === 'win32') {
    switch (variant) {
      case 'cpu':
        return [new RegExp(`${SD}win-cpu-x64\\.zip$`)]
      case 'vulkan':
        return [new RegExp(`${SD}win-vulkan-x64\\.zip$`)]
      case 'cuda':
        return [new RegExp(`${SD}win-cuda12-x64\\.zip$`), /^cudart-sd-bin-win-cu12-x64\.zip$/]
      case 'rocm':
        return [new RegExp(`${SD}win-rocm-[\\d.]+-x64\\.zip$`)]
      case 'metal':
        return null
    }
  }
  switch (variant) {
    case 'cpu':
      return [new RegExp(`${SD}Linux-Ubuntu-[\\d.]+-x86_64\\.zip$`)]
    case 'vulkan':
      return [new RegExp(`${SD}Linux-Ubuntu-[\\d.]+-x86_64-vulkan\\.zip$`)]
    case 'rocm':
      return [new RegExp(`${SD}Linux-Ubuntu-[\\d.]+-x86_64-rocm-[\\d.]+\\.zip$`)]
    case 'cuda':
    case 'metal':
      return null
  }
}

/** The variants published for this platform, for "try one of these" messages. */
export const publishedVariants = (platform: Platform, arch: Arch): ImageVariant[] =>
  IMAGE_VARIANTS.filter((v) => assetPatterns(v, platform, arch) !== null)

/** `a.b` ≥ `c.d`, numerically per part ("12.10" > "12.8"). */
export function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return false
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** sd.cpp's Windows CUDA build is compiled with CUDA 12.8; the driver must support at least that. */
export const CUDA_MIN = '12.8'

/**
 * The default variant. CUDA on Windows NVIDIA when the driver can run it — the best-tested sd.cpp
 * backend, and Vulkan crashes on very large dispatches; Vulkan for AMD and Intel, and for Linux
 * NVIDIA (no CUDA build is published); Metal on macOS; the CPU when there is no GPU path. ROCm is
 * opt-in (`--variant rocm`): faster than Vulkan on RDNA3 in community tests, but 250+ MB and with
 * open model-specific bugs.
 */
export function detectImageVariant(hw: Hardware): ImageVariant {
  if (hw.platform === 'darwin') return 'metal'
  if (hw.arch !== 'x64') return 'cpu'
  if (hw.platform === 'win32') {
    if (hw.gpu.vendor === 'nvidia') return versionAtLeast(hw.gpu.cuda, CUDA_MIN) ? 'cuda' : 'vulkan'
    if (hw.gpu.vendor === 'amd' || hw.gpu.vendor === 'intel') return 'vulkan'
    return hw.vulkan && hw.gpu.vendor === 'unknown' ? 'vulkan' : 'cpu'
  }
  if (hw.gpu.vendor === 'none') return 'cpu'
  if (hw.vulkan) return 'vulkan'
  if (hw.gpu.vendor === 'amd' && hw.rocm) return 'rocm'
  return 'cpu'
}

/** A one-line reason a variant was (or should be) chosen, for setup logs. */
export function variantHint(hw: Hardware, variant: ImageVariant): string | null {
  if (hw.platform === 'win32' && hw.gpu.vendor === 'nvidia' && variant !== 'cuda' && !versionAtLeast(hw.gpu.cuda, CUDA_MIN)) {
    return `the NVIDIA driver supports CUDA ${hw.gpu.cuda ?? 'unknown'}; update it to one that supports CUDA ${CUDA_MIN} or later for the faster CUDA build (--variant cuda)`
  }
  if (hw.platform === 'linux' && hw.gpu.vendor !== 'none' && !hw.vulkan) {
    return 'no Vulkan loader found (libvulkan.so.1); install your distribution\'s Vulkan driver package for GPU acceleration'
  }
  return null
}
