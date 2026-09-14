/**
 * One generation: send the messages, stream the answer, report what came back.
 *
 * The unit both the agent loop and universal tool selection are built from. Emits the
 * streaming events; knows nothing about tools beyond merging the fragments llama-server
 * streams for a tool call.
 */
import type { ChatDelta, EngineClient } from '../engine/client'
import type { ExecEvent } from '../shared/events'
import type { GenerationSettings } from './effort'
import { requestParams } from './effort'
import type { ChatMessage, ToolCall } from './messages'

export interface TurnResult {
  message: ChatMessage & { role: 'assistant' }
  reasoning: string
  finishReason: string | null
  usage: { promptTokens: number; completionTokens: number } | null
}

export interface TurnOptions {
  client: EngineClient
  messages: ChatMessage[]
  gen: GenerationSettings
  signal: AbortSignal
  emit: (event: ExecEvent) => void
  /** Called on every delta; the caller uses it to re-arm its stall timer. */
  onActivity?: () => void
  /** Extra body fields (tools, response_format, grammar). */
  extra?: Record<string, unknown>
  constrained?: boolean
  /** A tool choice, fill or repair: sampled at `gen.toolTemperature` (see effort.ts). */
  toolCall?: boolean
}

/** Merge streamed tool-call fragments by index into complete calls. */
function mergeToolCalls(acc: Map<number, ToolCall>, deltas: ChatDelta['toolCalls']): void {
  for (const d of deltas ?? []) {
    const cur = acc.get(d.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
    if (d.id) cur.id = d.id
    if (d.name) cur.function.name += d.name
    if (d.arguments) cur.function.arguments += d.arguments
    acc.set(d.index, cur)
  }
}

export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const body = {
    messages: opts.messages,
    ...requestParams(opts.gen, { constrained: opts.constrained, toolCall: opts.toolCall }),
    ...(opts.extra ?? {}),
  }

  let content = ''
  let reasoning = ''
  let reasoningStarted = false
  let finishReason: string | null = null
  let usage: TurnResult['usage'] = null
  const toolCalls = new Map<number, ToolCall>()

  for await (const delta of opts.client.chat(body, opts.signal)) {
    opts.onActivity?.()
    if (delta.reasoning) {
      if (!reasoningStarted) {
        reasoningStarted = true
        opts.emit({ type: 'reasoning.start' })
      }
      reasoning += delta.reasoning
      opts.emit({ type: 'reasoning.delta', text: delta.reasoning })
    }
    if (delta.content) {
      content += delta.content
      opts.emit({ type: 'delta', text: delta.content })
    }
    if (delta.toolCalls) mergeToolCalls(toolCalls, delta.toolCalls)
    if (delta.finishReason) finishReason = delta.finishReason
    if (delta.usage) usage = delta.usage
  }

  const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c], i) => ({
    ...c,
    id: c.id || `call_${i}`,
  }))

  const message: TurnResult['message'] = {
    role: 'assistant',
    content: content || null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  }
  return { message, reasoning, finishReason, usage }
}
