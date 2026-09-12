/**
 * Server-sent-events framing. Copied from motionbuff/packages/shell/src/sse.ts.
 *
 * Used by `obrew serve` for streamed responses and by the engine client when it re-frames
 * llama-server output. Read back by fetch-stream readers, never by `EventSource`.
 */
const encoder = new TextEncoder()

/** One SSE data frame. */
export const frame = <T>(event: T): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

/**
 * A comment frame. Carries no data — its only job is to put bytes on the wire so the
 * connection is not idle. `Bun.serve({ idleTimeout })` is a ceiling as well as a floor.
 */
export const PING = encoder.encode(': ping\n\n')
export const HEARTBEAT_MS = 15_000

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const
