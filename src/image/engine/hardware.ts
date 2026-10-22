/**
 * What GPU this machine has, and how much memory image generation may plan for.
 *
 * The text engine's detection is deliberately minimal (an NVIDIA driver on Windows means CUDA,
 * everything else CPU). Images cannot afford that: a 6B diffusion model on the CPU takes minutes
 * per step, and the right memory flags depend on how much VRAM there is. So this probes a little
 * more, once, and caches the answer for a day in `<data>/image/hardware.json`:
 *
 *   NVIDIA   `nvidia-smi` — name, total VRAM, driver, and the CUDA version the driver supports
 *            (sd.cpp's Windows CUDA build is CUDA 12.8, which an older driver cannot run)
 *   Windows  the display-adapter class key in the registry for AMD and Intel. Its
 *            `HardwareInformation.qwMemorySize` is a QWORD; WMI's `AdapterRAM` is a uint32 and
 *            reports every card above 4 GB as 4 GB.
 *   Linux    `/sys/class/drm/card*` vendor ids, `mem_info_vram_total` (AMD), the Vulkan loader,
 *            `/dev/kfd` (ROCm), and the glibc version (sd.cpp's Linux builds target Ubuntu 24.04)
 *   macOS    the chip name and RAM; Apple GPUs share it, so the budget is a fraction of RAM
 *
 * The parsers are exported and pure so tests can feed them recorded output.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { hasNvidiaDriver, hostArch, hostPlatform } from '../../engine/variant'
import { hardwarePath } from '../paths'

export const GPU_VENDORS = ['nvidia', 'amd', 'intel', 'apple', 'none', 'unknown'] as const
export type GpuVendor = (typeof GPU_VENDORS)[number]

export const HardwareSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  gpu: z.object({
    vendor: z.enum(GPU_VENDORS),
    name: z.string().nullable(),
    vramBytes: z.number().nullable(),
    driver: z.string().nullable(),
    /** The highest CUDA version the NVIDIA driver supports, e.g. "12.6". */
    cuda: z.string().nullable(),
  }),
  ramBytes: z.number(),
  /** A Vulkan loader is installed (vulkan-1.dll / libvulkan.so.1). */
  vulkan: z.boolean(),
  /** Linux `/dev/kfd`: the ROCm kernel driver is present. */
  rocm: z.boolean(),
  glibc: z.string().nullable(),
  /** macOS: `machdep.cpu.brand_string`, e.g. "Apple M4 Pro". */
  chip: z.string().nullable(),
  detectedAt: z.number(),
})
export type Hardware = z.infer<typeof HardwareSchema>

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const CACHE_MS = 24 * 60 * 60_000

export function vendorFromText(text: string): GpuVendor {
  if (/nvidia|geforce|quadro|tesla|\brtx\b/i.test(text)) return 'nvidia'
  if (/\bamd\b|radeon|advanced micro devices|\bati\b/i.test(text)) return 'amd'
  if (/intel/i.test(text)) return 'intel'
  return 'unknown'
}

/**
 * `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits` gives
 * one CSV line per GPU (memory in MiB); the plain `nvidia-smi` banner carries "CUDA Version".
 * The first GPU is the one engines pick by default.
 */
export function parseNvidiaSmi(csv: string, banner = ''): { name: string; vramBytes: number | null; driver: string | null; cuda: string | null } | null {
  const line = csv.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  if (!line) return null
  const [name, mem, driver] = line.split(',').map((s) => s.trim())
  if (!name) return null
  const mib = Number(mem)
  const cuda = banner.match(/CUDA Version:\s*([\d.]+)/)?.[1] ?? null
  return { name, vramBytes: Number.isFinite(mib) && mib > 0 ? mib * MIB : null, driver: driver || null, cuda }
}

export interface RegAdapter {
  desc: string | null
  provider: string | null
  vramBytes: number | null
}

/**
 * `reg query "HKLM\…\Class\{4d36e968-e325-11ce-bfc1-08002be10318}" /s` → one entry per adapter
 * key (`…\0000`, `…\0001`). Subkeys such as `…\0000\Settings` belong to the adapter above them.
 */
