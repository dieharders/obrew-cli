/**
 * From --size / --aspect / --upscale (or an input image's size) to what the model generates and
 * what happens after: parsing WIDTHxHEIGHT, the native-size search (aligned, within the pixel
 * limit), and the plan — made directly, made a little larger and cropped, or made near one
 * megapixel and upscaled — with the combinations and sizes it refuses.
 */
import { describe, expect, test } from 'bun:test'
import { MAX_SIDE, MIN_SIDE, nativeFor, parseSize, planSize, type PlanInput } from './size'

/** Z-Image-Turbo's and FLUX.2 klein's limits. */
const PRESET = { align: 16, maxPixels: 2_200_000 }
const plan = (o: Omit<PlanInput, 'align' | 'maxPixels'> & Partial<PlanInput>) =>
  planSize({ ...PRESET, ...o })

describe('parseSize', () => {
  test('WIDTHxHEIGHT, with x, X, × or *, spaces allowed', () => {
    expect(parseSize('1280x720')).toEqual({ width: 1280, height: 720 })
    expect(parseSize(' 1920 × 1080 ')).toEqual({ width: 1920, height: 1080 })
    expect(parseSize('1024*1024')).toEqual({ width: 1024, height: 1024 })
    expect(parseSize('768X1344')).toEqual({ width: 768, height: 1344 })
  })

  test('16 to 8192 per side', () => {
    expect(parseSize('16x16')).toEqual({ width: 16, height: 16 })
    expect(parseSize('8192x8192')).toEqual({ width: 8192, height: 8192 })
    for (const text of ['15x100', '100x8', '8193x1024', '1024x8193', '0x0']) {
      expect(() => parseSize(text)).toThrow(
        expect.objectContaining({
          code: 'bad_request',
          message: expect.stringContaining('outside 16..8192'),
        }),
      )
    }
  })

  test('anything else is a bad request that quotes what it got', () => {
    for (const text of [
      '',
      '1280',
      '1280x',
      'x720',
      '1280x720x3',
      '-1280x720',
      '1280.5x720',
      'widexhigh',
      '16:9',
    ]) {
      expect(() => parseSize(text)).toThrow(
        expect.objectContaining({
          code: 'bad_request',
          message: expect.stringContaining(`got "${text}"`),
        }),
      )
    }
  })
})

describe('nativeFor', () => {
  test('about a megapixel at the aspect ratio, in multiples of the alignment', () => {
    expect(nativeFor(1, 16, 2_200_000)).toEqual({ width: 1024, height: 1024 })
    expect(nativeFor(16 / 9, 16, 2_200_000)).toEqual({ width: 1360, height: 768 })
    expect(nativeFor(3 / 2, 16, 2_200_000)).toEqual({ width: 1248, height: 832 })
  })

  test('below a megapixel limit, the limit is the area; rounding up past it rounds both sides down', () => {
    expect(nativeFor(1, 16, 500_000)).toEqual({ width: 704, height: 704 })
    // √260000 ≈ 510 rounds up to 512, and 512² is over the limit: both sides round down, so a
    // square stays square.
    expect(nativeFor(1, 16, 260_000)).toEqual({ width: 496, height: 496 })
  })

  test('extreme ratios stay within sd-server’s side limits', () => {
    expect(nativeFor(100, 16, 2_200_000)).toEqual({ width: MAX_SIDE, height: 96 })
    expect(nativeFor(0.01, 16, 2_200_000)).toEqual({ width: 96, height: MAX_SIDE })
  })

  test('aligned, within the limit and the side bounds, for every ratio, alignment and limit tried', () => {
    for (const ratio of [1, 16 / 9, 9 / 16, 4 / 3, 3 / 4, 21 / 9, 2.35, 0.4]) {
      for (const align of [8, 16, 64]) {
        for (const maxPixels of [300_000, 1_100_000, 2_200_000]) {
          const { width, height } = nativeFor(ratio, align, maxPixels)
          expect(width % align).toBe(0)
          expect(height % align).toBe(0)
          expect(width * height).toBeLessThanOrEqual(maxPixels)
          for (const side of [width, height]) {
            expect(side).toBeGreaterThanOrEqual(MIN_SIDE)
            expect(side).toBeLessThanOrEqual(MAX_SIDE)
          }
        }
      }
    }
  })
})

