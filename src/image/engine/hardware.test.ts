/**
 * The hardware probe's pure parts, fed recorded output: nvidia-smi's CSV and banner, a Windows
 * display-class registry dump, a fake /sys/class/drm tree, vendor naming and ranking, the memory
 * budget (with its OBREW_GPU_BUDGET_GIB override), and the base-Apple-chip test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeHardware } from '../../../test/fixtures/image'
import {
  GIB,
  isBaseAppleChip,
  linuxDrmGpus,
  memoryBudgetBytes,
  parseNvidiaSmi,
  parseRegAdapters,
  pickAdapter,
  vendorFromText,
  type GpuVendor,
} from './hardware'

const MIB = 1024 * 1024

/** `nvidia-smi` with no arguments on a Windows desktop with an RTX 4060 (driver 560.94). */
const SMI_BANNER = `Wed Oct 22 09:14:07 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 560.94                 Driver Version: 560.94         CUDA Version: 12.6     |
|-----------------------------------------+------------------------+----------------------+
| GPU  Name                  Driver-Model | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |               MIG M. |
|=========================================+========================+======================|
|   0  NVIDIA GeForce RTX 4060      WDDM  |   00000000:01:00.0  On |                  N/A |
|  0%   38C    P8             N/A /  115W |     812MiB /   8188MiB |      2%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+
`

describe('parseNvidiaSmi', () => {
  test('name, VRAM (MiB), driver, and the CUDA version from the banner', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 4060, 8188, 560.94\r\n', SMI_BANNER)).toEqual({
      name: 'NVIDIA GeForce RTX 4060',
      vramBytes: 8188 * MIB,
      driver: '560.94',
      cuda: '12.6',
    })
  })

  test('several GPUs: the first listed is the one engines pick', () => {
    const csv = '\nNVIDIA GeForce RTX 4090, 24564, 576.02\nNVIDIA GeForce RTX 3060, 12288, 576.02\n'
    expect(parseNvidiaSmi(csv)).toMatchObject({
      name: 'NVIDIA GeForce RTX 4090',
      vramBytes: 24564 * MIB,
    })
  })

  test('no banner: the CUDA version is unknown', () => {
    expect(parseNvidiaSmi('Tesla T4, 15360, 535.183.01')?.cuda).toBeNull()
  })

  test('memory nvidia-smi could not read is unknown, not zero; a missing driver is null', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce GTX 1650, [N/A], 551.86')).toMatchObject({
      vramBytes: null,
      driver: '551.86',
    })
    expect(parseNvidiaSmi('NVIDIA GeForce GTX 1650, 0')).toMatchObject({
      vramBytes: null,
      driver: null,
    })
  })

  test('empty or blank output is no GPU', () => {
    expect(parseNvidiaSmi('')).toBeNull()
    expect(parseNvidiaSmi('', SMI_BANNER)).toBeNull()
    expect(parseNvidiaSmi('\r\n   \r\n')).toBeNull()
  })
})

const CLASS = String.raw`HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`
const AMD_QWORD = '    HardwareInformation.qwMemorySize    REG_QWORD    0x200000000'

/**
 * `reg query "<CLASS>" /s` on a desktop with an AMD Radeon RX 6600 and the CPU's Intel UHD
 * Graphics 770, as reg.exe prints it (CRLF, four-space columns). The AMD key keeps its 8 GiB in
 * the QWORD; its 32-bit `MemorySize` is a useless binary zero. The Intel key has only the DWORD.
 * `amdSizeUnder` moves the AMD's QWORD into its `\0000\Settings` subkey.
 */
