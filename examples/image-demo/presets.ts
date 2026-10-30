/**
 * The demo's use cases: the five MotionBuff asked about, each a model, an aspect ratio and some
 * prompt scaffolding. `model` is a preference; the page falls back to the default image model
 * when it is not installed (a CPU-only machine has FLUX.2 klein alone).
 */
export interface UseCase {
  id: string
  label: string
  model: 'default' | 'z-image-turbo' | 'flux2-klein-4b' | 'moss-image-sft'
  aspect: '16:9' | '1:1' | '9:16' | '4:3' | '3:4' | '21:9'
  /** Appended to the user's prompt. */
  suffix: string
  negative?: string
  hint: string
  example: string
  /** Thumbnails get a title drawn by the page, not by the model. */
  title?: boolean
}

export const USE_CASES: UseCase[] = [
  {
    id: 'thumbnail',
    label: 'Thumbnail',
    model: 'z-image-turbo',
    aspect: '16:9',
    suffix: 'cinematic wide shot, strong focal subject on the right, clean uncluttered left third for a title, dramatic lighting, no text, no letters, no logos',
    negative: 'text, letters, watermark, logo, caption',
    hint: 'The model paints the art and leaves room; the title is drawn by the page, so it is exact and editable.',
    example: 'a lone astronaut standing on a red desert planet at sunset',
    title: true,
  },
  {
    id: 'character',
    label: 'Character',
    model: 'flux2-klein-4b',
    aspect: '3:4',
    suffix: 'full-body character design, clear silhouette, consistent outfit, soft studio light, plain light-grey background',
    hint: 'Then use "Same character, new scene": the image becomes a reference and the character carries over.',
    example: 'a young inventor with goggles, a patched leather jacket and a mechanical arm',
  },
  {
    id: 'photoreal',
    label: 'Photoreal',
    model: 'z-image-turbo',
    aspect: '16:9',
    suffix: 'photorealistic, natural light, shot on a 35mm lens, shallow depth of field, high detail',
    hint: 'Z-Image-Turbo is the strongest permissive model for photorealism.',
    example: 'a fisherman mending nets on a wooden pier at dawn, mist over the water',
  },
  {
    id: 'architecture',
    label: 'Architecture',
    model: 'z-image-turbo',
    aspect: '16:9',
    suffix: 'architectural photography, wide-angle lens, clean lines, golden hour, high detail',
    hint: 'Try "Upscale ×2" on a result for a large print-ready render.',
    example: 'a timber-and-glass house cantilevered over a forest ravine',
  },
  {
    id: 'abstract',
    label: 'Abstract',
    model: 'flux2-klein-4b',
    aspect: '1:1',
    suffix: 'abstract art, bold geometric shapes, vivid complementary colours, rich texture',
    hint: 'Vary a result to explore: same reference, new seed.',
    example: 'the feeling of a summer thunderstorm',
  },
  {
    id: 'poster',
    label: 'Poster / text',
    model: 'moss-image-sft',
    aspect: '3:4',
    suffix: 'poster design, legible typography, balanced layout, high contrast',
    hint: 'MOSS-Image renders the words you quote. Install it first: obrew image models pull moss-image-sft (7.8–9.4 GB). It runs 50 steps, so it is slow on Apple Silicon: set Steps to 20 to try it.',
    example: 'a vintage travel poster for the moon with the title "LUNA EXPRESS" and the tagline "departs nightly"',
  },
]
