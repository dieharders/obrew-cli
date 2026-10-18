/**
 * One transcription through llama-server's chat API: the audio as an `input_audio` part,
 * the model's answer parsed from Qwen3-ASR's format `language <Name><asr_text><text>`.
 */
import { ObrewError } from '../shared/errors'

export interface Transcription {
  text: string
  /** As the model named it ("English"), or null when it gave none. */
  language: string | null
}

/** Parse Qwen3-ASR's answer; a model that answers plainly is passed through. */
export function parseAsrAnswer(content: string): Transcription {
  const m = content.match(/^\s*language\s+([^<\n]+?)\s*<asr_text>([\s\S]*)$/i)
  if (m) return { language: m[1]!.trim() || null, text: m[2]!.replace(/<\/asr_text>\s*$/i, '').trim() }
  return { language: null, text: content.replace(/<\/?asr_text>/gi, '').trim() }
}

export async function transcribeWav(baseUrl: string, wav: Uint8Array, opts: { language?: string; signal?: AbortSignal } = {}): Promise<Transcription> {
  const content: unknown[] = [{ type: 'input_audio', input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } }]
  // A language hint is plain text alongside the audio; Qwen3-ASR detects it anyway.
  if (opts.language) content.push({ type: 'text', text: `The language is ${opts.language}.` })
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: 512, temperature: 0, stream: false }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ObrewError('engine_failed', `transcription failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return parseAsrAnswer(body.choices?.[0]?.message?.content ?? '')
}