function regDump(amdSizeUnder: 'adapter' | 'settings' = 'adapter'): string {
  return [
    '',
    CLASS,
    '    Class    REG_SZ    Display',
    String.raw`    ClassDesc    REG_SZ    @%SystemRoot%\System32\drivers\dxgkrnl.sys,-2001`,
    String.raw`    IconPath    REG_MULTI_SZ    %SystemRoot%\System32\setupapi.dll,-2\0%SystemRoot%\system32\display.dll,-1`,
    '',
    String.raw`${CLASS}\0000`,
    '    DriverDesc    REG_SZ    AMD Radeon RX 6600',
    '    ProviderName    REG_SZ    Advanced Micro Devices, Inc.',
    '    DriverVersion    REG_SZ    32.0.12011.1036',
    '    DriverDate    REG_SZ    8-13-2024',
    String.raw`    MatchingDeviceId    REG_SZ    pci\ven_1002&dev_73ff`,
    '    HardwareInformation.AdapterString    REG_BINARY    41004D004400200052006100640065006F006E00200052005800200036003600300030000000',
    '    HardwareInformation.MemorySize    REG_BINARY    00000000',
    ...(amdSizeUnder === 'adapter' ? [AMD_QWORD] : []),
    '',
    String.raw`${CLASS}\0000\Settings`,
    '    Device Description    REG_SZ    AMD Radeon RX 6600',
    '    DalRuntimeMode    REG_DWORD    0x1',
    ...(amdSizeUnder === 'settings' ? [AMD_QWORD] : []),
    '',
    String.raw`${CLASS}\0001`,
    '    DriverDesc    REG_SZ    Intel(R) UHD Graphics 770',
    '    ProviderName    REG_SZ    Intel Corporation',
    '    DriverVersion    REG_SZ    31.0.101.5333',
    '    HardwareInformation.AdapterString    REG_BINARY    49006E00740065006C00280052002900200055004800440020004700720061007000680069006300730020003700370030000000',
    '    HardwareInformation.MemorySize    REG_DWORD    0x80000000',
    '',
    String.raw`${CLASS}\Properties`,
    '',
  ].join('\r\n')
}

const AMD = {
  desc: 'AMD Radeon RX 6600',
  provider: 'Advanced Micro Devices, Inc.',
  vramBytes: 8 * GIB,
}
const INTEL = {
  desc: 'Intel(R) UHD Graphics 770',
  provider: 'Intel Corporation',
  vramBytes: 2 * GIB,
}

describe('parseRegAdapters', () => {
  test('a recorded dump: one entry per adapter key, the QWORD size, the DWORD when that is all there is', () => {
    expect(parseRegAdapters(regDump())).toEqual([AMD, INTEL])
  })

  test('values under `\\0000\\Settings` belong to adapter 0000: no third adapter, nothing lost', () => {
    expect(parseRegAdapters(regDump('settings'))).toEqual([AMD, INTEL])
  })

  test('the QWORD wins over the 32-bit size, whichever comes first', () => {
    const dump = (lines: string[]) =>
      [`${CLASS}\\0000`, '    DriverDesc    REG_SZ    AMD Radeon RX 7800 XT', ...lines].join('\n')
    const dword = '    HardwareInformation.MemorySize    REG_DWORD    0xffffffff'
    const qword = '    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000'
    expect(parseRegAdapters(dump([dword, qword]))[0]?.vramBytes).toBe(16 * GIB)
    expect(parseRegAdapters(dump([qword, dword]))[0]?.vramBytes).toBe(16 * GIB)
  })

  test('nothing to report: empty output, or keys with neither a description nor a provider', () => {
    expect(parseRegAdapters('')).toEqual([])
    expect(
      parseRegAdapters(
        [
          CLASS,
          '    Class    REG_SZ    Display',
          `${CLASS}\\0002`,
          '    InfPath    REG_SZ    oem12.inf',
        ].join('\r\n'),
      ),
    ).toEqual([])
  })
})

