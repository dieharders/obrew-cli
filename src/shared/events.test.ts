import { describe, expect, test } from 'bun:test'
import { ExecEventSchema } from './events'

describe('ExecEventSchema', () => {
  test('accepts every member the host maps', () => {
    const ok = [
      { type: 'session', sessionId: 'abc', model: 'm', engine: { tag: 'b1', variant: 'cpu', port: 1 } },
      { type: 'engine.status', state: 'loading' },
      { type: 'reasoning.start' },
      { type: 'delta', text: 'hi' },
      { type: 'tool.start', id: 'c', name: 'Read' },
      { type: 'tool.result', id: 'c', name: 'Read', ok: true, durationMs: 1, bytes: 2 },
      { type: 'turn.completed', sessionId: 'abc', durationMs: 5, iterations: 1, usage: null, stopReason: 'stop' },
      { type: 'turn.failed', code: 'model_missing', message: 'x' },
      { type: 'download.progress', file: 'f', received: 1, total: 2 },
      { type: 'setup.done', ok: true, message: 'ready' },
    ]
    for (const e of ok) expect(ExecEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true)
  })

  test('rejects an unknown failure code and an unknown type', () => {
    expect(ExecEventSchema.safeParse({ type: 'turn.failed', code: 'boom', message: '' }).success).toBe(false)
    expect(ExecEventSchema.safeParse({ type: 'nope' }).success).toBe(false)
  })
})
