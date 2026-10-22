/**
 * A dependency-free PNG codec and resampler, for post-processing what the image engine returns.
 *
 * stable-diffusion.cpp hands back 8-bit RGB (sometimes RGBA) PNGs, and two options need them
 * reshaped exactly:
 *
 * - `--upscale 2`. Real-ESRGAN only upscales ×4, so the ×4 result is box-downscaled 2:1
 *   (`halve`).
 * - `--size 1920x1080` from a 1280×720 generation. ×4 gives 5120×2880, which is area-averaged
 *   down to exactly 1920×1080 (`resize`). When the aspect ratio differs, `coverResize` scales the
 *   image to cover the target and center-crops it.
 *
 * Also here: `readImageSize` reads PNG, JPEG and WebP dimensions from the header alone (for
 * img2img inputs), and `isBlank` catches the flat all-white or all-black frames that a known Metal
 * bug produces. Compression is `node:zlib`, which Bun implements natively; no npm image library.
 */
import { deflateSync, inflateSync } from 'node:zlib'

/** 8-bit samples, row-major, channels interleaved. */
export interface RasterImage {
  width: number
  height: number
  channels: 1 | 2 | 3 | 4
  data: Uint8Array
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

/** Samples per pixel for each PNG color type: gray, RGB, palette index, gray+alpha, RGBA. */
const SAMPLES: Partial<Record<number, 1 | 2 | 3 | 4>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** The PNG color type the encoder writes for 1, 2, 3 and 4 channels. */
const COLOR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 } as const

const u32 = (b: Uint8Array, i: number): number =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0

const fourcc = (b: Uint8Array, i: number): string =>
  String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!)

function putU32(b: Uint8Array, i: number, v: number): void {
  b[i] = v >>> 24
  b[i + 1] = v >>> 16
  b[i + 2] = v >>> 8
  b[i + 3] = v
}

/** CRC-32 as PNG specifies it (reflected polynomial 0xEDB88320), one table lookup per byte. */
const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

/** CRC of b[start, end): for a chunk, its type and data. */
function crc32(b: Uint8Array, start: number, end: number): number {
  let c = -1
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return ~c >>> 0
}

function checkImage(img: RasterImage, fn: string): void {
  const { width, height, channels, data } = img
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`${fn}: bad image size ${width}x${height}`)
  }
  if (channels !== 1 && channels !== 2 && channels !== 3 && channels !== 4) {
    throw new Error(`${fn}: bad channel count ${channels}`)
  }
  const expected = width * height * channels
  if (data.length !== expected) {
    throw new Error(
      `${fn}: a ${width}x${height}x${channels} image has ${expected} bytes, got ${data.length}`,
    )
  }
}

