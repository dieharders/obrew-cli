/**
 * `<data>/config.json` — the few things a user sets once.
 *
 * Model choice is NOT here: the model registry (`models/registry.ts`) owns which model is the
 * default and the built-in one to fall back on, because that is where a model's existence is
 * known. This file holds what `obrew login` and `obrew engine install` need before any model
 * exists.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { configPath } from './paths'

export const VARIANTS = ['cuda', 'cpu', 'vulkan', 'metal'] as const
export type Variant = (typeof VARIANTS)[number]

export const ConfigSchema = z.object({
  /** Engine build to use. Set by `engine install`; auto-detected when absent. */
  variant: z.enum(VARIANTS).optional(),
  /** Hugging Face token for gated repos. `HF_TOKEN` in the environment wins over this. */
  hfToken: z.string().optional(),
  /** Default context window passed to llama-server. `-c ctx_size=` overrides per run. */
  ctxSize: z.number().int().positive().optional(),
  /** Registry id of the embedding model (`obrew models use --embed <id>`). */
  embedModel: z.string().optional(),
})
export type Config = z.infer<typeof ConfigSchema>

export const DEFAULT_CTX_SIZE = 16384

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(configPath())
  if (!(await file.exists())) return {}
  const parsed = ConfigSchema.safeParse(await file.json())
  if (!parsed.success) {
    throw new Error(`config.json is malformed: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }
  return parsed.data
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(config, null, 2) + '\n')
}

export function hfToken(config: Config): string | undefined {
  return process.env.HF_TOKEN ?? process.env.OBREW_HF_TOKEN ?? config.hfToken
}
