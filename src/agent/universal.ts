/**
 * Universal tool calling: two schema-constrained requests instead of the template's own
 * tool-call format. Port of obrew-engine's `tool.py` (`choose_tool_from_description` +
 * `universal_call`), for models whose chat template has no tool support, or when the user
 * asks for it with `-c tool_mode=universal`.
 *
 *   1. CHOOSE  — decoded under `{ tool: <enum of names | "none">, reason }` after reading a
 *                name + description card for every tool, its length bounded (REASON_MAX_CHARS).
 *   1b. BRANCH — only when the chosen tool's schema is a union told apart by a constant field
 *                (motionbuff's build_slide: one branch per `treatment`): that field is chosen
 *                first, so the next step reads and writes one branch instead of all of them.
 *   2. FILL    — decoded under the chosen tool's (or branch's) schema, which the prompt SHOWS.
 *
 * Each step is handed only what it decides with. The schemas used to ride in every CHOOSE card
 * and in no FILL prompt at all, which was backwards: a name was picked after re-reading every
 * argument of every tool, and the arguments were then written by a model that had been shown
 * none of them — the grammar forced the keys, but their descriptions and limits were unseen.
 *
 * Both requests run with thinking off (see effort.ts). "none" means the model wants to answer
 * in prose; the loop then runs an ordinary unconstrained turn.
 */
import type { EngineClient } from '../engine/client'
import type { GenerationSettings } from './effort'
import { jsonSchemaBody } from './constrain'
import { runTurn } from './turn'
import type { ChatMessage, ToolCall } from './messages'
import type { ToolRegistry } from './tools/registry'
import type { JsonSchema } from './tools/types'

export interface UniversalOptions {
  client: EngineClient
  messages: ChatMessage[]
  gen: GenerationSettings
  registry: ToolRegistry
  signal: AbortSignal
  onActivity?: () => void
}

const CHOOSE_INSTRUCTIONS =
  'You may call ONE of the tools below to make progress on the latest request, or choose "none" ' +
  'to answer directly. If tool results above already contain what the request needs, choose ' +
  '"none". Never repeat a call whose result is already shown. Reply with JSON only.'

/**
 * How long a CHOOSE answer may run. Bounded twice, because unbounded it ran for minutes.
 *
 * `reason` comes after the choice in the answer (`tool` is first and the only required key) and
 * nothing reads it, yet as a bare string nothing ended it but `max_tokens`. With a vision still
 * attached, Gemma 4 E2B wrote 190–371 tokens of it on a healthy critique turn, and on two of the
 * five in one motionbuff job it never closed the string at all: 8,192 tokens each (the `medium`
 * effort's cap), about 255 s at 32 tok/s, then a parse failure that silently became "no tool".
 * The grammar now ends the string at REASON_MAX_CHARS, and CHOOSE_MAX_TOKENS is the backstop for
 * whatever the grammar cannot see — well above anything a capped answer reaches.
 *
 * FILL gets no such cap: its arguments can legitimately be a whole file for a write.
 */
const REASON_MAX_CHARS = 200
const CHOOSE_MAX_TOKENS = 512

async function constrainedJson(
  opts: UniversalOptions,
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  step: 'choose' | 'fill',
  maxTokens = opts.gen.maxTokens,
): Promise<unknown> {
  const gen = { ...opts.gen, maxTokens: Math.min(opts.gen.maxTokens, maxTokens) }
  const turn = await runTurn({
    client: opts.client,
    messages,
    gen,
    signal: opts.signal,
    emit: () => {},
    onActivity: opts.onActivity,
    extra: jsonSchemaBody(schema),
    constrained: true,
    toolCall: true,
  })
  // A stop on max_tokens leaves the JSON unclosed, which parses to null below and becomes "no
  // tool" (choose) or empty arguments (fill) without a word. These requests stream nothing to the
  // caller, so stderr — where obrew's diagnostics go — is the only place it can show.
  if (turn.finishReason === 'length') {
    console.error(
      `[universal] ${step} stopped at max_tokens (${gen.maxTokens}) before its JSON closed`,
    )
  }
  try {
    return JSON.parse(turn.message.content ?? '')
  } catch {
    return null
  }
}

/**
 * A schema is shown to the model that fills it while it is a card's worth of reading. Past this
 * it is decoded under all the same and only not shown; a union is narrowed to a branch first,
 * so in practice this is a backstop for one very large flat schema.
 */
const FILL_SCHEMA_MAX_CHARS = 6_000