function checkSize(width: number, height: number, fn: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`${fn}: the size must be whole numbers of at least 1, got ${width}x${height}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Decoding

interface PngChunks {
  width: number
  height: number
  depth: number
  colorType: number
  palette: Uint8Array | null
  /** tRNS; only a palette image's is used (a gray or RGB color key is ignored). */
  trns: Uint8Array | null
  idat: Uint8Array[]
}

/** Walk the chunks up to IEND, checking the CRC of every chunk that is read. */
function readChunks(bytes: Uint8Array): PngChunks {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) {
    throw new Error('not a PNG: bad signature')
  }
  const png: PngChunks = {
    width: 0,
    height: 0,
    depth: 0,
    colorType: 0,
    palette: null,
    trns: null,
    idat: [],
  }
  let pos = 8
  for (;;) {
    if (pos + 12 > bytes.length) {
      throw new Error('truncated PNG: the file ends before its IEND chunk')
    }
    const length = u32(bytes, pos)
    const type = fourcc(bytes, pos + 4)
    const start = pos + 8
    const end = start + length
    if (end + 4 > bytes.length) {
      throw new Error(`truncated PNG: the ${type} chunk runs past the end of the file`)
    }
    if ((type === 'IHDR') !== (pos === 8)) {
      throw new Error('corrupt PNG: IHDR must be the first chunk, and only once')
    }
    // A lowercase first letter (bit 5 set) marks an ancillary chunk, which is safe to skip unread.
    const critical = (bytes[pos + 4]! & 0x20) === 0
    if ((critical || type === 'tRNS') && crc32(bytes, pos + 4, end) !== u32(bytes, end)) {
      throw new Error(`corrupt PNG: CRC mismatch in the ${type} chunk`)
    }
    if (type === 'IEND') break
    const body = bytes.subarray(start, end)
    switch (type) {
      case 'IHDR':
        Object.assign(png, readHeader(body))
        break
      case 'PLTE':
        if (length === 0 || length > 768 || length % 3 !== 0) {
          throw new Error('corrupt PNG: bad PLTE length')
        }
        png.palette = body
        break
      case 'tRNS':
        png.trns = body
        break
      case 'IDAT':
        png.idat.push(body)
        break
      default:
        if (critical) throw new Error(`unsupported PNG: unknown critical chunk ${type}`)
    }
    pos = end + 4
  }
  if (png.idat.length === 0) throw new Error('corrupt PNG: no IDAT chunk')
  if (png.colorType === 3 && !png.palette) {
    throw new Error('corrupt PNG: a palette image without PLTE')
  }
  return png
}

function readHeader(body: Uint8Array): Pick<PngChunks, 'width' | 'height' | 'depth' | 'colorType'> {
  if (body.length !== 13) throw new Error('corrupt PNG: IHDR is not 13 bytes')
  const width = u32(body, 0)
  const height = u32(body, 4)
  const depth = body[8]!
  const colorType = body[9]!
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new Error(`corrupt PNG: bad size ${width}x${height}`)
  }
  if (body[10] !== 0 || body[11] !== 0) {
    throw new Error('corrupt PNG: unknown compression or filter method')
  }
  if (body[12] === 1) {
    throw new Error('interlaced (Adam7) PNGs are not supported; save it without interlacing')
  }
  if (body[12] !== 0) throw new Error('corrupt PNG: unknown interlace method')
  if (SAMPLES[colorType] === undefined || !(depth === 8 || (depth === 16 && colorType !== 3))) {
    const what = `bit depth ${depth} with color type ${colorType}`
    throw new Error(`unsupported PNG: ${what} (8-bit, or 16-bit without a palette, only)`)
  }
  return { width, height, depth, colorType }
}

/**
 * Decode a PNG to 8-bit samples. Gray, gray+alpha, RGB and RGBA come back with 1, 2, 3 and 4
 * channels; a palette image is expanded to RGB, or RGBA when it has a tRNS chunk. 16-bit samples
 * keep their high byte. Interlaced (Adam7) and 1/2/4-bit images are refused.
 */
export function decodePng(bytes: Uint8Array): RasterImage {
  const png = readChunks(bytes)
  const { width, height, depth, colorType } = png
  const samples = SAMPLES[colorType]!
  const bpp = samples * (depth / 8) // bytes per pixel: how far back the filters' "left" byte is
  const stride = width * bpp
  let inflated: Uint8Array
  try {
    inflated = inflateSync(png.idat.length === 1 ? png.idat[0]! : Buffer.concat(png.idat))
  } catch (err) {
    throw new Error(`corrupt PNG: the image data does not inflate (${(err as Error).message})`)
  }
  if (inflated.length < height * (stride + 1)) {
    throw new Error('truncated PNG: the image data is short')
  }
  const raw = unfilter(inflated, height, stride, bpp)
  if (colorType === 3) return expandPalette(raw, width, height, png.palette!, png.trns)
  if (depth === 8) return { width, height, channels: samples, data: raw }
  const data = new Uint8Array(width * height * samples)
  for (let i = 0; i < data.length; i++) data[i] = raw[2 * i]! // big-endian: the high byte is first
  return { width, height, channels: samples, data }
}

/**
 * Undo the per-row filters. Each row starts with a filter type byte; every byte after it is the
 * difference from a prediction made from decoded bytes: a (the same channel one pixel left),
 * b (above) and c (above-left), all 0 off the image. Uint8Array stores modulo 256, which is
 * exactly PNG's byte arithmetic.
 */
function unfilter(z: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const raw = new Uint8Array(height * stride)
  const zero = new Uint8Array(stride) // the row above the first row
  for (let y = 0; y < height; y++) {
    const s = y * (stride + 1) + 1 // filtered bytes
    const d = y * stride // decoded row
    const up = y > 0 ? raw : zero
    const u = y > 0 ? d - stride : 0
    const f = z[s - 1]!
    switch (f) {
      case 0: // None
        raw.set(z.subarray(s, s + stride), d)
        break
      case 1: // Sub: + a
        for (let i = 0; i < bpp; i++) raw[d + i] = z[s + i]!
        for (let i = bpp; i < stride; i++) raw[d + i] = z[s + i]! + raw[d + i - bpp]!
        break
      case 2: // Up: + b
        for (let i = 0; i < stride; i++) raw[d + i] = z[s + i]! + up[u + i]!
        break
      case 3: // Average: + floor((a + b) / 2), summed before halving so it cannot wrap
        for (let i = 0; i < bpp; i++) raw[d + i] = z[s + i]! + (up[u + i]! >> 1)
        for (let i = bpp; i < stride; i++) {
          raw[d + i] = z[s + i]! + ((raw[d + i - bpp]! + up[u + i]!) >> 1)
        }
        break
      case 4: // Paeth. In the first pixel a = c = 0, which always makes the prediction b.
        for (let i = 0; i < bpp; i++) raw[d + i] = z[s + i]! + up[u + i]!
        for (let i = bpp; i < stride; i++) {
          raw[d + i] = z[s + i]! + paeth(raw[d + i - bpp]!, up[u + i]!, up[u + i - bpp]!)
        }
        break
      default:
        throw new Error(`corrupt PNG: unknown filter type ${f} on row ${y}`)
    }
  }
  return raw
}

/** Of a (left), b (above) and c (above-left), the one nearest p = a + b - c; ties go a, b, c. */
function paeth(a: number, b: number, c: number): number {
  const pa = Math.abs(b - c) // |p - a|
  const pb = Math.abs(a - c) // |p - b|
  const pc = Math.abs(a + b - 2 * c) // |p - c|
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function expandPalette(
  index: Uint8Array,
  width: number,
  height: number,
  palette: Uint8Array,
  trns: Uint8Array | null,
): RasterImage {
  const channels = trns ? 4 : 3
  // Index → color table. Entries past PLTE's end stay black, past tRNS's end opaque.
  const lut = new Uint8Array(256 * channels)
  for (let e = 0; e < 256; e++) {
    if (3 * e < palette.length) lut.set(palette.subarray(3 * e, 3 * e + 3), e * channels)
    if (trns) lut[e * channels + 3] = e < trns.length ? trns[e]! : 255
  }
  const data = new Uint8Array(index.length * channels)
  for (let i = 0, o = 0; i < index.length; i++) {
    const e = index[i]! * channels
    for (let c = 0; c < channels; c++) data[o++] = lut[e + c]!
  }
  return { width, height, channels, data }
}

// ---------------------------------------------------------------------------------------------
// Encoding

/**
 * Encode as an 8-bit PNG (gray, gray+alpha, RGB or RGBA by channel count): signature, IHDR, one
 * IDAT, IEND. `level` is zlib's 0–9, default 6.
 */
export function encodePng(img: RasterImage, opts?: { level?: number }): Uint8Array {
  checkImage(img, 'encodePng')
  const level = opts?.level ?? 6
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new Error(`encodePng: level must be a whole number from 0 to 9, got ${level}`)
  }
  const ihdr = new Uint8Array(13) // compression, filter method and interlace all stay 0
  putU32(ihdr, 0, img.width)
  putU32(ihdr, 4, img.height)
  ihdr[8] = 8
  ihdr[9] = COLOR_TYPE[img.channels]
  const idat = deflateSync(filterRows(img), { level })
  const out = new Uint8Array(SIGNATURE.length + 3 * 12 + ihdr.length + idat.length)
  out.set(SIGNATURE)
  let pos = putChunk(out, SIGNATURE.length, 'IHDR', ihdr)
  pos = putChunk(out, pos, 'IDAT', idat)
  putChunk(out, pos, 'IEND', new Uint8Array(0))
  return out
}

/** Write length, type, data and CRC at `pos`; returns the position after the chunk. */
function putChunk(out: Uint8Array, pos: number, type: string, data: Uint8Array): number {
  putU32(out, pos, data.length)
  for (let i = 0; i < 4; i++) out[pos + 4 + i] = type.charCodeAt(i)
  out.set(data, pos + 8)
  const end = pos + 8 + data.length
  putU32(out, end, crc32(out, pos + 4, end))
  return end + 4
}

/**
 * Filter each row for deflate. Strategy: adaptive per row by minimum sum of absolute differences
 * (libpng's heuristic). Every row is scored under all five filters, reading each output byte as
 * signed (so 255 costs 1, like -1), and keeps the cheapest. Residuals near zero are what deflate
 * compresses best.
 */
function filterRows(img: RasterImage): Uint8Array {
  const { width, height, channels: bpp, data: px } = img
  const stride = width * bpp
  const out = new Uint8Array(height * (stride + 1))
  const zero = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const r = y * stride
    const up = y > 0 ? px : zero
    const u = y > 0 ? r - stride : 0
    let none = 0
    let sub = 0
    let above = 0
    let average = 0
    let paethSum = 0
    for (let i = 0; i < stride; i++) {
      const x = px[r + i]!
      const a = i < bpp ? 0 : px[r + i - bpp]!
      const b = up[u + i]!
      const c = i < bpp ? 0 : up[u + i - bpp]!
      none += abs8(x)
      sub += abs8(x - a)
      above += abs8(x - b)
      average += abs8(x - ((a + b) >> 1))
      paethSum += abs8(x - paeth(a, b, c))
    }
    const costs = [none, sub, above, average, paethSum] // in filter-type order
    const f = costs.indexOf(Math.min(...costs)) // the first minimum, so ties go to the simpler
    const o = y * (stride + 1)
    out[o] = f
    for (let i = 0; i < stride; i++) {
      const a = i < bpp ? 0 : px[r + i - bpp]!
      const c = i < bpp ? 0 : up[u + i - bpp]!
      out[o + 1 + i] = px[r + i]! - predict(f, a, up[u + i]!, c)
    }
  }
  return out
}

/** A residual's cost: its low byte read as a signed byte, made positive. */
function abs8(v: number): number {
  const s = (v << 24) >> 24
  return s < 0 ? -s : s
}

function predict(f: number, a: number, b: number, c: number): number {
  return f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0
}

// ---------------------------------------------------------------------------------------------
// Resampling

/**
 * Weights along one axis, computed once per resize: output pixel o blends `count[o]` consecutive
 * source pixels from `start[o]`, weighted by `weights[offset[o] + k]`.
 */
interface Taps {
  start: Int32Array
  count: Int32Array
  offset: Int32Array
  weights: Float64Array
  /** The largest count: how many source rows the vertical pass needs at once. */
  span: number
}

function axisTaps(src: number, dst: number): Taps {
  const start = new Int32Array(dst)
  const count = new Int32Array(dst)
  const offset = new Int32Array(dst)
  const weights = new Float64Array(src + 2 * dst) // more than either filter can use
  let n = 0
  let span = 1
  for (let o = 0; o < dst; o++) {
    offset[o] = n
    if (dst <= src) {
      // Area: output o covers the source span [o·src/dst, (o+1)·src/dst). Counted in units of
      // 1/dst that is [o·src, (o+1)·src) and source pixel i is [i·dst, (i+1)·dst), so every
      // overlap is a whole number: each weight is exactly overlap / src, and they sum to 1.
      const lo = o * src
      const hi = lo + src
      const first = Math.floor(lo / dst)
      const last = Math.ceil(hi / dst)
      for (let i = first; i < last; i++) {
        weights[n++] = (Math.min(hi, (i + 1) * dst) - Math.max(lo, i * dst)) / src
      }
      start[o] = first
      count[o] = last - first
    } else {
      // Bilinear, pixel centers aligned: output o samples source position (o + ½)·src/dst - ½,
      // clamped to the edge pixels. Scaled by 2·dst the position is a whole number.
      const pos = (2 * o + 1) * src - dst
      let i = pos > 0 ? Math.floor(pos / (2 * dst)) : 0
      let frac = pos > 0 ? (pos - i * 2 * dst) / (2 * dst) : 0
      if (i >= src - 1) {
        i = src - 1
        frac = 0
      }
      start[o] = i
      weights[n++] = 1 - frac
      if (frac > 0) weights[n++] = frac
      count[o] = frac > 0 ? 2 : 1
    }
    span = Math.max(span, count[o]!)
  }
  return { start, count, offset, weights, span }
}

/**
 * Area-average when shrinking a dimension, bilinear when enlarging it; any target size >= 1.
 *
 * Separable, horizontal then vertical. Each source row is resampled horizontally once, into a
 * small ring of float rows that holds just what the current output row needs, so there is no
 * image-sized intermediate, and nothing is rounded until the end: an exact 2:1 shrink matches
 * `halve` bit for bit.
 */
export function resize(img: RasterImage, width: number, height: number): RasterImage {
  checkImage(img, 'resize')
  checkSize(width, height, 'resize')
  const { width: sw, height: sh, channels: ch, data: src } = img
  if (width === sw && height === sh) return { width, height, channels: ch, data: src.slice() }
  const xs = axisTaps(sw, width)
  const ys = axisTaps(sh, height)
  const yw = ys.weights
  const rowLen = width * ch
  const ring = new Float32Array(ys.span * rowLen)
  const rows = new Int32Array(ys.span) // ring offsets of the current output row's source rows
  const out = new Uint8Array(height * rowLen)
  let next = 0 // the next source row to resample horizontally
  for (let y = 0; y < height; y++) {
    const first = ys.start[y]!
    const n = ys.count[y]!
    const w0 = ys.offset[y]!
    // Rows come in order, and a row is evicted only once no later output row reads it.
    for (; next < first + n; next++) {
      horizontal(src, next * sw * ch, ch, xs, ring, (next % ys.span) * rowLen)
    }
    for (let k = 0; k < n; k++) rows[k] = ((first + k) % ys.span) * rowLen
    const o = y * rowLen
    for (let i = 0; i < rowLen; i++) {
      let acc = 0
      for (let k = 0; k < n; k++) acc += ring[rows[k]! + i]! * yw[w0 + k]!
      out[o + i] = acc + 0.5 // a blend of 0–255 values, and the store truncates: round half up
    }
  }
  return { width, height, channels: ch, data: out }
}

/** Resample the source row at src[s…] horizontally into ring[d…]. */
function horizontal(
  src: Uint8Array,
  s: number,
  ch: number,
  xs: Taps,
  ring: Float32Array,
  d: number,
): void {
  const { start, count, offset, weights } = xs
  for (let x = 0; x < start.length; x++) {
    const n = count[x]!
    const w0 = offset[x]!
    const p0 = s + start[x]! * ch
    for (let c = 0; c < ch; c++) {
      let acc = 0
      for (let k = 0, p = p0 + c; k < n; k++, p += ch) acc += src[p]! * weights[w0 + k]!
      ring[d++] = acc
    }
  }
}

export function crop(
  img: RasterImage,
  x: number,
  y: number,
  width: number,
  height: number,
): RasterImage {
  checkImage(img, 'crop')
  checkSize(width, height, 'crop')
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x + width > img.width ||
    y + height > img.height
  ) {
    throw new Error(
      `crop: ${width}x${height} at (${x}, ${y}) does not fit inside ${img.width}x${img.height}`,
    )
  }
  const ch = img.channels
  const rowLen = width * ch
  const out = new Uint8Array(height * rowLen)
  for (let r = 0; r < height; r++) {
    const s = ((y + r) * img.width + x) * ch
    out.set(img.data.subarray(s, s + rowLen), r * rowLen)
  }
  return { width, height, channels: ch, data: out }
}

/** Exact 2:1 box downscale (floor of odd dimensions). */
export function halve(img: RasterImage): RasterImage {
  checkImage(img, 'halve')
  const { width, height, channels: ch, data } = img
  const w = width >> 1
  const h = height >> 1
  if (w < 1 || h < 1) throw new Error(`halve: needs at least 2x2 pixels, got ${width}x${height}`)
  const stride = width * ch
  const out = new Uint8Array(w * h * ch)
  let o = 0
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * stride
    const r1 = r0 + stride
    for (let x = 0; x < w; x++) {
      for (let c = 0, p = 2 * x * ch; c < ch; c++, p++) {
        out[o++] =
          (data[r0 + p]! + data[r0 + p + ch]! + data[r1 + p]! + data[r1 + p + ch]! + 2) >> 2
      }
    }
  }
  return { width: w, height: h, channels: ch, data: out }
}

/** Scale to cover width×height, keeping aspect, then center-crop to exactly width×height. */
export function coverResize(img: RasterImage, width: number, height: number): RasterImage {
  checkImage(img, 'coverResize')
  checkSize(width, height, 'coverResize')
  // Cross-multiplied, so equal aspect ratios compare exactly. When the target is relatively
  // wider its width binds and the scaled height overflows; otherwise the reverse.
  const wider = width * img.height >= height * img.width
  const sw = wider ? width : Math.max(width, Math.round((img.width * height) / img.height))
  const sh = wider ? Math.max(height, Math.round((img.height * width) / img.width)) : height
  const scaled = resize(img, sw, sh)
  if (sw === width && sh === height) return scaled
  return crop(scaled, (sw - width) >> 1, (sh - height) >> 1, width, height)
}

// ---------------------------------------------------------------------------------------------
// Inspection

/**
 * Width and height from a PNG, JPEG or WebP header, without decoding pixels; null for anything
 * else. JPEG dimensions are as stored: an EXIF orientation is not applied.
 */
export function readImageSize(
  bytes: Uint8Array,
): { width: number; height: number; format: 'png' | 'jpeg' | 'webp' } | null {
  if (
    bytes.length >= 24 &&
    SIGNATURE.every((v, i) => bytes[i] === v) &&
    fourcc(bytes, 12) === 'IHDR'
  ) {
    const width = u32(bytes, 16)
    const height = u32(bytes, 20)
    return width > 0 && height > 0 ? { width, height, format: 'png' } : null
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes)
  if (bytes.length >= 16 && fourcc(bytes, 0) === 'RIFF' && fourcc(bytes, 8) === 'WEBP') {
    return webpSize(bytes)
  }
  return null
}

/** Walk the marker segments to the first frame header (SOFn), which holds the size. */
function jpegSize(b: Uint8Array): { width: number; height: number; format: 'jpeg' } | null {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null // lost the marker chain
    const m = b[i + 1]!
    if (m === 0xff) {
      i++ // fill byte before a marker
      continue
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2 // TEM, RSTn and SOI stand alone, with no length
      continue
    }
    if (m === 0xd9 || m === 0xda) return null // EOI, or a scan before any frame header
    // SOF0–SOF15, except C4 (DHT), C8 (JPG) and CC (DAC), which share the range.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return null
      const height = (b[i + 5]! << 8) | b[i + 6]! // after length (2) and sample precision (1)
      const width = (b[i + 7]! << 8) | b[i + 8]!
      return width > 0 && height > 0 ? { width, height, format: 'jpeg' } : null
    }
    const length = (b[i + 2]! << 8) | b[i + 3]! // counts its own two bytes
    if (length < 2) return null
    i += 2 + length
  }
  return null
}

/** The first chunk after RIFF/WEBP: VP8 (lossy), VP8L (lossless) or VP8X (extended). */
function webpSize(b: Uint8Array): { width: number; height: number; format: 'webp' } | null {
  const le = (i: number, n: number) => {
    let v = 0
    for (let k = n - 1; k >= 0; k--) v = v * 256 + b[i + k]!
    return v
  }
  const chunk = fourcc(b, 12) // its 4-byte size follows; the payload starts at 20
  let width = 0
  let height = 0
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    // A 3-byte frame tag and the start code, then 14-bit width and height (the top 2 bits scale).
    width = le(26, 2) & 0x3fff
    height = le(28, 2) & 0x3fff
  } else if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    // The 0x2F signature, then width - 1 and height - 1 as 14-bit fields, least significant first.
    const bits = le(21, 4)
    width = (bits & 0x3fff) + 1
    height = ((bits >>> 14) & 0x3fff) + 1
  } else if (chunk === 'VP8X' && b.length >= 30) {
    // Flags and 3 reserved bytes, then canvas width - 1 and height - 1, 24-bit little-endian.
    width = le(24, 3) + 1
    height = le(27, 3) + 1
  }
  return width > 0 && height > 0 ? { width, height, format: 'webp' } : null
}

/** Standard deviation below which a sample grid counts as one flat color. */
const BLANK_STDDEV = 2

/**
 * True when the image is (nearly) one flat color, e.g. luma stddev < 2 over a sample grid.
 *
 * At most 64×64 evenly spaced pixels are sampled. Luma is BT.601 (gray images use the gray
 * value); when there is alpha, it must be flat too.
 */
export function isBlank(img: RasterImage): boolean {
  checkImage(img, 'isBlank')
  const { width, height, channels: ch, data } = img
  const nx = Math.min(64, width)
  const ny = Math.min(64, height)
  const hasAlpha = ch === 2 || ch === 4
  let sum = 0
  let sumSq = 0
  let alphaSum = 0
  let alphaSq = 0
  for (let j = 0; j < ny; j++) {
    const y = Math.floor(((2 * j + 1) * height) / (2 * ny)) // the middle of grid row j
    for (let i = 0; i < nx; i++) {
      const p = (y * width + Math.floor(((2 * i + 1) * width) / (2 * nx))) * ch
      const luma =
        ch >= 3 ? 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]! : data[p]!
      sum += luma
      sumSq += luma * luma
      if (hasAlpha) {
        const a = data[p + ch - 1]!
        alphaSum += a
        alphaSq += a * a
      }
    }
  }
  const n = nx * ny
  const flat = (s: number, sq: number) => sq / n - (s / n) ** 2 < BLANK_STDDEV ** 2
  return flat(sum, sumSq) && (!hasAlpha || flat(alphaSum, alphaSq))
}
