/**
 * Universal tool calling: two schema-constrained requests instead of the template's own
 * tool-call format. Port of obrew-engine's `tool.py` (`choose_tool_from_description` +
 * `universal_call`), for models whose chat template has no tool support, or when the user
 * asks for it with `-c tool_mode=universal`.
 *
 *   1. CHOOSE  — decoded under `{ tool: <enum of names | "none">, reason }` after reading
 *                markdown cards for every tool.
 *   2. FILL    — decoded under the chosen tool's own inputSchema.
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

async function constrainedJson(
  opts: UniversalOptions,
  messages: ChatMessage[],
  schema: Record<string, unknown>,
): Promise<unknown> {
  const turn = await runTurn({
    client: opts.client,
    messages,
    gen: opts.gen,
    signal: opts.signal,
    emit: () => {},
    onActivity: opts.onActivity,
    extra: jsonSchemaBody(schema),
    constrained: true,
  })
  try {
    return JSON.parse(turn.message.content ?? '')
  } catch {
    return null
  }
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
  const choice = (await constrainedJson(opts, chooseMessages, {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: [...names, 'none'] },
      reason: { type: 'string' },
    },
    required: ['tool'],
    additionalProperties: false,
  })) as { tool?: string } | null
  const tool = choice?.tool ? opts.registry.get(choice.tool) : undefined
  if (!tool) return null

  const fillMessages: ChatMessage[] = [
    ...opts.messages,
    {
      role: 'user',
      content: `Call the tool "${tool.name}". ${tool.description}\n\nReply with the JSON arguments only.`,
    },
  ]
  const args = await constrainedJson(opts, fillMessages, tool.inputSchema)
  return {
    id: `call_${Date.now().toString(36)}`,
    type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(args ?? {}) },
  }
}
