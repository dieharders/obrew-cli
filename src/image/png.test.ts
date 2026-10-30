import { describe, expect, test } from 'bun:test'
import { deflateSync, inflateSync } from 'node:zlib'
import {
  coverResize,
  crop,
  decodePng,
  encodePng,
  halve,
  isBlank,
  readImageSize,
  resize,
  type RasterImage,
} from './png'

const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0))
const be16 = (v: number) => [v >>> 8, v & 255]
const be32 = (v: number) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const le16 = (v: number) => [v & 255, v >>> 8]
const le24 = (v: number) => [v & 255, (v >>> 8) & 255, v >>> 16]
const le32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]

/** Seeded pseudo-random bytes, so a failure reproduces. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  let s = seed
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s >>> 24
  }
  return out
}

type Channels = RasterImage['channels']

function image(w: number, h: number, channels: Channels, data: ArrayLike<number>): RasterImage {
  return { width: w, height: h, channels, data: Uint8Array.from(data) }
}

const gray = (width: number, height: number, values: number[]) => image(width, height, 1, values)

/** Every pixel the same. */
function fill(width: number, height: number, pixel: number[]): RasterImage {
  const data = new Uint8Array(width * height * pixel.length)
  for (let i = 0; i < data.length; i++) data[i] = pixel[i % pixel.length]!
  return { width, height, channels: pixel.length as Channels, data }
}

// Hand-built PNGs. Chunk CRCs come from Bun's own CRC-32, so the codec is not checked against
// itself, and the scanlines are filtered here, straight from the spec.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function chunk(type: string, body: ArrayLike<number> = []): number[] {
  const typed = [...ascii(type), ...Array.from(body)]
  return [...be32(body.length), ...typed, ...be32(Bun.hash.crc32(Uint8Array.from(typed)))]
}

const ihdr = (width: number, height: number, depth: number, colorType: number, interlace = 0) =>
  chunk('IHDR', [...be32(width), ...be32(height), depth, colorType, 0, 0, interlace])

const pngFile = (...chunks: number[][]) => Uint8Array.from([...SIGNATURE, ...chunks.flat()])

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Scanlines for rows of `stride` bytes, row y filtered with filters[y % filters.length]. */
function scanlines(pixels: Uint8Array, stride: number, bpp: number, filters: number[]): Uint8Array {
  const at = (row: number, col: number) => (row >= 0 && col >= 0 ? pixels[row * stride + col]! : 0)
  const rows = pixels.length / stride
  const out = new Uint8Array(rows * (stride + 1))
  for (let y = 0; y < rows; y++) {
    const f = filters[y % filters.length]!
    out[y * (stride + 1)] = f
    for (let i = 0; i < stride; i++) {
      const [a, b, c] = [at(y, i - bpp), at(y - 1, i), at(y - 1, i - bpp)]
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]!
      out[y * (stride + 1) + 1 + i] = at(y, i) - predicted
    }
  }
  return out
}

/** Sample c of output pixel (ox, oy) when img is area-averaged to w×h, from the definition. */
function areaSample(img: RasterImage, w: number, h: number, ox: number, oy: number, c: number) {
  const [fx, fy] = [img.width / w, img.height / h] // source pixels per output pixel
  let acc = 0
  for (let y = Math.floor(oy * fy); y < Math.ceil((oy + 1) * fy); y++) {
    const wy = Math.min(y + 1, (oy + 1) * fy) - Math.max(y, oy * fy)
    for (let x = Math.floor(ox * fx); x < Math.ceil((ox + 1) * fx); x++) {
      const wx = Math.min(x + 1, (ox + 1) * fx) - Math.max(x, ox * fx)
      acc += wx * wy * img.data[(y * img.width + x) * img.channels + c]!
    }
  }
  return acc / (fx * fy)
}

