/**
 * llama-server streams `data: {json}` lines terminated by `data: [DONE]`. Port of the
 * inline parser in obrew-engine's `_chat_generator`, on top of the chunk-safe line reader.
 * Lines that are not `data:` (comments, `event:`) are ignored; a `data:` line that is not
 * JSON is skipped rather than fatal, matching the Python.
 */
import { readLines } from '../shared/ndjson'

export async function* parseSseJson<T = unknown>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of readLines(stream)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return
    try {
      yield JSON.parse(payload) as T
    } catch {
      // Not JSON; skip.
    }
  }
}
