/**
 * Image-generation fixtures: a `Hardware` record that tests override field by field (a Linux x64
 * machine with no GPU unless told otherwise), and the assets stable-diffusion.cpp published on
 * master-987-a77d362, as recorded from the release page.
 */
import { GIB, type Hardware } from '../../src/image/engine/hardware'

export type HardwareOverrides = Partial<Omit<Hardware, 'gpu'>> & { gpu?: Partial<Hardware['gpu']> }

export function fakeHardware(over: HardwareOverrides = {}): Hardware {
  const { gpu, ...rest } = over
  return {
    platform: 'linux',
    arch: 'x64',
    ramBytes: 32 * GIB,
    vulkan: false,
    rocm: false,
    glibc: '2.39',
    chip: null,
    detectedAt: 0,
    ...rest,
    gpu: { vendor: 'none', name: null, vramBytes: null, driver: null, cuda: null, ...gpu },
  }
}

export const MASTER_987_ASSETS = [
  'cudart-sd-bin-win-cu12-x64.zip',
  'sd-master-a77d362-bin-Darwin-macOS-26.6.2-arm64.zip',
  'sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-rocm-10.1.0.zip',
  'sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
  'sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64.zip',
  'sd-master-a77d362-bin-win-cpu-x64.zip',
  'sd-master-a77d362-bin-win-cuda12-x64.zip',
  'sd-master-a77d362-bin-win-rocm-10.1.0-x64.zip',
  'sd-master-a77d362-bin-win-vulkan-x64.zip',
] as const