describe('decodePng', () => {
  // Big enough that noise hits Paeth's rare ties (b and c equally near), whose order is fixed.
  const [width, height] = [64, 48]
  const rgb = noise(width * height * 3, 7)

  for (const [f, name] of ['None', 'Sub', 'Up', 'Average', 'Paeth'].entries()) {
    test(`undoes the ${name} filter`, () => {
      const idat = chunk('IDAT', deflateSync(scanlines(rgb, width * 3, 3, [f])))
      const file = pngFile(ihdr(width, height, 8, 2), idat, chunk('IEND'))
      expect(decodePng(file)).toEqual({ width, height, channels: 3, data: rgb })
    })
  }

  test('joins split IDATs, takes a different filter per row and skips ancillary chunks', () => {
    const rgba = noise(width * height * 4, 8)
    const z = deflateSync(scanlines(rgba, width * 4, 4, [4, 3, 2, 1, 0]))
    const file = pngFile(
      ihdr(width, height, 8, 6),
      chunk('tEXt', ascii('parameters\0a lighthouse at dusk')),
      chunk('IDAT', z.subarray(0, 3)),
      chunk('IDAT', z.subarray(3, 20)),
      chunk('IDAT', z.subarray(20)),
      chunk('IEND'),
    )
    expect(decodePng(file)).toEqual({ width, height, channels: 4, data: rgba })
  })

  test('keeps the high byte of 16-bit samples', () => {
    const wide = noise(width * height * 6, 9) // RGB at two bytes a sample, big-endian
    const idat = chunk('IDAT', deflateSync(scanlines(wide, width * 6, 6, [1, 4, 3, 2, 0])))
    const file = pngFile(ihdr(width, height, 16, 2), idat, chunk('IEND'))
    const high = wide.filter((_, i) => i % 2 === 0)
    expect(decodePng(file)).toEqual({ width, height, channels: 3, data: high })
  })

  test('expands a palette to RGB, or to RGBA when there is a tRNS chunk', () => {
    const red = [255, 0, 0]
    const green = [0, 255, 0]
    const blue = [0, 0, 255]
    const plte = chunk('PLTE', [...red, ...green, ...blue])
    const indexes = Uint8Array.from([0, 1, 2, 2, 1, 0]) // 3x2
    const idat = chunk('IDAT', deflateSync(scanlines(indexes, 3, 1, [0, 1])))
    const opaque = decodePng(pngFile(ihdr(3, 2, 8, 3), plte, idat, chunk('IEND')))
    expect(opaque).toEqual(image(3, 2, 3, [...red, ...green, ...blue, ...blue, ...green, ...red]))
    // tRNS gives the first two entries' alpha; entries past its end are opaque.
    const trns = chunk('tRNS', [0, 128])
    const alpha = decodePng(pngFile(ihdr(3, 2, 8, 3), plte, trns, idat, chunk('IEND')))
    const [r, g, b] = [
      [...red, 0],
      [...green, 128],
      [...blue, 255],
    ]
    expect(alpha).toEqual(image(3, 2, 4, [...r, ...g, ...b, ...b, ...g, ...r]))
  })

  test('refuses interlaced (Adam7) images', () => {
    const idat = chunk('IDAT', deflateSync(new Uint8Array(20)))
    const file = pngFile(ihdr(2, 2, 8, 2, 1), idat, chunk('IEND'))
    expect(() => decodePng(file)).toThrow(/interlaced \(Adam7\) PNGs are not supported/)
  })

  test('refuses a bad signature, truncation and a corrupt CRC', () => {
    const good = encodePng(image(4, 4, 3, noise(48)))
    const notPng = good.slice()
    notPng[1] = 0x51
    expect(() => decodePng(notPng)).toThrow(/bad signature/)
    const noEnd = good.subarray(0, good.length - 12)
    expect(() => decodePng(noEnd)).toThrow(/ends before its IEND/)
    const cut = good.subarray(0, good.length - 20)
    expect(() => decodePng(cut)).toThrow(/IDAT chunk runs past the end/)
    const flipped = good.slice()
    flipped[45] = flipped[45]! ^ 1 // a byte of IDAT's data
    expect(() => decodePng(flipped)).toThrow(/CRC mismatch in the IDAT chunk/)
  })

  test('refuses depths it does not read', () => {
    const idat = chunk('IDAT', deflateSync(new Uint8Array(2)))
    const file = pngFile(ihdr(8, 1, 1, 0), idat, chunk('IEND'))
    expect(() => decodePng(file)).toThrow(/bit depth 1 with color type 0/)
  })
})

