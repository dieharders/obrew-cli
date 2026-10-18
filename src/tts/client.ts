/**
 * The speech request as obrew accepts it, and the thin client to a `tts-server`.
 *
 * OpenAI's `/v1/audio/speech` shape, plus the fields qwentts.cpp honours. `model` names a
 * voice pack rather than an OpenAI model. `response_format` defaults to `pcm` because the
 * caller this exists for is a character that starts talking on the first chunk; `wav` is for
 * files. `speed` is accepted and ignored upstream (no time-stretch in the engine); `stream` is
 * accepted for OpenAI-client compatibility and means nothing — pcm always streams.
 */
import { z } from 'zod'

export const SpeechRequestSchema = z.object({
  input: z.string().min(1).max(4000),
  /** A voice pack id. Absent = the active pack. */
  model: z.string().optional(),
  /** A named speaker (customvoice packs) or a registered clone. Absent = the engine's default. */
  voice: z.string().optional(),
  /** Language name or code; `auto` lets the model decide. */
  language: z.string().optional(),
  response_format: z.enum(['pcm', 'wav']).default('pcm'),
  speed: z.number().positive().optional(),
  stream: z.boolean().optional(),
  /** VoiceDesign packs: the voice described in words. */
  instructions: z.string().max(500).optional(),
  seed: z.number().int().optional(),
  temperature: z.number().min(0).optional(),
  top_k: z.number().int().min(0).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  repetition_penalty: z.number().gt(0).optional(),
  max_new_tokens: z.number().int().positive().optional(),
})
export type SpeechRequest = z.infer<typeof SpeechRequestSchema>

/** What the engine produces for `pcm`; sent as headers so a player need not assume them. */
export const PCM_SAMPLE_RATE = 24_000
export const PCM_HEADERS: Record<string, string> = {
  'x-sample-rate': String(PCM_SAMPLE_RATE),
  'x-channels': '1',
  'x-format': 's16le',
}

/** The upstream body: obrew's own fields (`model`, `stream`) removed, the rest passed through. */
export function upstreamBody(req: SpeechRequest): Record<string, unknown> {
  const { model: _model, stream: _stream, ...rest } = req
  return rest
}

export async function speech(baseUrl: string, req: SpeechRequest, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upstreamBody(req)),
    signal,
  })
}

export interface EngineVoice {
  name: string
  kind: 'speaker' | 'registered' | string
}

export async function listVoices(baseUrl: string, signal?: AbortSignal): Promise<EngineVoice[]> {
  const res = await fetch(`${baseUrl}/v1/audio/voices`, { signal: signal ?? AbortSignal.timeout(5000) })
  if (!res.ok) return []
  const body = (await res.json().catch(() => null)) as { voices?: EngineVoice[] } | null
  return body?.voices ?? []
}
