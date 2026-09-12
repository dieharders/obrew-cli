/**
 * `--image <path>`: attach images to the prompt as OpenAI `image_url` parts (base64 data
 * URLs), the shape llama-server's multimodal chat takes when the model was loaded with an
 * mmproj. Port of `vision_completion` in obrew-engine's llama_server.py; the Pillow
 * pre-processing is dropped because llama.cpp's mtmd resizes on its own.
 */
import { extname } from 'node:path'
import { ObrewError } from '../shared/errors'
import type { ContentPart, ImagePart } from './messages'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}
const MAX_BYTES = 20 * 1024 * 1024

export async function imagePart(path: string): Promise<ImagePart> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new ObrewError('bad_request', `image not found: ${path}`)
  if (file.size > MAX_BYTES) throw new ObrewError('bad_request', `image too large (${file.size} bytes): ${path}`)
  const mime = MIME[extname(path).toLowerCase()]
  if (!mime) throw new ObrewError('bad_request', `unsupported image type: ${path} (png, jpg, gif, webp, bmp)`)
  const data = Buffer.from(await file.arrayBuffer()).toString('base64')
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }
}

/** The user message content: images first, then the text. */
export function userContent(text: string, images: ImagePart[]): string | ContentPart[] {
  if (images.length === 0) return text
  return [...images, { type: 'text', text }]
}

/**
 * What the transcript keeps: a marker per image rather than megabytes of base64. A resumed
 * session therefore knows an image WAS shown, not what it showed; re-attach it to ask more.
 */
export function transcriptContent(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text
  return `${imagePaths.map((p) => `[image: ${p}]`).join('\n')}\n${text}`
}
