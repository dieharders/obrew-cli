/**
 * HTTP client for one sd-server, through its native async API (`/sdcpp/v1/...`): only what obrew
 * uses, parsed loosely — required fields only, everything else passed through — because the
 * server is pinned but still grows fields between releases.
 *
 * Why the native API rather than the OpenAI-compatible `/v1/images/generations` the server also
 * has: that one answers once, at the end. The job API reports queue position, the step, a
 * preview frame, and cancels ONE job (`POST /sdcpp/v1/jobs/{id}/cancel`) — where llama-server's
 * cancel erases a shared slot, this one cannot touch another caller's work.
 *
 * `ImageBackend` is the seam `generate.ts` talks to. sd-server is the only implementation; a
 * second one (a user's own ComfyUI, say) would implement the same five calls.
 */
import { z } from 'zod'

export const ModelStatusSchema = z
  .object({
    state: z.enum(['empty', 'loading', 'ready', 'error']),
    error: z.string().nullable().optional(),
    origin: z.string().optional(),
    load_elapsed_seconds: z.number().nullable().optional(),
  })
  .passthrough()
export type ModelStatus = z.infer<typeof ModelStatusSchema>

const ImageOut = z.object({ index: z.number().optional(), b64_json: z.string() })

export const JobSchema = z
  .object({
    id: z.string(),
    status: z.enum(['queued', 'generating', 'completed', 'failed', 'cancelled']),
    queue_position: z.number().optional(),
    started: z.number().nullable().optional(),
    completed: z.number().nullable().optional(),
    result: z.object({ output_format: z.string().optional(), images: z.array(ImageOut) }).passthrough().nullable().optional(),
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().nullable().optional(),
    preview: z
      .object({ pass: z.number().optional(), step: z.number(), total_steps: z.number(), b64_json: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
export type Job = z.infer<typeof JobSchema>

export const UpscaleResultSchema = z
  .object({
    images: z.array(ImageOut),
    upscaler: z.string(),
    scale: z.number(),
    width: z.number(),
    height: z.number(),
    output_format: z.string().optional(),
  })
  .passthrough()
export type UpscaleResult = z.infer<typeof UpscaleResultSchema>

export interface ImgGenRequest {
  prompt: string
  negative_prompt?: string
  width: number
  height: number
  seed: number
  batch_count: number
  sample_params: { sample_steps: number; sample_method?: string; guidance: { txt_cfg: number } }
  init_image?: string
  strength?: number
  ref_images?: string[]
  preview: 'none' | 'proj' | 'tae' | 'vae'
  preview_interval?: number
  output_format: 'png' | 'jpeg' | 'webp'
}

export interface UpscaleRequest {
  image: string
  upscaler?: string
  repeats?: number
  output_format?: 'png' | 'jpeg' | 'webp'
}

/** A non-2xx answer, with sd-server's own error code (`model_loading`, `model_not_loaded`, …). */
export class SdHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'SdHttpError'
  }
}

export interface ImageBackend {
  readonly baseUrl: string
  /** null = not answering (starting, or gone). */
  modelStatus(signal?: AbortSignal): Promise<ModelStatus | null>
  submit(req: ImgGenRequest, signal?: AbortSignal): Promise<string>
  job(id: string, signal?: AbortSignal): Promise<Job>
  cancel(id: string): Promise<void>
  upscale(req: UpscaleRequest, signal?: AbortSignal): Promise<UpscaleResult>
}

async function failure(res: Response, what: string): Promise<SdHttpError> {
  const text = await res.text().catch(() => '')
  let code: string | null = null
  let message = text.slice(0, 500)
  try {
    const body = JSON.parse(text) as { error?: unknown; code?: unknown; message?: unknown }
    if (typeof body.code === 'string') code = body.code
    const err = body.error
    if (typeof err === 'string') message = err
    else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') message = (err as { message: string }).message
    else if (typeof body.message === 'string') message = body.message
  } catch {
    // Not JSON: keep the text.
  }
  return new SdHttpError(res.status, code, `${what}: HTTP ${res.status}${message ? ` ${message}` : ''}`)
}

export class SdClient implements ImageBackend {
  constructor(readonly baseUrl: string) {}

  async modelStatus(signal?: AbortSignal): Promise<ModelStatus | null> {
    try {
      const res = await fetch(`${this.baseUrl}/sdcpp/v1/models/status`, { signal: signal ?? AbortSignal.timeout(2000) })
      if (!res.ok) return null
      const parsed = ModelStatusSchema.safeParse(await res.json())
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  async submit(req: ImgGenRequest, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/sdcpp/v1/img_gen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    })
    if (res.status !== 202 && !res.ok) throw await failure(res, 'image job rejected')
    const body = (await res.json()) as { id?: unknown }
    if (typeof body.id !== 'string') throw new SdHttpError(res.status, null, 'image job accepted without an id')
    return body.id
  }

  async job(id: string, signal?: AbortSignal): Promise<Job> {
    const res = await fetch(`${this.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(id)}`, { signal: signal ?? AbortSignal.timeout(10_000) })
    if (!res.ok) throw await failure(res, `image job ${id}`)
    return JobSchema.parse(await res.json())
  }

  async cancel(id: string): Promise<void> {
    // Best effort: a job that already finished answers 409/410, which is fine.
    await fetch(`${this.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {})
  }

  async upscale(req: UpscaleRequest, signal?: AbortSignal): Promise<UpscaleResult> {
    const res = await fetch(`${this.baseUrl}/sdcpp/v1/upscale`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    })
    if (!res.ok) throw await failure(res, 'upscale')
    return UpscaleResultSchema.parse(await res.json())
  }
}