describe('encodePng', () => {
  for (const channels of [1, 2, 3, 4] as const) {
    test(`round-trips ${channels} channel${channels > 1 ? 's' : ''}`, () => {
      const img = image(37, 23, channels, noise(37 * 23 * channels, channels))
      expect(decodePng(encodePng(img))).toEqual(img)
    })
  }

  test('writes IHDR, IDAT and IEND, each with a correct CRC', () => {
    const file = encodePng(image(5, 3, 3, noise(45)))
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    expect([...file.subarray(0, 8)]).toEqual(SIGNATURE)
    const types: string[] = []
    let p = 8
    while (p < file.length) {
      const length = view.getUint32(p)
      const typed = file.subarray(p + 4, p + 8 + length)
      types.push(String.fromCharCode(...typed.subarray(0, 4)))
      expect(view.getUint32(p + 8 + length)).toBe(Bun.hash.crc32(typed))
      p += 12 + length
    }
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect([...file.subarray(-4)]).toEqual([0xae, 0x42, 0x60, 0x82]) // the well-known IEND CRC
  })

  test("picks each row's filter by the minimum sum of absolute differences", () => {
    // Each row is built for one filter; a tie goes to the lower filter type.
    const rows = [
      [0, 0, 0, 0, 0, 0, 0, 0], // None: every filter scores 0
      [0, 10, 20, 30, 40, 50, 60, 70], // Sub: a ramp
      [0, 10, 20, 30, 40, 50, 60, 70], // Up: the row above again
      [100, 100, 100, 100, 100, 100, 100, 100], // Sub
      [50, 75, 87, 93, 96, 98, 99, 99], // Average: each is (left + above) / 2
      [0, 40, 80, 120, 160, 160, 160, 160], // Sub
      [0, 40, 80, 120, 50, 50, 50, 50], // Paeth: above on the left, left on the right
    ]
    const img = gray(8, rows.length, rows.flat())
    const file = encodePng(img)
    const scan = inflateSync(file.subarray(41, file.length - 16)) // IDAT's data
    expect(rows.map((_, y) => scan[y * 9])).toEqual([0, 1, 2, 1, 3, 1, 4])
    expect(decodePng(file)).toEqual(img)
  })

  test('every level from 0 to 9 decodes to the same pixels', () => {
    const img = image(16, 16, 3, noise(768, 3))
    for (let level = 0; level <= 9; level++) {
      expect(decodePng(encodePng(img, { level }))).toEqual(img)
    }
    expect(() => encodePng(img, { level: 10 })).toThrow(/level must be/)
  })

  test('refuses data that does not match the size', () => {
    expect(() => encodePng(image(4, 4, 3, new Uint8Array(47)))).toThrow(/48 bytes, got 47/)
  })
})

