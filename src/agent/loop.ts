/**
 * The agent loop. (The single generation it is built from lives in ./turn.ts.)
 *
 * Principle: THE MODEL NEVER EMITS FREE-FORM TOOL JSON. Every tool-call turn is decoded under
 * a grammar — llama.cpp's own for native templates, an explicit JSON schema in universal mode
 * — and every call's arguments are validated against the tool's schema before it runs. An
 * invalid call is not executed; the model is asked once, under that schema, to repair it.
 *
 *   messages = [system, ...history, user]
 *   loop (max iterations):
 *     native:    one streamed turn with `tools`; llama.cpp's lazy grammar constrains the call
 *     universal: choose-tool + fill-args, each schema-constrained; "none" → a plain turn
 *     no tool calls → done
 *     run each call → append {role:'tool'} → continue
 *   --output-schema: one final constrained request, tools off (a schema and `tools` never
 *                    share a request), whose JSON becomes `turn.completed.output`. With no
 *                    tools at all, that request IS the turn and the loop never runs.
 */
import type { EngineClient } from '../engine/client'
import { ObrewError } from '../shared/errors'
import type { ExecEvent } from '../shared/events'
import { grammarBody, jsonSchemaBody, nativeToolsBody } from './constrain'
import type { GenerationSettings } from './effort'
import type { ChatMessage, ToolCall } from './messages'
import type { ToolRegistry } from './tools/registry'
import type { JsonSchema, ToolContext, ToolOutput } from './tools/types'
import { describeViolations, validate } from './tools/validate'
import { runTurn, type TurnResult } from './turn'
import { universalSelect } from './universal'

export { runTurn } from './turn'
export type { TurnOptions, TurnResult } from './turn'

export type ToolMode = 'native' | 'universal' | 'none'

export interface AgentOptions {
  client: EngineClient
  messages: ChatMessage[]
  gen: GenerationSettings
  registry: ToolRegistry
  toolMode: ToolMode
  toolContext: ToolContext
  maxIterations: number
  signal: AbortSignal
  emit: (event: ExecEvent) => void
  onActivity?: () => void
  includeToolIo?: boolean
  /** Per-call cap; a tool that runs longer is reported as an error result. */
  toolTimeoutMs?: number
  outputSchema?: JsonSchema
  grammar?: string
}

export interface AgentResult {
  /** Every message produced this run, in order, for the transcript. */
  produced: ChatMessage[]
  finalText: string
  iterations: number
  usage: { promptTokens: number; completionTokens: number } | null
  stopReason: 'stop' | 'length' | 'max_iterations'
  output?: unknown
}

