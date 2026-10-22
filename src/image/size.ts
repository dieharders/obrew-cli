/**
 * From what the caller asked for (`--aspect 16:9`, `--size 1920x1080`, `--upscale 2`) to what the
 * model generates and what is done to it afterwards.
 *
 * Models generate in multiples of 16, up to about two megapixels. Hosts want other things:
 * MotionBuff composes at 1920×1080, and 1080 is not a multiple of 16. In order of preference:
 *
 *  1. a size the model can make directly (aligned, within the preset's pixel limit) is made;
 *  2. a size that fits once rounded UP to the alignment is made at that size and centre-cropped
 *     by the few extra pixels — 1920×1080 is generated at 1920×1088 and loses 4 rows top and
 *     bottom. Real detail, no upscaler: ESRGAN ×4 of a 1280×720 image takes ~4 minutes on an
 *     Apple M4 (measured), and 1.5× through a ×4 model computes 16× the pixels it keeps;
 *  3. anything larger (4K, say) is generated at the closest native size with the same aspect
 *     ratio, upscaled ×4 by ESRGAN and resampled — scaled to cover, centre-cropped if the aspect
 *     differs — to EXACTLY the size asked for.
 *
 * `--upscale 4` is ESRGAN's own ×4; `--upscale 2` is ×4 followed by an exact 2:1 box filter.
 */
import { ObrewError } from '../shared/errors'

export const ASPECTS = {
  '1:1': [1024, 1024],
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '21:9': [1568, 672],
} as const
export type Aspect = keyof typeof ASPECTS
export const ASPECT_NAMES = Object.keys(ASPECTS) as Aspect[]

export interface Size {
  width: number
  height: number
}

/** sd-server's own bounds on a generated side, and on an upscaled one. */
export const MIN_SIDE = 64
export const MAX_SIDE = 4096
export const MAX_UPSCALED_SIDE = 8192

export function parseSize(text: string): Size {
  const m = text.trim().match(/^(\d+)\s*[x×*]\s*(\d+)$/i)
  if (!m) throw new ObrewError('bad_request', `--size expects WIDTHxHEIGHT, e.g. 1280x720, got "${text}"`)
  const size = { width: Number(m[1]), height: Number(m[2]) }
  if (size.width < 16 || size.height < 16 || size.width > MAX_UPSCALED_SIDE || size.height > MAX_UPSCALED_SIDE) {
    throw new ObrewError('bad_request', `--size ${text} is outside 16..${MAX_UPSCALED_SIDE} per side`)
  }
  return size
}

/** The native size closest to one megapixel with this aspect ratio, aligned and within limits. */
export function nativeFor(ratio: number, align: number, maxPixels: number): Size {
  const area = Math.min(1024 * 1024, maxPixels)
  const h = Math.sqrt(area / ratio)
  const w = h * ratio
  const fit = (n: number) => Math.max(MIN_SIDE, Math.min(MAX_SIDE, n))
  const rounded = { width: fit(Math.round(w / align) * align), height: fit(Math.round(h / align) * align) }
  if (rounded.width * rounded.height <= maxPixels) return rounded
  // Rounding crossed the limit: round both sides down instead, which keeps the aspect ratio
  // (w × h is exactly `area`, so the product cannot exceed it).
  return { width: fit(Math.floor(w / align) * align), height: fit(Math.floor(h / align) * align) }
}

const native = (s: Size, align: number, maxPixels: number) =>
  s.width % align === 0 && s.height % align === 0 && s.width * s.height <= maxPixels && s.width >= MIN_SIDE && s.height >= MIN_SIDE && s.width <= MAX_SIDE && s.height <= MAX_SIDE

export interface SizePlan {
  /** What the model generates. */
  gen: Size
  /** What the caller gets. */
  final: Size
  /** ESRGAN passes (×4 each) before resampling; 0 = none. */
  upscalePasses: number
  /** Whether the result is resampled to `final` after any upscale. */
  resample: boolean
}

export interface PlanInput {
  aspect?: Aspect
  size?: Size
  upscale?: 2 | 4
  /** An input image's size, for img2img and edits with no size or aspect given. */
  like?: Size
  align: number
  maxPixels: number
  /** The upscaler's factor (4 for Real-ESRGAN x4plus). */
  scale?: number
}

export function planSize(o: PlanInput): SizePlan {
  const scale = o.scale ?? 4
  if (o.size && o.upscale) throw new ObrewError('bad_request', '--size and --upscale cannot be combined; --size alone upscales when it has to')
  if (o.size && o.aspect) throw new ObrewError('bad_request', '--size and --aspect cannot be combined')

  if (o.size) {
    if (native(o.size, o.align, o.maxPixels)) return { gen: o.size, final: o.size, upscalePasses: 0, resample: false }
    const up = (n: number) => Math.ceil(n / o.align) * o.align
    const rounded = { width: up(o.size.width), height: up(o.size.height) }
    if (native(rounded, o.align, o.maxPixels)) return { gen: rounded, final: o.size, upscalePasses: 0, resample: true }
    const gen = nativeFor(o.size.width / o.size.height, o.align, o.maxPixels)
    const grows = o.size.width > gen.width || o.size.height > gen.height
    const plan = { gen, final: o.size, upscalePasses: grows ? 1 : 0, resample: true }
    checkUpscaled(plan, scale)
    return plan
  }

  const gen = o.aspect
    ? (() => {
        const [w, h] = ASPECTS[o.aspect]
        const s = { width: w, height: h }
        return native(s, o.align, o.maxPixels) ? s : nativeFor(w / h, o.align, o.maxPixels)
      })()
    : o.like
      ? // An input the model can make as it is keeps its size: an edit of a 1280×720 still
        // is 1280×720. Otherwise its aspect ratio at the native area.
        native(o.like, o.align, o.maxPixels)
        ? o.like
        : nativeFor(o.like.width / o.like.height, o.align, o.maxPixels)
      : nativeFor(1, o.align, o.maxPixels)
  if (!o.upscale) return { gen, final: gen, upscalePasses: 0, resample: false }
  const plan = { gen, final: { width: gen.width * o.upscale, height: gen.height * o.upscale }, upscalePasses: 1, resample: o.upscale !== scale }
  checkUpscaled(plan, scale)
  return plan
}

function checkUpscaled(plan: SizePlan, scale: number): void {
  if (plan.upscalePasses === 0) return
  const w = plan.gen.width * scale
  const h = plan.gen.height * scale
  if (w > MAX_UPSCALED_SIDE || h > MAX_UPSCALED_SIDE) {
    throw new ObrewError('bad_request', `upscaling ${plan.gen.width}×${plan.gen.height} ×${scale} exceeds ${MAX_UPSCALED_SIDE} px per side`)
  }
}
