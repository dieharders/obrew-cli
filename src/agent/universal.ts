/**
 * Universal tool calling: two schema-constrained requests instead of the template's own
 * tool-call format. Port of obrew-engine's `tool.py` (`choose_tool_from_description` +
 * `universal_call`), for models whose chat template has no tool support, or when the user
 * asks for it with `-c tool_mode=universal`.
 *
 *   1. CHOOSE  — decoded under `{ tool: <enum of names | "none">, reason }` after reading
 *                markdown cards for every tool, its length bounded (see REASON_MAX_CHARS).
 *   2. FILL    — decoded under the chosen tool's own inputSchema.
 *
 * Both requests run with thinking off (see effort.ts). "none" means the model wants to answer
 * in prose; the loop then runs an ordinary unconstrained turn.
 *
 * With a tool model (../needle/structure.ts) a third way comes first: the model says in plain
 * `name: value` lines which tool it wants and with what, and Needle turns that into the call.
 * Only what Needle cannot settle — an unsure choice, arguments that are an authored body —
 * comes back to the two constrained requests above.
 */
import type { EngineClient } from '../engine/client'
import type { GenerationSettings } from './effort'
import { jsonSchemaBody } from './constrain'
import { runTurn } from './turn'
import type { ChatMessage, ToolCall } from './messages'
import type { ToolRegistry } from './tools/registry'
import type { Tool } from './tools/types'
import type { NeedleSession } from '../needle/session'
import { structureToolCall, toolCards } from '../needle/structure'

export interface UniversalOptions {
  client: EngineClient
  messages: ChatMessage[]
  gen: GenerationSettings
  registry: ToolRegistry
  signal: AbortSignal
  onActivity?: () => void
  /** The tool model, when the run has one. */
  needle?: NeedleSession
  /** `-c tool_confidence=`: see DEFAULT_TOOL_CONFIDENCE. */
  toolConfidence?: number
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

const toolCall = (name: string, args: unknown): ToolCall => ({
  id: `call_${Date.now().toString(36)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args ?? {}) },
})

const DRAFT_INSTRUCTIONS =
  'Decide the next step for the latest request. If tool results above already contain what the ' +
  'request needs, no tool is needed. Never repeat a call whose result is already shown.\n\n' +
  'To call ONE tool, reply with exactly these lines and nothing else:\n' +
  'tool: <tool name>\n<argument name>: <value>   (one line per argument, values copied exactly)\n\n' +
  'To answer directly instead, reply with exactly:\ntool: none'

/**
 * The draft is a few short lines. The cap is what CHOOSE_MAX_TOKENS is to a choice: a backstop
 * for a model that does not stop, not a budget it is expected to use.
 */
const DRAFT_MAX_TOKENS = 1024

/**
 * The tool model's round: a free-text statement of the call, structured by Needle. Returns the
 * call, null for "answer in prose", or 'unsure' to hand the round to the constrained requests.
 *
 * Thinking stays off for the draft, as it is for CHOOSE: this runs once per tool call, ten or
 * twenty times a job, and a thinking turn each time would cost more than the grammar ever did.
 */
async function needleSelect(opts: UniversalOptions, needle: NeedleSession): Promise<ToolCall | null | 'unsure'> {
  const tools = opts.registry.list()
  const draft = await runTurn({
    client: opts.client,
    messages: [...opts.messages, { role: 'user', content: `${DRAFT_INSTRUCTIONS}\n\n${toolCards(tools)}` }],
    gen: { ...opts.gen, thinking: false, maxTokens: Math.min(opts.gen.maxTokens, DRAFT_MAX_TOKENS) },
    signal: opts.signal,
    emit: () => {},
    onActivity: opts.onActivity,
    toolCall: true,
  })
  const choice = await structureToolCall(needle, tools, draft.message.content ?? '', opts.toolConfidence)
  if (choice.kind === 'none') return null
  if (choice.kind === 'unsure') {
    console.error(`[needle] tool choice fell back: ${choice.why}`)
    return 'unsure'
  }
  console.error(`[needle] chose ${choice.tool.name} (${choice.confidence ?? 'n/a'}, ${choice.ms} ms)${choice.args ? '' : `; arguments from the baseline model${choice.why ? ` (${choice.why})` : ''}`}`)
  return toolCall(choice.tool.name, choice.args ?? (await fill(opts, choice.tool)))
}

/** One selection+fill round. Returns the call to make, or null for "answer in prose". */
export async function universalSelect(opts: UniversalOptions): Promise<ToolCall | null> {
  const names = opts.registry.list().map((t) => t.name)
  if (names.length === 0) return null

  if (opts.needle) {
    const call = await needleSelect(opts, opts.needle)
    if (call !== 'unsure') return call
  }

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
  return toolCall(tool.name, await fill(opts, tool))
}

/** FILL: the chosen tool's arguments, decoded under its own inputSchema. */
async function fill(opts: UniversalOptions, tool: Tool): Promise<unknown> {
  // The fill step sees the whole transcript, so a failed earlier call of this same tool is
  // right there above it — but a small model re-fills identical arguments unless told the
  // result is something to act on. Said every time rather than only after a failure: the loop
  // does not know here whether the last result was an error, and the sentence costs nothing when
  // there was none.
  const fillMessages: ChatMessage[] = [
    ...opts.messages,
    {
      role: 'user',
      content:
        `Call the tool "${tool.name}". ${tool.description}\n\n` +
        `If an earlier call of this tool above reported a problem with its arguments, change them to fix ` +
        `exactly what it reported; never repeat arguments that already failed.\n\nReply with the JSON arguments only.`,
    },
  ]
  return constrainedJson(opts, fillMessages, tool.inputSchema, 'fill')
}
