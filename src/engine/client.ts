/**
 * HTTP client for one llama-server. Only the endpoints obrew uses.
 *
 * `chat()` always asks the server to stream and yields normalised deltas: text, reasoning
 * (llama-server puts `<think>` output in `reasoning_content` when a reasoning format is
 * active), tool-call fragments keyed by index, and the finish reason. The caller decides
 * what to do with them; this file knows nothing about events or tools.
 */
import { ObrewError } from '../shared/errors'
import { parseSseJson } from './sse-parse'

export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export interface ChatDelta {
  content?: string
  reasoning?: string
  toolCalls?: ToolCallDelta[]
  finishReason?: string | null
  usage?: { promptTokens: number; completionTokens: number }
}

interface RawChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  error?: { message?: string; code?: number } | string
}

export interface EmbeddingResult {
  embedding: number[]
}

export class EngineClient {
  constructor(readonly baseUrl: string) {}

  /** 200 = ready, 503 = still loading, anything else / no answer = not up. */
  async health(signal?: AbortSignal): Promise<'ok' | 'loading' | 'down'> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: signal ?? AbortSignal.timeout(2000),
      })
      if (res.status === 200) return 'ok'
      if (res.status === 503) return 'loading'
      return 'down'
    } catch {
      return 'down'
    }
  }

  async props(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/props`, { signal })
    if (!res.ok) throw new ObrewError('engine_failed', `GET /props failed: HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  /**
   * POST /v1/chat/completions, streamed. The body is passed through verbatim except that
   * `stream` is forced on and usage is requested in the final chunk.
   */
  async *chat(body: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ChatDelta> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal,
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new ObrewError('engine_failed', `chat request failed: HTTP ${res.status} ${text.slice(0, 500)}`)
    }

    for await (const chunk of parseSseJson<RawChunk>(res.body)) {
      if (chunk.error) {
        const message = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'unknown')
        throw new ObrewError('engine_failed', `llama-server error: ${message}`)
      }
      const choice = chunk.choices?.[0]
      const out: ChatDelta = {}
      const delta = choice?.delta
      if (delta?.content) out.content = delta.content
      if (delta?.reasoning_content) out.reasoning = delta.reasoning_content
      if (delta?.tool_calls?.length) {
        out.toolCalls = delta.tool_calls.map((tc, i) => ({
          index: tc.index ?? i,
          ...(tc.id ? { id: tc.id } : {}),
          ...(tc.function?.name ? { name: tc.function.name } : {}),
          ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}),
        }))
      }
      if (choice?.finish_reason) out.finishReason = choice.finish_reason
      if (chunk.usage) {
        out.usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        }
      }
      if (Object.keys(out).length > 0) yield out
    }
  }

  /**
   * POST /embeddings (native endpoint). Handles the response shapes llama.cpp has used.
   * For an image, `content` carries the `[img-N]` placeholder and `imageData` the bytes —
   * llama.cpp's multimodal embedding contract (obrew-engine's image_embedder.py).
   */
  async embed(input: string, signal?: AbortSignal, imageData?: Array<{ id: number; data: string }>): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: input, ...(imageData ? { image_data: imageData } : {}) }),
      signal,
    })
    if (!res.ok) throw new ObrewError('engine_failed', `embeddings failed: HTTP ${res.status}`)
    const data = (await res.json()) as unknown
    const vec = extractEmbedding(data)
    if (!vec) throw new ObrewError('engine_failed', 'embeddings: unrecognised response shape')
    return vec
  }

  /**
   * Tell the server to stop generating now rather than draining the rest of the tokens.
   * Slot 0 because each obrew engine runs a single slot.
   */
  async eraseSlot(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/slots/0?action=erase`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      })
    } catch {
      // Best effort: the server may already be gone.
    }
  }
}

/** `{embedding:[…]}`, `[{embedding:[…]}]`, `{embedding:[[…]]}` (per-token) or a bare array. */
export function extractEmbedding(data: unknown): number[] | null {
  const pool = (v: unknown): number[] | null => {
    if (!Array.isArray(v) || v.length === 0) return null
    if (typeof v[0] === 'number') return v as number[]
    if (Array.isArray(v[0])) {
      const rows = v as number[][]
      const dim = rows[0]!.length
      const out = new Array<number>(dim).fill(0)
      for (const row of rows) for (let i = 0; i < dim; i++) out[i]! += row[i] ?? 0
      return out.map((x) => x / rows.length)
    }
    return null
  }
  if (Array.isArray(data)) {
    const first = data[0] as { embedding?: unknown } | number | undefined
    if (typeof first === 'number') return pool(data)
    if (first && typeof first === 'object') return pool(first.embedding)
    return null
  }
  if (data && typeof data === 'object' && 'embedding' in data) {
    return pool((data as { embedding: unknown }).embedding)
  }
  return null
}
