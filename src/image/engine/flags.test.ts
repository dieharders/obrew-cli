/**
 * sd-server's launch plan for a hand-built engine record and bundle: the memory flags from the
 * footprint against the budget (offload and --max-vram over it, neither under it, offload when it
 * is unknown), the per-variant flags (Vulkan VAE tiling, Metal batched CFG, the CPU backend), -c
 * overrides, flags the build lacks, the reuse key, and the environment (M5's Metal tensor switch,
 * LD_LIBRARY_PATH on Linux).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fakeHardware } from '../../../test/fixtures/image'
import { modelRootDir, upscalersDir } from '../paths'
import type { Bundle, ResolvedBundle } from '../registry'
import { footprintBytes, metalTensorBroken, serverPlan, type ServerPlanInput } from './flags'
import { GIB } from './hardware'
import type { ImageEngineRecord } from './install'

const MIB = 1024 * 1024

const engine = (over: Partial<ImageEngineRecord> = {}): ImageEngineRecord => ({
  tag: 'master-987-a77d362',
  variant: 'cuda',
  server: '/opt/obrew/image/engines/master-987-a77d362-cuda/sd-server',
  cli: '/opt/obrew/image/engines/master-987-a77d362-cuda/sd-cli',
  binDir: '/opt/obrew/image/engines/master-987-a77d362-cuda',
  flags: [],
  devices: ['CUDA0', 'CPU'],
  installedAt: '2026-10-22T00:00:00.000Z',
  ...over,
})

const TURBO: Bundle = {
  id: 'z-image-turbo',
  preset: 'z-image-turbo',
  kind: 'generator',
  title: 'Z-Image-Turbo',
  license: 'Apache-2.0',
  components: [
    { role: 'diffusion', sha256: 'a'.repeat(64) },
    { role: 'llm', sha256: 'b'.repeat(64) },
    { role: 'vae', sha256: 'c'.repeat(64) },
  ],
  defaults: { steps: 8, cfg: 1 },
  caps: { generate: true, img2img: true, edit: false, upscale: false, maxRefs: 0 },
  align: 16,
  maxPixels: 2_200_000,
  addedAt: '2026-10-22T00:00:00.000Z',
}

/** Z-Image-Turbo's default tier: 4.54 + 2.50 + 0.34 GB, so a footprint of about 9.06 GiB. */
const resolved = (over: Partial<ResolvedBundle> = {}): ResolvedBundle => ({
  bundle: TURBO,
  paths: {
    diffusion: '/m/z_image_turbo-Q5_0.gguf',
    llm: '/m/Qwen3-4B-Q4_K_M.gguf',
    vae: '/m/ae.safetensors',
  },
  hashes: { diffusion: 'a'.repeat(64), llm: 'b'.repeat(64), vae: 'c'.repeat(64) },
  bytes: 4_542_547_904 + 2_497_281_312 + 335_304_388,
  ...over,
})

/** An "8 GB" card, which reports 8188 MiB (7.996 GiB). */
const RTX_4060 = fakeHardware({
  platform: 'win32',
  gpu: { vendor: 'nvidia', vramBytes: 8188 * MIB, cuda: '12.8' },
})
const RTX_4090 = fakeHardware({
  platform: 'win32',
  gpu: { vendor: 'nvidia', vramBytes: 24 * GIB, cuda: '12.8' },
})
const NO_VRAM = fakeHardware({
  platform: 'win32',
  gpu: { vendor: 'nvidia', vramBytes: null, cuda: '12.8' },
})
const RX_7900 = fakeHardware({ vulkan: true, gpu: { vendor: 'amd', vramBytes: 24 * GIB } })
const mac = (chip: string, ramGiB = 16) =>
  fakeHardware({
    platform: 'darwin',
    arch: 'arm64',
    chip,
    ramBytes: ramGiB * GIB,
    gpu: { vendor: 'apple', name: chip },
  })

const plan = (over: Partial<ServerPlanInput> = {}) =>
  serverPlan({ engine: engine(), resolved: resolved(), hardware: RTX_4090, ...over })