type Json = Record<string, unknown>

/** The `$defs` a schema actually points at, so a branch carries its own and no one else's. */
function referencedDefs(node: unknown, defs: Json, found: Json = {}): Json {
  if (Array.isArray(node)) for (const item of node) referencedDefs(item, defs, found)
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const name = key === '$ref' && typeof value === 'string' ? /^#\/\$defs\/(.+)$/.exec(value)?.[1] : undefined
      if (name !== undefined && name in defs && !(name in found)) {
        found[name] = defs[name]
        referencedDefs(defs[name], defs, found)
      } else referencedDefs(value, defs, found)
    }
  }
  return found
}

/**
 * A union whose branches are told apart by one constant field: the field, and each value's
 * branch made self-contained. Null for every other schema.
 */
export function discriminatedUnion(schema: JsonSchema): { key: string; branches: Map<string, JsonSchema> } | null {
  const union = (schema.anyOf ?? schema.oneOf) as Json[] | undefined
  if (!Array.isArray(union) || union.length < 2) return null
  const constsOf = (branch: Json) =>
    Object.entries((branch.properties ?? {}) as Record<string, Json>).filter(([, p]) => p && typeof p.const === 'string')
  const key = constsOf(union[0]!).find(([k]) => union.every((b) => constsOf(b).some(([bk]) => bk === k)))?.[0]
  if (!key) return null
  const defs = (schema.$defs ?? {}) as Json
  const branches = new Map<string, JsonSchema>()
  for (const branch of union) {
    const value = (branch.properties as Record<string, Json>)[key]!.const as string
    const own = referencedDefs(branch, defs)
    branches.set(value, Object.keys(own).length > 0 ? { ...branch, $defs: own } : branch)
  }
  return branches.size === union.length ? { key, branches } : null
}

/** One selection+fill round. Returns the call to make, or null for "answer in prose". */
export async function universalSelect(opts: UniversalOptions): Promise<ToolCall | null> {
  const names = opts.registry.list().map((t) => t.name)
  if (names.length === 0) return null

  const chooseMessages: ChatMessage[] = [
    ...opts.messages,
    {
      role: 'user',
      content: `${CHOOSE_INSTRUCTIONS}\n\n${opts.registry.markdown()}`,
    },
  ]
  const choice = (await constrainedJson(
    opts,
    chooseMessages,
    {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: [...names, 'none'] },
        reason: { type: 'string', maxLength: REASON_MAX_CHARS },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    'choose',
    CHOOSE_MAX_TOKENS,
  )) as { tool?: string } | null
  const tool = choice?.tool ? opts.registry.get(choice.tool) : undefined
  if (!tool) return null

  // The fill step sees the whole transcript, so a failed earlier call of this same tool is
  // right there above it — but a small model re-fills identical arguments unless told the
  // result is something to act on. Said every time rather than only after a failure: the loop
  // does not know here whether the last result was an error, and the sentence costs nothing when
  // there was none.
  let schema = tool.inputSchema
  const union = discriminatedUnion(schema)
  if (union) {
    const values = [...union.branches.keys()]
    const picked = (await constrainedJson(
      opts,
      [
        ...opts.messages,
        {
          role: 'user',
          content: `You are calling the tool "${tool.name}". ${tool.description}\n\nFirst choose its "${union.key}": one of ${values.join(', ')}. Reply with JSON only.`,
        },
      ],
      { type: 'object', properties: { [union.key]: { type: 'string', enum: values } }, required: [union.key], additionalProperties: false },
      'choose',
      CHOOSE_MAX_TOKENS,
    )) as Record<string, string> | null
    // No answer leaves the whole union in force: slower to read, never less correct.
    schema = union.branches.get(picked?.[union.key] ?? '') ?? schema
  }
  const shown = JSON.stringify(schema)

  const fillMessages: ChatMessage[] = [
    ...opts.messages,
    {
      role: 'user',
      content:
        `Call the tool "${tool.name}". ${tool.description}\n\n` +
        (shown.length <= FILL_SCHEMA_MAX_CHARS ? `Its arguments (JSON Schema): ${shown}\n\n` : '') +
        `If an earlier call of this tool above reported a problem with its arguments, change them to fix ` +
        `exactly what it reported; never repeat arguments that already failed.\n\nReply with the JSON arguments only.`,
    },
  ]
  const args = await constrainedJson(opts, fillMessages, schema, 'fill')
  return {
    id: `call_${Date.now().toString(36)}`,
    type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(args ?? {}) },
  }
}