export function parseRegAdapters(output: string): RegAdapter[] {
  const adapters: RegAdapter[] = []
  let current: RegAdapter | null = null
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^HKEY_/i.test(line)) {
      if (/\\\d{4}$/.test(line)) {
        current = { desc: null, provider: null, vramBytes: null }
        adapters.push(current)
      } else if (!/\\\d{4}\\/.test(line)) {
        current = null
      }
      continue
    }
    if (!current) continue
    const m = line.trim().match(/^(\S[^\t]*?)\s{2,}(REG_\w+)\s{2,}(.*)$/) ?? line.trim().match(/^(\S+)\s+(REG_\w+)\s+(.*)$/)
    if (!m) continue
    const [, name, type, value] = m
    if (name === 'DriverDesc') current.desc = value!.trim()
    else if (name === 'ProviderName') current.provider = value!.trim()
    else if (name === 'HardwareInformation.qwMemorySize') {
      const n = type === 'REG_QWORD' || /^0x/i.test(value!) ? Number(BigInt(value!.trim())) : Number(value)
      if (Number.isFinite(n) && n > 0) current.vramBytes = n
    } else if (name === 'HardwareInformation.MemorySize' && current.vramBytes === null) {
      // The older DWORD (or binary) value, kept only when no QWORD is present.
      const n = /^0x/i.test(value!.trim()) ? Number(value!.trim()) : NaN
      if (Number.isFinite(n) && n > 0) current.vramBytes = n
    }
  }
  return adapters.filter((a) => a.desc || a.provider)
}

/** Most capable first: a discrete NVIDIA or AMD card beats an Intel iGPU beside it. */
export function pickAdapter<T extends { vendor: GpuVendor; vramBytes: number | null }>(list: T[]): T | null {
  const rank = (v: GpuVendor) => ({ nvidia: 0, amd: 1, intel: 2, apple: 3, unknown: 4, none: 5 })[v]
  return [...list].sort((a, b) => rank(a.vendor) - rank(b.vendor) || (b.vramBytes ?? 0) - (a.vramBytes ?? 0))[0] ?? null
}

const PCI_VENDORS: Record<string, GpuVendor> = { '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel' }

/** `/sys/class/drm/cardN/device/vendor` → the GPUs Linux knows about. `root` exists for tests. */
export function linuxDrmGpus(root = '/sys/class/drm'): Array<{ vendor: GpuVendor; vramBytes: number | null }> {
  let cards: string[]
  try {
    cards = readdirSync(root).filter((n) => /^card\d+$/.test(n))
  } catch {
    return []
  }
  const out: Array<{ vendor: GpuVendor; vramBytes: number | null }> = []
  for (const card of cards) {
    try {
      const id = readFileSync(join(root, card, 'device', 'vendor'), 'utf8').trim().toLowerCase()
      const vendor = PCI_VENDORS[id] ?? 'unknown'
      let vramBytes: number | null = null
      try {
        const n = Number(readFileSync(join(root, card, 'device', 'mem_info_vram_total'), 'utf8').trim())
        if (Number.isFinite(n) && n > 0) vramBytes = n
      } catch {
        // Only amdgpu exposes it.
      }
      out.push({ vendor, vramBytes })
    } catch {
      // A card without a readable vendor (virtual display): skip it.
    }
  }
  return out
}

/**
 * A command's stdout, or null. `keepOnError`: the output stands even with a non-zero exit —
 * `reg query … /s` exits 1 when one protected subkey (`…\\Properties`) denies access, after
 * printing every adapter it could read.
 */
function run(argv: string[], timeoutMs = 5000, keepOnError = false): string | null {
  try {
    const proc = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs, windowsHide: true } as Parameters<typeof Bun.spawnSync>[1])
    const out = proc.stdout.toString()
    return proc.exitCode === 0 || (keepOnError && out.trim()) ? out : null
  } catch {
    return null
  }
}

