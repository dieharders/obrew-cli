/**
 * `<data>/image/config.json` — the image engine's few settings, kept apart from the text
 * engine's `config.json` (whose schema would drop them on its next save; see ../image/paths.ts).
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { imageConfigPath } from './paths'
import { IMAGE_VARIANTS } from './engine/variant'

export const ImageConfigSchema = z.object({
  /** Build to use. Set by `obrew image engine install` / `setup`; auto-detected when absent. */
  variant: z.enum(IMAGE_VARIANTS).optional(),
  /** How long the warm sd-server may sit idle before a later run stops it. */
  idleTtlMs: z.number().int().positive().optional(),
})
export type ImageConfig = z.infer<typeof ImageConfigSchema>

export async function loadImageConfig(): Promise<ImageConfig> {
  const file = Bun.file(imageConfigPath())
  if (!(await file.exists())) return {}
  const parsed = ImageConfigSchema.safeParse(await file.json())
  if (!parsed.success) throw new Error(`image/config.json is malformed: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  return parsed.data
}

export async function saveImageConfig(config: ImageConfig): Promise<void> {
  const path = imageConfigPath()
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(config, null, 2) + '\n')
}