describe('vendorFromText', () => {
  test.each([
    ['NVIDIA GeForce RTX 4060', 'nvidia'],
    ['Quadro P2000', 'nvidia'],
    ['NVIDIA Corporation Tesla T4', 'nvidia'],
    ['Advanced Micro Devices, Inc. AMD Radeon RX 6600', 'amd'],
    ['AMD Radeon(TM) Graphics', 'amd'],
    ['ATI Technologies Inc. Radeon HD 5450', 'amd'],
    ['Intel Corporation Intel(R) UHD Graphics 770', 'intel'],
    ['Intel(R) Arc(TM) A770 Graphics', 'intel'],
    ['Microsoft Microsoft Basic Display Adapter', 'unknown'],
    ['', 'unknown'],
  ] as Array<[string, GpuVendor]>)('%p → %s', (text, vendor) => {
    expect(vendorFromText(text)).toBe(vendor)
  })
})

describe('pickAdapter', () => {
  const card = (vendor: GpuVendor, gib: number | null) => ({
    vendor,
    vramBytes: gib === null ? null : gib * GIB,
  })

  test('a discrete NVIDIA or AMD card beats the Intel iGPU beside it, wherever it is listed', () => {
    expect(pickAdapter([card('intel', 2), card('amd', 8)])).toEqual(card('amd', 8))
    expect(pickAdapter([card('amd', 16), card('nvidia', 6)])).toEqual(card('nvidia', 6))
    expect(pickAdapter([card('unknown', 32), card('intel', null)])).toEqual(card('intel', null))
  })

  test('the same vendor twice: the one with more VRAM, unknown VRAM counting as none', () => {
    expect(pickAdapter([card('amd', 4), card('amd', null), card('amd', 16)])).toEqual(
      card('amd', 16),
    )
  })

  test('nothing to pick is null, and the list is left as it was', () => {
    expect(pickAdapter([])).toBeNull()
    const list = [card('intel', 1), card('nvidia', 8)]
    pickAdapter(list)
    expect(list.map((c) => c.vendor)).toEqual(['intel', 'nvidia'])
  })
})

describe('linuxDrmGpus', () => {
  let root: string
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'obrew-drm-')))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  async function card(
    name: string,
    files: Record<string, string>,
    base = join(root, 'class', 'drm'),
  ) {
    await mkdir(join(base, name, 'device'), { recursive: true })
    for (const [file, text] of Object.entries(files))
      await writeFile(join(base, name, 'device', file), text)
  }

  test('reads each cardN: PCI vendor id, and the VRAM amdgpu exposes', async () => {
    const drm = join(root, 'class', 'drm')
    await card('card1', { vendor: '0x1002\n', mem_info_vram_total: '8573157376\n' })
    await card('card2', { vendor: '0x1af4\n' }) // virtio-gpu
    await card('card3', { vendor: '0x10de\n', mem_info_vram_total: '0\n' })
    // As in sysfs, a card can be a symlink into the device tree.
    const intel = join(root, 'devices', 'pci0000_00', '0000_00_02.0', 'drm')
    await card('card0', { vendor: '0x8086\n' }, intel)
    if (process.platform === 'win32') await card('card0', { vendor: '0x8086\n' })
    else await symlink(join(intel, 'card0'), join(drm, 'card0'))
    // Not cards: connectors, render nodes, a card without a readable vendor, a plain file.
    await mkdir(join(drm, 'card1-DP-1'), { recursive: true })
    await mkdir(join(drm, 'card0-HDMI-A-1'), { recursive: true })
    await mkdir(join(drm, 'renderD128'), { recursive: true })
    await mkdir(join(drm, 'card4', 'device'), { recursive: true })
    await writeFile(join(drm, 'version'), 'drm 1.1.0 20060810\n')

    const gpus = linuxDrmGpus(drm).sort((a, b) => a.vendor.localeCompare(b.vendor))
    expect(gpus).toEqual([
      { vendor: 'amd', vramBytes: 8573157376 },
      { vendor: 'intel', vramBytes: null },
      { vendor: 'nvidia', vramBytes: null },
      { vendor: 'unknown', vramBytes: null },
    ])
    expect(pickAdapter(gpus)).toEqual({ vendor: 'nvidia', vramBytes: null })
  })

  test('no such directory: no GPUs', () => {
    expect(linuxDrmGpus(join(root, 'missing'))).toEqual([])
  })
})