describe('resize', () => {
  test('a uniform image stays uniform at every size', () => {
    const pixel = [12, 200, 99, 255]
    const sizes = [
      [3, 2],
      [11, 13],
      [4, 9],
      [7, 1],
      [1, 1],
      [2, 5],
    ] as const
    for (const [w, h] of sizes) expect(resize(fill(7, 5, pixel), w, h)).toEqual(fill(w, h, pixel))
  })

  test('an exact 2:1 shrink matches halve, on a 4x4 checker and on noise', () => {
    const checker = gray(4, 4, [0, 255, 0, 255, 255, 0, 255, 0, 0, 255, 0, 255, 255, 0, 255, 0])
    expect(halve(checker)).toEqual(gray(2, 2, [128, 128, 128, 128])) // 127.5 rounds half up
    expect(resize(checker, 2, 2)).toEqual(halve(checker))
    const rgb = image(10, 6, 3, noise(180, 5))
    expect(resize(rgb, 5, 3)).toEqual(halve(rgb))
  })

  test('area-averages a 3-to-2 shrink by overlap', () => {
    // Output pixel 0 covers source [0, 1.5): 2/3 of pixel 0 and 1/3 of pixel 1. Pixel 1 mirrors it.
    expect(resize(gray(3, 1, [0, 30, 90]), 2, 1)).toEqual(gray(2, 1, [10, 70]))
    expect(resize(gray(3, 1, [0, 0, 100]), 2, 1)).toEqual(gray(2, 1, [0, 67])) // 66.7
    // In 2-D the weights multiply: (4·0 + 2·30 + 2·30 + 1·60) / 9 = 20, and so on.
    const square = gray(3, 3, [0, 30, 90, 30, 60, 120, 90, 120, 180])
    expect(resize(square, 2, 2)).toEqual(gray(2, 2, [20, 80, 80, 140]))
  })

  test('matches the area-average definition at uneven ratios', () => {
    const img = image(13, 11, 3, noise(13 * 11 * 3, 2))
    const out = resize(img, 5, 4) // 2.6 and 2.75 source pixels per output pixel
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        for (let c = 0; c < 3; c++) {
          const got = out.data[(y * 5 + x) * 3 + c]!
          expect(Math.abs(got - areaSample(img, 5, 4, x, y, c))).toBeLessThanOrEqual(0.5)
        }
      }
    }
  })

  test('enlarges bilinearly with pixel centers aligned, clamping at the edges', () => {
    expect(resize(gray(2, 1, [0, 100]), 4, 1)).toEqual(gray(4, 1, [0, 25, 75, 100]))
    const up = resize(image(3, 2, 3, noise(18)), 7, 5)
    expect([up.width, up.height, up.channels, up.data.length]).toEqual([7, 5, 3, 105])
  })

  test('shrinks one dimension while enlarging the other', () => {
    // Pixel = row value + column value. The 6 columns average in threes, to 3 and 12; the 3 rows
    // interpolate to 9.
    const rows = [0, 90, 180]
    const cols = [0, 3, 6, 9, 12, 15]
    const values = rows.flatMap((r) => cols.map((c) => r + c))
    const tall = [0, 0, 30, 60, 90, 120, 150, 180, 180]
    const expected = tall.flatMap((r) => [r + 3, r + 12])
    expect(resize(gray(6, 3, values), 2, 9)).toEqual(gray(2, 9, expected))
  })

  test('refuses sizes that are not whole numbers of at least 1', () => {
    const img = gray(2, 2, [1, 2, 3, 4])
    expect(() => resize(img, 0, 2)).toThrow(/at least 1/)
    expect(() => resize(img, 2, 1.5)).toThrow(/at least 1/)
  })
})

describe('halve', () => {
  test('averages 2x2 blocks, rounding half up, and drops an odd last row and column', () => {
    // Blocks (0+1+4+5)/4 = 2.5 → 3 and (2+3+8+10)/4 = 5.75 → 6; the 99s are dropped.
    const img = gray(5, 3, [0, 1, 2, 3, 99, 4, 5, 8, 10, 99, 99, 99, 99, 99, 99])
    expect(halve(img)).toEqual(gray(2, 1, [3, 6]))
  })

  test('refuses an image less than 2 pixels in either dimension', () => {
    expect(() => halve(gray(1, 4, [1, 2, 3, 4]))).toThrow(/at least 2x2/)
  })
})