const DEFAULT_TOOL_TIMEOUT_MS = 120_000

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool timed out after ${ms} ms`)), ms)
  })
  const abort = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new ObrewError('aborted', 'stopped')), { once: true })
  })
  try {
    return await Promise.race([work, timeout, abort])
  } finally {
    clearTimeout(timer)
  }
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const messages = [...opts.messages]
  const produced: ChatMessage[] = []
  const usage = { promptTokens: 0, completionTokens: 0 }
  let sawUsage = false
  let finalText = ''
  let stopReason: AgentResult['stopReason'] = 'stop'
  let iterations = 0
  const useTools = opts.toolMode !== 'none' && opts.registry.size > 0
  // A schema- or grammar-bound answer with no tools to call is ONE request: the constrained
  // one, straight after the user's message. Running the loop first only produced a free draft
  // of the same answer that the constrained request then replaced, so a host asking for
  // structured output paid for every answer twice.
  const answerOnly = !useTools && Boolean(opts.outputSchema || opts.grammar)
  const toolCtx: ToolContext = { ...opts.toolContext, signal: opts.signal }

  const addUsage = (u: TurnResult['usage']) => {
    if (!u) return
    sawUsage = true
    usage.promptTokens += u.promptTokens
    usage.completionTokens += u.completionTokens
  }
  const push = (m: ChatMessage) => {
    messages.push(m)
    produced.push(m)
  }

  const turnBase = {
    client: opts.client,
    gen: opts.gen,
    signal: opts.signal,
    emit: opts.emit,
    onActivity: opts.onActivity,
  }

  // A small model can re-issue the identical call forever, each time getting the identical
  // result. That is not progress; after one repeat the loop tells it so and takes the tools
  // away for one turn, which yields an answer instead of burning the iteration cap.
  let lastSignature: string | null = null
  let forcePlainTurn = false

  while (!answerOnly) {
    if (iterations >= opts.maxIterations) {
      stopReason = 'max_iterations'
      break
    }
    iterations++

    let assistant: TurnResult['message']
    let finish: string | null
    if (forcePlainTurn) {
      forcePlainTurn = false
      const turn = await runTurn({ ...turnBase, messages })
      addUsage(turn.usage)
      assistant = turn.message
      finish = turn.finishReason
    } else if (useTools && opts.toolMode === 'universal') {
      const call = await universalSelect({ ...turnBase, messages, registry: opts.registry })
      if (call) {
        assistant = { role: 'assistant', content: null, tool_calls: [call] }
        finish = 'tool_calls'
      } else {
        const turn = await runTurn({ ...turnBase, messages })
        addUsage(turn.usage)
        assistant = turn.message
        finish = turn.finishReason
      }
    } else {
      const turn = await runTurn({
        ...turnBase,
        messages,
        extra: useTools ? nativeToolsBody(opts.registry.schemas()) : undefined,
      })
      addUsage(turn.usage)
      assistant = turn.message
      finish = turn.finishReason
    }

    push(assistant)
    const calls = assistant.tool_calls ?? []
    if (calls.length === 0) {
      finalText = assistant.content ?? ''
      stopReason = finish === 'length' ? 'length' : 'stop'
      break
    }

    const signature = JSON.stringify(calls.map((c) => [c.function.name, c.function.arguments]))
    const repeated = signature === lastSignature
    lastSignature = signature

    for (const call of calls) {
      const result = await executeCall(call, messages, opts, toolCtx)
      push({ role: 'tool', tool_call_id: call.id, content: result.content })
      if (result.images?.length) {
        // The images ride in a user message (tool results are text on the wire). The
        // transcript keeps a marker instead of the base64, as `exec --image` does.
        const label = `Image from ${call.function.name}:`
        messages.push({ role: 'user', content: [{ type: 'text', text: label }, ...result.images] })
        produced.push({ role: 'user', content: `${label} [image]` })
      }
    }

    if (repeated) {
      push({
        role: 'user',
        content:
          'You repeated the same tool call with the same arguments; its result is unchanged and is shown above. ' +
          'Do not call tools again. Answer the request now from what you have.',
      })
      forcePlainTurn = true
    }
  }

  let output: unknown
  if (opts.outputSchema || opts.grammar) {
    if (!answerOnly) {
      // A user turn closes the transcript before the constrained request. The model's own text
      // may be the last message here, and a chat template asked to continue after an assistant
      // turn is exactly the case llama.cpp's grammar + reasoning handling trips over
      // ("empty grammar stack after accepting piece: <think>").
      //
      // Only after the loop: with no loop the user's own message is already last, and a second
      // user turn in a row is an error in templates that require roles to alternate.
      push({
        role: 'user',
        content: opts.outputSchema
          ? 'Now give the final answer as JSON that matches the required schema, and nothing else.'
          : 'Now give the final answer in the required format, and nothing else.',
      })
    }
    const turn = await runTurn({
      ...turnBase,
      messages,
      extra: opts.outputSchema ? jsonSchemaBody(opts.outputSchema) : grammarBody(opts.grammar!),
      constrained: true,
    })
    addUsage(turn.usage)
    push(turn.message)
    finalText = turn.message.content ?? ''
    if (answerOnly) {
      iterations = 1
      stopReason = turn.finishReason === 'length' ? 'length' : 'stop'
    }
    if (opts.outputSchema) {
      try {
        output = JSON.parse(finalText)
      } catch {
        output = undefined
      }
    }
  }

  return { produced, finalText, iterations, usage: sawUsage ? usage : null, stopReason, output }
}

interface CallResult {
  content: string
  images?: ToolOutput['images']
}

/** Validate, repair once if needed, run, and report — always returning a result, never throwing. */
async function executeCall(
  call: ToolCall,
  messages: ChatMessage[],
  opts: AgentOptions,
  ctx: ToolContext,
): Promise<CallResult> {
  const name = call.function.name
  const tool = opts.registry.get(name)
  const startedAt = Date.now()
  const report = (ok: boolean, content: string, images?: ToolOutput['images']): CallResult => {
    opts.emit({
      type: 'tool.result',
      id: call.id,
      name,
      ok,
      durationMs: Date.now() - startedAt,
      bytes: Buffer.byteLength(content),
      ...(opts.includeToolIo ? { output: content } : {}),
    })
    return { content, images }
  }

  if (!tool) {
    opts.emit({ type: 'tool.start', id: call.id, name })
    return report(false, `Error: unknown tool "${name}". Available: ${opts.registry.list().map((t) => t.name).join(', ')}`)
  }

  let args = parseArgs(call.function.arguments)
  let violations = args ? validate(args, tool.inputSchema) : [{ path: '$', message: 'arguments are not a JSON object' }]
  if (violations.length > 0) {
    // One constrained repair: the model re-emits the arguments under the tool's own schema
    // after seeing exactly what was wrong.
    const repair = await runTurn({
      client: opts.client,
      gen: opts.gen,
      signal: opts.signal,
      emit: () => {},
      onActivity: opts.onActivity,
      messages: [
        ...messages,
        {
          role: 'user',
          content: `The arguments for tool "${name}" were invalid: ${describeViolations(violations)}. Reply with corrected JSON arguments only.`,
        },
      ],
      extra: jsonSchemaBody(tool.inputSchema),
      constrained: true,
    })
    args = parseArgs(repair.message.content ?? '')
    violations = args ? validate(args, tool.inputSchema) : violations
    if (args) call.function.arguments = JSON.stringify(args)
  }

  opts.emit({ type: 'tool.start', id: call.id, name, ...(opts.includeToolIo ? { input: args } : {}) })
  if (!args || violations.length > 0) {
    return report(false, `Error: invalid arguments for "${name}": ${describeViolations(violations)}`)
  }

  try {
    const limit = opts.toolTimeoutMs ?? tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    const out = await withTimeout(tool.execute(args, ctx), limit, opts.signal)
    return report(!out.isError, out.content, out.images)
  } catch (err) {
    if (err instanceof ObrewError && err.code === 'aborted') throw err
    return report(false, `Error: ${err instanceof Error ? err.message : String(err)}`)
  }
}