describe('memoryBudgetBytes', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.OBREW_GPU_BUDGET_GIB
    delete process.env.OBREW_GPU_BUDGET_GIB
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.OBREW_GPU_BUDGET_GIB
    else process.env.OBREW_GPU_BUDGET_GIB = saved
  })

  test('Apple: 65% of RAM, which the GPU shares with everything else', () => {
    const mac = fakeHardware({
      platform: 'darwin',
      arch: 'arm64',
      ramBytes: 16 * GIB,
      gpu: { vendor: 'apple', name: 'Apple M4' },
    })
    expect(memoryBudgetBytes(mac)).toBe(Math.floor(16 * GIB * 0.65))
  })

  test('NVIDIA and AMD: the VRAM of the card', () => {
    expect(
      memoryBudgetBytes(fakeHardware({ gpu: { vendor: 'nvidia', vramBytes: 8188 * MIB } })),
    ).toBe(8188 * MIB)
    expect(memoryBudgetBytes(fakeHardware({ gpu: { vendor: 'amd', vramBytes: 8 * GIB } }))).toBe(
      8 * GIB,
    )
  })

  test('unknown: VRAM nobody reported, an Intel iGPU, no GPU at all', () => {
    expect(
      memoryBudgetBytes(fakeHardware({ gpu: { vendor: 'nvidia', vramBytes: null } })),
    ).toBeNull()
    expect(
      memoryBudgetBytes(fakeHardware({ gpu: { vendor: 'intel', vramBytes: 2 * GIB } })),
    ).toBeNull()
    expect(memoryBudgetBytes(fakeHardware({ gpu: { vendor: 'unknown' } }))).toBeNull()
    expect(memoryBudgetBytes(fakeHardware())).toBeNull()
  })

  test('OBREW_GPU_BUDGET_GIB overrides whatever was detected, fractions included', () => {
    process.env.OBREW_GPU_BUDGET_GIB = '6'
    expect(memoryBudgetBytes(fakeHardware())).toBe(6 * GIB)
    process.env.OBREW_GPU_BUDGET_GIB = '7.5'
    expect(
      memoryBudgetBytes(fakeHardware({ gpu: { vendor: 'nvidia', vramBytes: 24 * GIB } })),
    ).toBe(7.5 * GIB)
  })

  test('an override that is not a positive number is ignored', () => {
    const card = fakeHardware({ gpu: { vendor: 'amd', vramBytes: 8 * GIB } })
    for (const value of ['', '0', '-4', 'lots', 'Infinity']) {
      process.env.OBREW_GPU_BUDGET_GIB = value
      expect(memoryBudgetBytes(card)).toBe(8 * GIB)
    }
  })
})

describe('isBaseAppleChip', () => {
  const mac = (chip: string | null) =>
    fakeHardware({ platform: 'darwin', arch: 'arm64', chip, gpu: { vendor: 'apple', name: chip } })

  test('the base chips', () => {
    expect(isBaseAppleChip(mac('Apple M4'))).toBe(true)
    expect(isBaseAppleChip(mac('Apple M1'))).toBe(true)
    expect(isBaseAppleChip(mac('Apple M10'))).toBe(true)
  })

  test('not Pro, Max or Ultra, nor anything that is not Apple silicon', () => {
    for (const chip of ['Apple M4 Pro', 'Apple M4 Max', 'Apple M2 Ultra', null])
      expect(isBaseAppleChip(mac(chip))).toBe(false)
    const intelMac = fakeHardware({
      platform: 'darwin',
      chip: 'Apple M4',
      gpu: { vendor: 'unknown' },
    })
    expect(isBaseAppleChip(intelMac)).toBe(false)
  })
})