describe('crop and coverResize', () => {
  const ramp = gray(4, 3, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

  test('crop returns exactly the window asked for', () => {
    expect(crop(ramp, 1, 1, 2, 2)).toEqual(gray(2, 2, [5, 6, 9, 10]))
    expect(crop(ramp, 0, 0, 4, 3)).toEqual(ramp)
    expect(() => crop(ramp, 3, 0, 2, 1)).toThrow(/does not fit/)
    expect(() => crop(ramp, -1, 0, 1, 1)).toThrow(/does not fit/)
  })

  test('coverResize keeps the middle columns of an image that is too wide', () => {
    // 4x2 into 2x2: the height binds at scale 1, so one column goes from each side.
    const wide = gray(4, 2, [10, 20, 30, 40, 50, 60, 70, 80])
    expect(coverResize(wide, 2, 2)).toEqual(gray(2, 2, [20, 30, 60, 70]))
    // An odd overflow leaves the extra column on the right: the offset is floor(3 / 2) = 1.
    expect(coverResize(gray(5, 1, [0, 10, 20, 30, 40]), 2, 1)).toEqual(gray(2, 1, [10, 20]))
  })

  test('coverResize keeps the middle rows of an image that is too tall', () => {
    const tall = gray(2, 6, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(coverResize(tall, 2, 2)).toEqual(gray(2, 2, [4, 5, 6, 7]))
  })

  test('coverResize scales to cover first, then center-crops', () => {
    // 8x4 into 2x2: scale by 1/2 (the height binds) to 4x2, then one column goes from each side.
    const img = image(8, 4, 3, noise(96, 4))
    expect(coverResize(img, 2, 2)).toEqual(crop(halve(img), 1, 0, 2, 2))
    // The same aspect ratio is a plain resize, as with 5120x2880 into 1920x1080.
    const wide = image(16, 9, 3, noise(432, 6))
    expect(coverResize(wide, 32, 18)).toEqual(resize(wide, 32, 18))
  })

  test('coverResize always lands on the exact size', () => {
    const img = image(16, 9, 3, noise(432, 6))
    const sizes = [
      [10, 10],
      [3, 7],
      [1, 1],
      [40, 5],
      [9, 16],
      [17, 9],
    ] as const
    for (const [w, h] of sizes) {
      const out = coverResize(img, w, h)
      expect([out.width, out.height, out.data.length]).toEqual([w, h, w * h * 3])
    }
  })
})

describe('readImageSize', () => {
  test('reads a PNG IHDR', () => {
    const header = pngFile(ihdr(1280, 720, 8, 2)) // the signature and IHDR are enough
    expect(readImageSize(header)).toEqual({ width: 1280, height: 720, format: 'png' })
    const encoded = encodePng(image(3, 2, 4, noise(24)))
    expect(readImageSize(encoded)).toEqual({ width: 3, height: 2, format: 'png' })
  })

  /** A JPEG marker segment: FF, the marker, a length that counts itself, then the body. */
  const segment = (m: number, body: number[]) => [0xff, m, ...be16(body.length + 2), ...body]

  // SOI; a JFIF APP0; a DHT whose body would read as 32x16 if C4 were taken for a frame header;
  // a fill byte; then the frame header: 8-bit, 1080 high, 1920 wide, three components.
  const jpeg = (sof: number) =>
    Uint8Array.from([
      ...[0xff, 0xd8],
      ...segment(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
      ...segment(0xc4, [0, 0, 16, 0, 32]),
      0xff,
      ...segment(sof, [8, ...be16(1080), ...be16(1920), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ])

  test('reads baseline (SOF0) and progressive (SOF2) JPEG frame headers', () => {
    expect(readImageSize(jpeg(0xc0))).toEqual({ width: 1920, height: 1080, format: 'jpeg' })
    expect(readImageSize(jpeg(0xc2))).toEqual({ width: 1920, height: 1080, format: 'jpeg' })
  })

  /** A RIFF file of the given form holding one chunk. */
  const riff = (form: string, fourcc: string, payload: number[]) => {
    const body = [...ascii(form), ...ascii(fourcc), ...le32(payload.length), ...payload]
    return Uint8Array.from([...ascii('RIFF'), ...le32(body.length), ...body])
  }
  const webp = (fourcc: string, payload: number[]) => riff('WEBP', fourcc, payload)

  test('reads WebP VP8, VP8L and VP8X headers', () => {
    // Lossy: a frame tag, the start code 9D 01 2A, then 14-bit sizes; the top two bits (set on
    // the width here) are a scale.
    const vp8 = webp('VP8 ', [0x30, 1, 0, 0x9d, 1, 0x2a, ...le16(0x4000 | 1024), ...le16(768)])
    expect(readImageSize(vp8)).toEqual({ width: 1024, height: 768, format: 'webp' })
    // Lossless: 0x2F, then width - 1 and height - 1 in 14 bits each, an alpha bit and a version.
    const vp8l = webp('VP8L', [0x2f, ...le32(639 | (479 << 14) | (1 << 28)), 0])
    expect(readImageSize(vp8l)).toEqual({ width: 640, height: 480, format: 'webp' })
    // Extended: flags and reserved bytes, then the canvas width - 1 and height - 1 in 24 bits.
    const vp8x = webp('VP8X', [0x10, 0, 0, 0, ...le24(4999), ...le24(2999)])
    expect(readImageSize(vp8x)).toEqual({ width: 5000, height: 3000, format: 'webp' })
  })

  test('returns null for anything else', () => {
    const garbage = [
      new Uint8Array(0),
      Uint8Array.from(ascii('definitely not an image, just some text')),
      noise(64, 3),
      Uint8Array.from(SIGNATURE), // a PNG signature and nothing after it
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), // a JPEG that ends before any frame header
      riff('WAVE', 'fmt ', new Array(16).fill(0)),
      webp('VP8 ', [0, 0, 0, 1, 2, 3, 0, 0, 0, 0]), // no VP8 start code
    ]
    for (const bytes of garbage) expect(readImageSize(bytes)).toBeNull()
  })
})

describe('isBlank', () => {
  test('true for flat white and flat black, even with a little noise', () => {
    expect(isBlank(fill(512, 512, [255, 255, 255]))).toBe(true)
    expect(isBlank(fill(300, 200, [0, 0, 0, 255]))).toBe(true)
    expect(isBlank(fill(1, 1, [128]))).toBe(true)
    const speckled = noise(256 * 256 * 3).map((v) => 250 + (v & 3)) // 250–253
    expect(isBlank(image(256, 256, 3, speckled))).toBe(true)
  })

  test('false for a gradient, and for flat white under varying alpha', () => {
    const ramp = Array.from({ length: 256 * 64 }, (_, i) => i % 256)
    expect(isBlank(image(256, 64, 1, ramp))).toBe(false)
    const fading = Array.from({ length: 64 * 64 * 4 }, (_, i) => (i % 4 === 3 ? i % 256 : 255))
    expect(isBlank(image(64, 64, 4, fading))).toBe(false)
  })
})

describe('the 1920x1080 path', () => {
  // A ×4 ESRGAN result of a 1280x720 generation: 5120x2880 RGB, 44 MB. Measured on an Apple M4
  // under Bun 1.4.3, first run: resize to 1920x1080 ≈ 70 ms, encode ≈ 130 ms (≈ 200 ms for a real
  // photo, which deflates less well). Noted, not asserted.
  test('5120x2880 RGB resizes to exactly 1920x1080 and encodes', () => {
    const [width, height] = [5120, 2880]
    const data = new Uint8Array(width * height * 3)
    let s = 1
    for (let y = 0, i = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        const grain = s >>> 30 // 0–3: gradients with a little grain, like a photo of a sky
        data[i++] = (x >> 5) + grain
        data[i++] = (y >> 4) + grain
        data[i++] = ((x + y) >> 6) + grain
      }
    }
    const big: RasterImage = { width, height, channels: 3, data }
    const out = resize(big, 1920, 1080)
    expect([out.width, out.height, out.data.length]).toEqual([1920, 1080, 1920 * 1080 * 3])
    const probes = [
      [0, 0],
      [1, 1],
      [959, 540],
      [1919, 1079],
      [1234, 77],
    ] as const
    for (const [x, y] of probes) {
      for (let c = 0; c < 3; c++) {
        const got = out.data[(y * 1920 + x) * 3 + c]!
        expect(Math.abs(got - areaSample(big, 1920, 1080, x, y, c))).toBeLessThanOrEqual(0.5)
      }
    }
    expect(decodePng(encodePng(out))).toEqual(out)
  }, 30_000)
})
