/**
 * The wire contract of `--json` mode: one JSON object per stdout line.
 *
 * This union is CLOSED and versioned by intent. A host (motionbuff's `obrew.ts`) maps a
 * subset of it onto its own event shape and drops the rest, so adding a member is safe and
 * changing a field name is a breaking change. Tool INPUTS are never on the wire unless the
 * caller asked with `--include-tool-io`: for a Read they are paths, for an MCP write they are
 * file contents.
 *
 * Everything that is not an event — diagnostics, progress prose, warnings — goes to stderr.
 */
import { z } from 'zod'
import { FAIL_CODES } from './errors'

const Usage = z.object({ promptTokens: z.number(), completionTokens: z.number() })

export const ExecEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session'),
    sessionId: z.string(),
    model: z.string(),
    engine: z.object({ tag: z.string(), variant: z.string(), port: z.number() }),
  }),
  z.object({
    type: z.literal('engine.status'),
    state: z.enum(['starting', 'loading', 'ready']),
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal('reasoning.start') }),
  z.object({ type: z.literal('reasoning.delta'), text: z.string() }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('tool.start'),
    id: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('tool.result'),
    id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    durationMs: z.number(),
    bytes: z.number(),
    output: z.string().optional(),
  }),
  z.object({
    type: z.literal('turn.completed'),
    sessionId: z.string(),
    durationMs: z.number(),
    iterations: z.number(),
    usage: Usage.nullable(),
    stopReason: z.enum(['stop', 'length', 'max_iterations']),
    output: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('turn.failed'),
    code: z.enum(FAIL_CODES),
    message: z.string(),
  }),
  // Setup events, shared by `login`, `models pull` and `engine install` in --json mode.
  z.object({
    type: z.literal('download.progress'),
    file: z.string(),
    received: z.number(),
    total: z.number(),
  }),
  z.object({ type: z.literal('download.done'), file: z.string(), path: z.string() }),
  z.object({ type: z.literal('setup.log'), message: z.string() }),
  z.object({ type: z.literal('setup.done'), ok: z.boolean(), message: z.string() }),
])

export type ExecEvent = z.infer<typeof ExecEventSchema>
export type ExecEventType = ExecEvent['type']
