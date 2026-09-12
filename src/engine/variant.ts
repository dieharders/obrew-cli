/**
 * Which llama.cpp build this machine needs.
 *
 * The release publishes one archive per (platform, arch, backend). The names below are the
 * ones present on the pinned tag; `install.ts` still matches them against the release's
 * asset list at install time, so a renamed asset is reported rather than 404'd.
 *
 * Detection is deliberately minimal (the owner cut the hardware audit): an NVIDIA driver on
 * Windows means the CUDA build, Apple means Metal, everything else is CPU unless the user
 * passes `--variant vulkan` (AMD / Intel GPUs). Linux CUDA builds are not published on the
 * release page, so Linux defaults to CPU as well.
 */
import type { Variant } from '../shared/config'

export type Platform = 'win32' | 'darwin' | 'linux'
export type Arch = 'x64' | 'arm64'

export const hostPlatform = (): Platform => {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform
  }
  throw new Error(`unsupported platform ${process.platform}`)
}

export const hostArch = (): Arch => (process.arch === 'arm64' ? 'arm64' : 'x64')

/** `nvidia-smi` ships with the driver; on Windows it lives in System32 even off PATH. */
export function hasNvidiaDriver(): boolean {
  if (Bun.which('nvidia-smi')) return true
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    try {
      return Bun.spawnSync([`${root}\\System32\\nvidia-smi.exe`, '-L'], { stderr: 'ignore' }).exitCode === 0
    } catch {
      return false
    }
  }
  return false
}

export function detectVariant(platform: Platform = hostPlatform()): Variant {
  if (platform === 'darwin') return 'metal'
  if (platform === 'win32' && hasNvidiaDriver()) return 'cuda'
  return 'cpu'
}

/**
 * Release asset names for a (tag, variant, platform, arch), in download order. `null` means
 * the combination is not published. CUDA on Windows needs the runtime DLLs as a second
 * archive, extracted into the same directory.
 */
export function assetNames(
  tag: string,
  variant: Variant,
  platform: Platform,
  arch: Arch,
): string[] | null {
  const bin = (suffix: string) => `llama-${tag}-bin-${suffix}`
  if (platform === 'win32') {
    if (arch === 'arm64') return variant === 'cpu' ? [bin('win-cpu-arm64.zip')] : null
    switch (variant) {
      case 'cuda':
        return [bin('win-cuda-12.4-x64.zip'), 'cudart-llama-bin-win-cuda-12.4-x64.zip']
      case 'cpu':
        return [bin('win-cpu-x64.zip')]
      case 'vulkan':
        return [bin('win-vulkan-x64.zip')]
      case 'metal':
        return null
    }
  }
  if (platform === 'darwin') {
    if (variant === 'cuda' || variant === 'vulkan') return null
    return [bin(arch === 'arm64' ? 'macos-arm64.tar.gz' : 'macos-x64.tar.gz')]
  }
  // linux
  switch (variant) {
    case 'cpu':
      return [bin(`ubuntu-${arch}.tar.gz`)]
    case 'vulkan':
      return [bin(`ubuntu-vulkan-${arch}.tar.gz`)]
    case 'cuda':
    case 'metal':
      return null
  }
}
