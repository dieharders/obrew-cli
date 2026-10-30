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
  // What a multi-file pull (`obrew image setup`, `obrew image models pull`) is about to fetch,
  // sent before the first byte: a host can show the total, and the files already on disk.
  z.object({
    type: z.literal('download.plan'),
    files: z.array(z.object({ file: z.string(), size: z.number(), cached: z.boolean() })),
    totalBytes: z.number(),
  }),
  // `obrew image`. One run makes `count` images, one sd-server job each; `index` says which.
  z.object({
    type: z.literal('image.started'),
    runId: z.string(),
    mode: z.enum(['generate', 'img2img', 'edit', 'upscale']),
    model: z.string().nullable(),
    engine: z.object({ tag: z.string(), variant: z.string(), port: z.number() }),
    width: z.number(),
    height: z.number(),
    count: z.number(),
    seed: z.number().nullable(),
  }),
  z.object({
    type: z.literal('image.progress'),
    runId: z.string(),
    index: z.number(),
    phase: z.enum(['queued', 'sampling', 'decoding', 'upscaling']),
    step: z.number().optional(),
    steps: z.number().optional(),
    position: z.number().optional(),
  }),
  // A low-resolution look at the image so far, PNG as base64. Only with `--preview fast`.
  z.object({
    type: z.literal('image.preview'),
    runId: z.string(),
    index: z.number(),
    step: z.number(),
    steps: z.number(),
    b64: z.string(),
  }),
  // `path` when the image went to a file (the CLI); `b64` when it stayed in memory (`serve`).
  z.object({
    type: z.literal('image.saved'),
    runId: z.string(),
    index: z.number(),
    path: z.string().optional(),
    b64: z.string().optional(),
    width: z.number(),
    height: z.number(),
    seed: z.number().nullable(),
    format: z.enum(['png', 'jpeg', 'webp']),
    bytes: z.number(),
    model: z.string().nullable(),
    durationMs: z.number(),
  }),
  z.object({
    type: z.literal('image.completed'),
    runId: z.string(),
    durationMs: z.number(),
    images: z.array(
      z.object({ path: z.string().optional(), width: z.number(), height: z.number(), seed: z.number().nullable() }),
    ),
  }),
  z.object({
    type: z.literal('image.failed'),
    code: z.enum(FAIL_CODES),
    message: z.string(),
  }),
])

export type ExecEvent = z.infer<typeof ExecEventSchema>
export type ExecEventType = ExecEvent['type']

/**
 * The other direction: what a host writes on stdin under `exec --input-format json`, one
 * object and then EOF. It is how a host keeps the turn's text off the command line, which
 * Windows caps at ~32 KB, without writing it to a file somewhere first. Strict, so a
 * misspelled field is a usage error rather than a prompt that silently went missing.
 */
export const ExecInputSchema = z.strictObject({
  prompt: z.string(),
  systemPrompt: z.string().optional(),
  /**
   * `--output-schema`, carried with the turn. Here for the same reason the prompt is: a host
   * whose answer is a whole document has a schema to match (motionbuff's deck spec is ~42 KB
   * of JSON Schema) that no Windows command line can hold.
   */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
})

export type ExecInput = z.infer<typeof ExecInputSchema>

/**
 * `obrew image --input-format json`: the prompt (and negative prompt) on stdin, for the same
 * reason `exec` takes its prompt there. Strict, so a misspelled field is a usage error.
 */
export const ImageInputSchema = z.strictObject({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
})

export type ImageInput = z.infer<typeof ImageInputSchema>