/** The value after `flag`, or undefined when the flag is absent. */
const valueOf = (args: string[], flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined

let savedBudget: string | undefined
beforeAll(() => {
  savedBudget = process.env.OBREW_GPU_BUDGET_GIB
  delete process.env.OBREW_GPU_BUDGET_GIB
})
afterAll(() => {
  if (savedBudget !== undefined) process.env.OBREW_GPU_BUDGET_GIB = savedBudget
})

describe('footprintBytes', () => {
  test('the files plus 10%, plus 1.5 GiB to compute in; half a GiB with no model', () => {
    expect(footprintBytes(resolved({ bytes: 4 * GIB }))).toBe(Math.round(4 * GIB * 1.1 + 1.5 * GIB))
    expect(footprintBytes(null)).toBe(Math.round(0.5 * GIB))
  })
})

describe('serverPlan', () => {
  test("the bundle's files and defaults are startup flags; the upscaler loads from its directory", () => {
    const flux = resolved({
      bundle: { ...TURBO, id: 'flux2-klein-4b', defaults: { steps: 4, cfg: 1, sampler: 'euler' } },
      paths: { ...resolved().paths, upscaler: '/u/RealESRGAN_x4plus.safetensors' },
    })
    const { args } = plan({ resolved: flux, port: 8190 })
    expect(args.slice(0, 8)).toEqual([
      '--listen-ip',
      '127.0.0.1',
      '--listen-port',
      '8190',
      '--model-dir',
      modelRootDir(),
      '--hires-upscalers-dir',
      upscalersDir(),
    ])
    expect(valueOf(args, '--diffusion-model')).toBe('/m/z_image_turbo-Q5_0.gguf')
    expect(valueOf(args, '--llm')).toBe('/m/Qwen3-4B-Q4_K_M.gguf')
    expect(valueOf(args, '--vae')).toBe('/m/ae.safetensors')
    expect(args).not.toContain('--upscale-model')
    expect(valueOf(args, '--steps')).toBe('4')
    expect(valueOf(args, '--cfg-scale')).toBe('1')
    expect(valueOf(args, '--sampling-method')).toBe('euler')
  })

  test('no bundle (an upscale-only engine): no model flags, and a small footprint', () => {
    const p = plan({ resolved: null })
    for (const flag of ['--diffusion-model', '--llm', '--vae', '--steps', '--cfg-scale'])
      expect(p.args).not.toContain(flag)
    expect(p.footprintBytes).toBe(footprintBytes(null))
  })

  test('over budget: weights offloaded, and --max-vram is the budget less 1.5 GiB, rounded down', () => {
    const p = plan({ hardware: RTX_4060 })
    expect(p.footprintBytes).toBe(footprintBytes(resolved()))
    expect(p.footprintBytes).toBeGreaterThan(8188 * MIB)
    expect(p.args).toContain('--offload-to-cpu')
    expect(valueOf(p.args, '--max-vram')).toBe(String(Math.floor(8188 / 1024 - 1.5)))
    expect(valueOf(p.args, '--max-vram')).toBe('6')
  })

  test('--max-vram is never below 1', () => {
    const tiny = fakeHardware({ gpu: { vendor: 'nvidia', vramBytes: 2 * GIB } })
    expect(
      valueOf(plan({ engine: engine({ variant: 'vulkan' }), hardware: tiny }).args, '--max-vram'),
    ).toBe('1')
  })

  test('under budget: neither flag; sd-server places the weights itself', () => {
    const { args } = plan({ hardware: RTX_4090 })
    expect(args).not.toContain('--offload-to-cpu')
    expect(args).not.toContain('--max-vram')
  })

  test('unknown budget: offload, with no --max-vram to give', () => {
    const { args } = plan({ hardware: NO_VRAM })
    expect(args).toContain('--offload-to-cpu')
    expect(args).not.toContain('--max-vram')
  })

  test('VAE tiling: always on Vulkan and ROCm, and on any card of 8 GiB or less', () => {
    expect(plan({ engine: engine({ variant: 'vulkan' }), hardware: RX_7900 }).args).toContain(
      '--vae-tiling',
    )
    expect(plan({ engine: engine({ variant: 'rocm' }), hardware: RX_7900 }).args).toContain(
      '--vae-tiling',
    )
    expect(plan({ hardware: RTX_4060 }).args).toContain('--vae-tiling')
    expect(plan({ hardware: RTX_4090 }).args).not.toContain('--vae-tiling')
  })

  test('Metal: batched CFG off, and no offload even when the bundle does not fit', () => {
    const p = plan({
      engine: engine({ variant: 'metal', devices: ['MTL0', 'CPU'] }),
      hardware: mac('Apple M4', 8),
    })
    expect(p.footprintBytes).toBeGreaterThan(8 * GIB * 0.65)
    expect(valueOf(p.args, '--batched-cfg')).toBe('off')
    for (const flag of ['--offload-to-cpu', '--max-vram', '--vae-tiling', '--backend'])
      expect(p.args).not.toContain(flag)
  })

  test('the cpu variant: --backend cpu, and no GPU memory flags', () => {
    const { args } = plan({
      engine: engine({ variant: 'cpu', devices: ['CPU'] }),
      hardware: RTX_4060,
    })
    expect(valueOf(args, '--backend')).toBe('cpu')
    for (const flag of ['--offload-to-cpu', '--max-vram', '--vae-tiling', '--batched-cfg'])
      expect(args).not.toContain(flag)
  })

  describe('-c overrides', () => {
    test('offload: off where it would be on, on where it would be off', () => {
      const off = plan({ hardware: RTX_4060, pairs: { offload: false } }).args
      expect(off).not.toContain('--offload-to-cpu')
      expect(off).not.toContain('--max-vram')
      const on = plan({ hardware: RTX_4090, pairs: { offload: 'on' } }).args
      expect(on).toContain('--offload-to-cpu')
      expect(valueOf(on, '--max-vram')).toBe('22')
    })

    test('max_vram replaces the computed value, offloading or not', () => {
      expect(valueOf(plan({ hardware: RTX_4060, pairs: { max_vram: 5 } }).args, '--max-vram')).toBe(
        '5',
      )
      expect(
        valueOf(plan({ hardware: RTX_4090, pairs: { max_vram: 20 } }).args, '--max-vram'),
      ).toBe('20')
    })

    test('vae_tiling, backend and threads', () => {
      expect(
        plan({
          engine: engine({ variant: 'vulkan' }),
          hardware: RX_7900,
          pairs: { vae_tiling: 'off' },
        }).args,
      ).not.toContain('--vae-tiling')
      expect(plan({ hardware: RTX_4090, pairs: { vae_tiling: 1 } }).args).toContain('--vae-tiling')
      expect(
        valueOf(plan({ pairs: { backend: 'diffusion=cuda0,te=cpu' } }).args, '--backend'),
      ).toBe('diffusion=cuda0,te=cpu')
      expect(
        valueOf(
          plan({ engine: engine({ variant: 'cpu' }), pairs: { backend: 'vulkan0' } }).args,
          '--backend',
        ),
      ).toBe('vulkan0')
      expect(valueOf(plan({ pairs: { threads: 8 } }).args, '--threads')).toBe('8')
    })

    test('a switch that is not true or false is a bad request', () => {
      expect(() => plan({ pairs: { offload: 'maybe' } })).toThrow(
        '-c offload expects true|false, got "maybe"',
      )
      expect(() => plan({ pairs: { vae_tiling: 2 } })).toThrow(
        expect.objectContaining({ code: 'bad_request' }),
      )
    })

    test('-c vae_tiling=true tiles the VAE on Metal and on the CPU as well', () => {
      const metal = plan({
        engine: engine({ variant: 'metal' }),
        hardware: mac('Apple M4'),
        pairs: { vae_tiling: true },
      })
      expect(metal.args).toContain('--vae-tiling')
      expect(
        plan({ engine: engine({ variant: 'cpu' }), pairs: { vae_tiling: true } }).args,
      ).toContain('--vae-tiling')
    })
  })

  test('flags this build does not list are dropped, value and all, and reported', () => {
    const lacking = engine({
      variant: 'vulkan',
      flags: [
        '--listen-ip',
        '--listen-port',
        '--model-dir',
        '--diffusion-model',
        '--llm',
        '--vae',
        '--steps',
        '--cfg-scale',
        '--offload-to-cpu',
        '--max-vram',
      ],
    })
    const p = plan({ engine: lacking, hardware: RX_7900, port: 8190 })
    expect(p.dropped).toEqual(['--hires-upscalers-dir', '--vae-tiling'])
    expect(p.args).not.toContain('--hires-upscalers-dir')
    expect(p.args).not.toContain(upscalersDir())
    expect(p.args).not.toContain('--vae-tiling')
    expect(valueOf(p.args, '--listen-port')).toBe('8190')
  })

  test('an empty flag list (an OBREW_SD_SERVER override) keeps everything', () => {
    const p = plan({ engine: engine({ variant: 'vulkan', flags: [] }), hardware: RX_7900 })
    expect(p.dropped).toEqual([])
    expect(p.args).toContain('--hires-upscalers-dir')
    expect(p.args).toContain('--vae-tiling')
  })

  test('the key does not depend on the port, and changes with the bundle hashes, the args and the build', () => {
    const base = plan({ port: 8190 })
    expect(plan({ port: 8191 }).key).toBe(base.key)
    expect(plan().key).toBe(base.key)
    expect(plan({ port: 8191 }).args).not.toEqual(base.args)

    const requantised = resolved({ hashes: { ...resolved().hashes, diffusion: 'd'.repeat(64) } })
    expect(plan({ resolved: requantised }).key).not.toBe(base.key)
    expect(plan({ pairs: { threads: 4 } }).key).not.toBe(base.key)
    expect(plan({ hardware: RTX_4060 }).key).not.toBe(base.key)
    expect(plan({ engine: engine({ tag: 'master-990-0f3c9e1' }) }).key).not.toBe(base.key)
  })

  test('M5 and later disable the Metal tensor API; M4 does not', () => {
    const metal = engine({ variant: 'metal' })
    expect(plan({ engine: metal, hardware: mac('Apple M5') }).env.GGML_METAL_TENSOR_DISABLE).toBe(
      '1',
    )
    expect(
      plan({ engine: metal, hardware: mac('Apple M5 Pro') }).env.GGML_METAL_TENSOR_DISABLE,
    ).toBe('1')
    expect(
      plan({ engine: metal, hardware: mac('Apple M4') }).env.GGML_METAL_TENSOR_DISABLE,
    ).toBeUndefined()
    expect(plan({ engine: metal, hardware: mac('Apple M5') }).key).not.toBe(
      plan({ engine: metal, hardware: mac('Apple M4') }).key,
    )
    // Only Metal renders through it.
    expect(
      plan({ engine: engine({ variant: 'cpu' }), hardware: mac('Apple M5') }).env
        .GGML_METAL_TENSOR_DISABLE,
    ).toBeUndefined()
  })

  test.if(process.platform === 'linux')('Linux: the binary directory leads LD_LIBRARY_PATH', () => {
    const saved = process.env.LD_LIBRARY_PATH
    try {
      delete process.env.LD_LIBRARY_PATH
      expect(plan().env.LD_LIBRARY_PATH).toBe(engine().binDir)
      process.env.LD_LIBRARY_PATH = '/usr/local/cuda/lib64'
      expect(plan().env.LD_LIBRARY_PATH).toBe(`${engine().binDir}:/usr/local/cuda/lib64`)
    } finally {
      if (saved === undefined) delete process.env.LD_LIBRARY_PATH
      else process.env.LD_LIBRARY_PATH = saved
    }
  })

  test.if(process.platform !== 'linux')('elsewhere the environment is left alone', () => {
    expect(plan().env).toEqual({})
  })
})

describe('metalTensorBroken', () => {
  test('M5 and every later generation; not M1–M4, and not a chip that is not Apple silicon', () => {
    for (const chip of ['Apple M5', 'Apple M5 Max', 'Apple M6', 'Apple M10'])
      expect(metalTensorBroken(mac(chip))).toBe(true)
    for (const chip of ['Apple M1', 'Apple M4 Pro', 'Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz'])
      expect(metalTensorBroken(mac(chip))).toBe(false)
    expect(metalTensorBroken(fakeHardware())).toBe(false)
  })
})