function nvidiaSmiPath(): string | null {
  const onPath = Bun.which('nvidia-smi')
  if (onPath) return onPath
  if (process.platform === 'win32') {
    const sys = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\nvidia-smi.exe`
    if (existsSync(sys)) return sys
  }
  return null
}

function probeNvidia(): ReturnType<typeof parseNvidiaSmi> {
  if (!hasNvidiaDriver()) return null
  const smi = nvidiaSmiPath()
  if (!smi) return null
  const csv = run([smi, '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])
  return csv ? parseNvidiaSmi(csv, run([smi]) ?? '') : null
}

const LINUX_VULKAN = ['/usr/lib/x86_64-linux-gnu/libvulkan.so.1', '/usr/lib64/libvulkan.so.1', '/usr/lib/libvulkan.so.1', '/usr/lib/aarch64-linux-gnu/libvulkan.so.1']

function linuxHasVulkan(): boolean {
  if (LINUX_VULKAN.some((p) => existsSync(p))) return true
  return /libvulkan\.so\.1/.test(run(['ldconfig', '-p']) ?? '')
}

export function probeHardware(): Hardware {
  const platform = hostPlatform()
  const arch = hostArch()
  const ramBytes = totalmem()
  const base: Hardware = {
    platform,
    arch,
    gpu: { vendor: 'none', name: null, vramBytes: null, driver: null, cuda: null },
    ramBytes,
    vulkan: false,
    rocm: false,
    glibc: null,
    chip: null,
    detectedAt: Date.now(),
  }

  if (platform === 'darwin') {
    const chip = run(['sysctl', '-n', 'machdep.cpu.brand_string'])?.trim() || null
    const apple = arch === 'arm64' || /apple/i.test(chip ?? '')
    return { ...base, chip, vulkan: false, gpu: { ...base.gpu, vendor: apple ? 'apple' : 'unknown', name: chip } }
  }

  const nvidia = probeNvidia()
  if (platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    const vulkan = existsSync(`${root}\\System32\\vulkan-1.dll`)
    if (nvidia) return { ...base, vulkan, gpu: { vendor: 'nvidia', ...nvidia } }
    const reg = run(['reg', 'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}', '/s'], 8000, true)
    const adapters = parseRegAdapters(reg ?? '').map((a) => ({ ...a, vendor: vendorFromText(`${a.provider ?? ''} ${a.desc ?? ''}`) }))
    const best = pickAdapter(adapters.filter((a) => a.vendor !== 'unknown'))
    if (!best) return { ...base, vulkan, gpu: { ...base.gpu, vendor: vulkan ? 'unknown' : 'none' } }
    return { ...base, vulkan, gpu: { vendor: best.vendor, name: best.desc, vramBytes: best.vramBytes, driver: null, cuda: null } }
  }

  // linux
  const glibc = run(['getconf', 'GNU_LIBC_VERSION'])?.trim().replace(/^glibc\s*/i, '') || null
  const vulkan = linuxHasVulkan()
  const rocm = existsSync('/dev/kfd')
  if (nvidia) return { ...base, glibc, vulkan, rocm, gpu: { vendor: 'nvidia', ...nvidia } }
  const best = pickAdapter(linuxDrmGpus())
  if (!best) return { ...base, glibc, vulkan, rocm }
  return { ...base, glibc, vulkan, rocm, gpu: { vendor: best.vendor, name: null, vramBytes: best.vramBytes, driver: null, cuda: null } }
}

/** The probe, cached for a day: it spawns nvidia-smi / reg, which a hot path should not pay. */
export async function detectHardware(opts: { refresh?: boolean } = {}): Promise<Hardware> {
  const path = hardwarePath()
  if (!opts.refresh) {
    try {
      const parsed = HardwareSchema.safeParse(await Bun.file(path).json())
      if (parsed.success && Date.now() - parsed.data.detectedAt < CACHE_MS) return parsed.data
    } catch {
      // No cache yet.
    }
  }
  const hw = probeHardware()
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(hw, null, 2) + '\n')
  return hw
}

/** The cached probe without probing: for readers that must not spawn anything (auth status). */
export async function cachedHardware(): Promise<Hardware | null> {
  try {
    const parsed = HardwareSchema.safeParse(await Bun.file(hardwarePath()).json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * How many bytes of accelerator memory image generation may plan around, or null when unknown.
 * Apple GPUs share RAM with everything else (the OS, the text engine), so about two thirds of
 * it. `OBREW_GPU_BUDGET_GIB` overrides the answer, for tests and for users who know better.
 */
export function memoryBudgetBytes(hw: Hardware): number | null {
  const override = Number(process.env.OBREW_GPU_BUDGET_GIB)
  if (process.env.OBREW_GPU_BUDGET_GIB && Number.isFinite(override) && override > 0) return override * GIB
  if (hw.gpu.vendor === 'apple') return Math.floor(hw.ramBytes * 0.65)
  if ((hw.gpu.vendor === 'nvidia' || hw.gpu.vendor === 'amd') && hw.gpu.vramBytes) return hw.gpu.vramBytes
  return null
}

/**
 * A base Apple chip ("Apple M4", not "… Pro" / "Max" / "Ultra"): its GPU has a fraction of the
 * cores, and measured on an M4 a 1280×720 Z-Image-Turbo image took 214 s where FLUX.2 klein took
 * 82 s, so setup makes klein the default generator there.
 */
export const isBaseAppleChip = (hw: Hardware): boolean => hw.gpu.vendor === 'apple' && /^Apple M\d+$/i.test(hw.chip ?? '')

export const toGiB = (bytes: number) => bytes / GIB
export { GIB }
