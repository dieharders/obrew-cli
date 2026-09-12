/**
 * Split a byte stream into complete text lines.
 *
 * Copied from motionbuff/packages/shell/src/ndjson.ts. Two failure modes this exists to
 * prevent, both of which produce a silently half-broken stream rather than an honest crash:
 *
 *  1. A chunk boundary lands MID-LINE. `chunk.toString().split('\n')` then hands JSON.parse a
 *     fragment; a bare try/catch drops it, and the dropped line is as likely as not the one
 *     carrying the session id that every follow-up turn depends on.
 *
 *  2. A chunk boundary lands MID-UTF-8-SEQUENCE. `TextDecoder` with `{ stream: true }` holds
 *     the partial sequence back until the continuation bytes arrive. That is why the decoder is
 *     created once outside the loop, and why the final `decode()` with no argument matters.
 */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split(/\r?\n/)
      // The last element is either an incomplete line or '' — either way it is NOT ready.
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line) yield line
    }

    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail) yield tail // a final line with no trailing newline
  } finally {
    // Stop the child writing into a pipe nobody reads. Reached on an early return too — the
    // consumer abandoning the `for await` calls .return() on this generator.
    reader.cancel().catch(() => {})
  }
}