describe('planSize', () => {
  test('a size the model makes natively is made as it is, with nothing done after', () => {
    expect(plan({ size: { width: 1280, height: 720 } })).toEqual({
      gen: { width: 1280, height: 720 },
      final: { width: 1280, height: 720 },
      upscalePasses: 0,
      resample: false,
    })
    expect(plan({ aspect: '16:9' })).toEqual(plan({ size: { width: 1280, height: 720 } }))
  })

  test('1920x1080 is made at 1920x1088 and cropped: no upscaler', () => {
    expect(plan({ size: { width: 1920, height: 1080 } })).toEqual({
      gen: { width: 1920, height: 1088 },
      final: { width: 1920, height: 1080 },
      upscalePasses: 0,
      resample: true,
    })
  })

  test('4K is made near one megapixel at its aspect ratio, upscaled once and resampled', () => {
    const p = plan({ size: { width: 3840, height: 2160 } })
    expect(p).toMatchObject({
      final: { width: 3840, height: 2160 },
      upscalePasses: 1,
      resample: true,
    })
    expect(p.gen.width % 16).toBe(0)
    expect(p.gen.height % 16).toBe(0)
    expect(p.gen.width * p.gen.height).toBeGreaterThan(900_000)
    expect(p.gen.width * p.gen.height).toBeLessThan(1_100_000)
    expect(p.gen.width / p.gen.height).toBeCloseTo(16 / 9, 1)
    expect(p.gen).toEqual({ width: 1360, height: 768 })
  })

  test('under a smaller pixel limit, even 1280x720 is made smaller and upscaled', () => {
    expect(planSize({ align: 16, maxPixels: 500_000, size: { width: 1280, height: 720 } })).toEqual(
      {
        gen: { width: 944, height: 528 },
        final: { width: 1280, height: 720 },
        upscalePasses: 1,
        resample: true,
      },
    )
  })

  test('an unaligned small size is rounded up and resampled down, never upscaled', () => {
    expect(plan({ size: { width: 100, height: 100 } })).toEqual({
      gen: { width: 112, height: 112 },
      final: { width: 100, height: 100 },
      upscalePasses: 0,
      resample: true,
    })
  })

  test('--upscale 2 is ESRGAN ×4 then resampled to twice the size; --upscale 4 is ESRGAN alone', () => {
    expect(plan({ upscale: 2 })).toEqual({
      gen: { width: 1024, height: 1024 },
      final: { width: 2048, height: 2048 },
      upscalePasses: 1,
      resample: true,
    })
    expect(plan({ aspect: '16:9', upscale: 4 })).toEqual({
      gen: { width: 1280, height: 720 },
      final: { width: 5120, height: 2880 },
      upscalePasses: 1,
      resample: false,
    })
  })

  test('img2img: an input the model can make keeps its size; another keeps its aspect ratio', () => {
    expect(plan({ like: { width: 1280, height: 720 } }).gen).toEqual({ width: 1280, height: 720 })
    expect(plan({ like: { width: 768, height: 1344 } }).gen).toEqual({ width: 768, height: 1344 })
    const photo = plan({ like: { width: 3000, height: 2000 } })
    expect(photo).toEqual({
      gen: { width: 1248, height: 832 },
      final: { width: 1248, height: 832 },
      upscalePasses: 0,
      resample: false,
    })
    expect(plan({ like: { width: 1920, height: 1080 } }).gen).toEqual(
      nativeFor(1920 / 1080, 16, 2_200_000),
    )
    expect(plan({ like: { width: 1280, height: 720 }, upscale: 2 }).final).toEqual({
      width: 2560,
      height: 1440,
    })
  })

  test('an explicit size or aspect wins over the input image', () => {
    expect(plan({ aspect: '1:1', like: { width: 1920, height: 1080 } }).gen).toEqual({
      width: 1024,
      height: 1024,
    })
    expect(
      plan({ size: { width: 1280, height: 720 }, like: { width: 3000, height: 2000 } }).gen,
    ).toEqual({ width: 1280, height: 720 })
  })

  test('nothing asked: a square megapixel', () => {
    expect(plan({})).toEqual({
      gen: { width: 1024, height: 1024 },
      final: { width: 1024, height: 1024 },
      upscalePasses: 0,
      resample: false,
    })
  })

  test('--size with --upscale, or with --aspect, is a bad request', () => {
    const bad = expect.objectContaining({ code: 'bad_request' })
    expect(() => plan({ size: { width: 1920, height: 1080 }, upscale: 2 })).toThrow(bad)
    expect(() => plan({ size: { width: 1920, height: 1080 }, aspect: '16:9' })).toThrow(bad)
  })

  test('an upscale whose ×4 pass would pass 8192 px on a side is refused', () => {
    const overflow = expect.objectContaining({
      code: 'bad_request',
      message: expect.stringContaining('exceeds 8192 px per side'),
    })
    // 8:1 is made at 2896x368; ×4 is 11584 wide.
    expect(() => plan({ size: { width: 8192, height: 1024 } })).toThrow(overflow)
    // A 4096-wide input, upscaled: the ×4 intermediate overflows for --upscale 2 as well.
    expect(() => plan({ like: { width: 4096, height: 256 }, upscale: 4 })).toThrow(overflow)
    expect(() => plan({ like: { width: 4096, height: 256 }, upscale: 2 })).toThrow(overflow)
  })
})
