/**
 * The failure vocabulary.
 *
 * `turn.failed.code` is part of the wire contract with hosts: motionbuff maps
 * `engine_missing` and `model_missing` to "not signed in" (its Sign-in button runs
 * `obrew login`, which installs what is missing), `aborted`/`timeout`/`bad_request` one to
 * one, and everything else to a generic failure. Add codes here; never invent them inline.
 */
export const FAIL_CODES = [
  'engine_missing',
  'model_missing',
  'engine_failed',
  'aborted',
  'timeout',
  'bad_request',
  'tool_error',
  'max_iterations',
] as const
export type FailCode = (typeof FAIL_CODES)[number]

export class ObrewError extends Error {
  constructor(
    readonly code: FailCode,
    message: string,
  ) {
    super(message)
    this.name = 'ObrewError'
  }
}

/** A CLI usage mistake: wrong flag, missing argument. Exit code 2, never a JSON event. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const isAbortError = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')

/** The one line a host can grep on stderr, whatever else was printed. */
export const NOT_READY_HINT = 'not ready: run `obrew login`'
