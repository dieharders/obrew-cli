/**
 * `obrew exec [resume <sessionId>] [--json] [options] "<prompt>"`
 *
 * The provider entry point. A host spawns this once per turn with stdin ignored, reads
 * JSON lines from stdout, and stops it with a kill. Everything that can go wrong is reported
 * as a `turn.failed` event AND a non-zero exit, so a host may rely on either.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadGrammar, loadOutputSchema, templateSupportsTools } from '../../agent/constrain'
import { runAgent, type ToolMode } from '../../agent/loop'
import { builtinRegistry } from '../../agent/tools/registry'
import { McpClient } from '../../mcp/client'
import { parseMcpServerSpec } from '../../mcp/spec'
import { McpError } from '../../mcp/types'
import { generationFor, parseEffort } from '../../agent/effort'
import type { ChatMessage } from '../../agent/messages'
import { DEFAULT_SYSTEM_PROMPT } from '../../agent/prompts'
import { appendMessages, createSession, loadSession, newSessionId } from '../../agent/session'
import { launchArgs, loadOptionsFrom } from '../../engine/flags'
import { requireEngine } from '../../engine/install'
import { acquireEngine, reapIdleShared, type EngineHandle } from '../../engine/shared'
import { reapOrphans } from '../../engine/running'
import { resolveModel } from '../../models/registry'
import { DEFAULT_CTX_SIZE, loadConfig } from '../../shared/config'
import { isAbortError, NOT_READY_HINT, ObrewError, UsageError, type FailCode } from '../../shared/errors'
import type { ExecEvent } from '../../shared/events'
import { track, untrack } from '../../shared/proc'
import { asInt, oneOf, parse, parseConfigPairs } from '../args'
import { createOutput } from '../output'

const HELP = `obrew exec [resume <sessionId>] [--json] [options] "<prompt>"

  --json                     one JSON event per line on stdout
  --model <id>               installed model id (default: the registry default)
  --effort low|medium|high   thinking on/off and answer length (default: low)
  -c key=value               run knob; repeatable. thinking, max_tokens, temperature, top_p,
                             top_k, min_p, seed, stop, ctx_size, n_gpu_layers, threads,
                             batch_size, cache_type_k, cache_type_v, mmap, mlock
  --cwd <dir>                working directory for tools (default: current)
  --system-prompt <text>     system message; --system-prompt-file <path> reads it from a file
  --prompt-file <path>       read the prompt from a file ("-" as prompt reads stdin)
  --tools <list|none>        built-in tools: Read,Grep,Glob (default) or none
  --mcp-server name=<url>    MCP server over streamable HTTP; or name=stdio:<command …>.
                             Its tools appear as mcp__<name>__<tool>. Repeatable.
  --max-iterations <n>       tool-loop cap (default 25)
  --output-schema <json|@f>  decode the final answer under this JSON Schema
  --grammar <gbnf|@file>     decode the final answer under this GBNF grammar
  --stall-ms <n>             abort after this long with no output (default 120000)
  --wall-ms <n>              abort after this long in total (default 1800000)
  --include-tool-io          put tool inputs/outputs on the wire
  --engine shared|ephemeral  shared (default) keeps llama-server warm across runs and reuses
                             it when the model and flags match; ephemeral stops it on exit.
                             OBREW_ENGINE sets the default.

  -c tool_mode=native|universal|none   native = the chat template's own (grammar-constrained)
                             tool calls; universal = two schema-constrained steps; default is
                             native when the template mentions tools, else universal.`

const OPTIONS = {
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  model: { type: 'string' },
  effort: { type: 'string', default: 'low' },
  config: { type: 'string', multiple: true, short: 'c' },
  cwd: { type: 'string' },
  'system-prompt': { type: 'string' },
  'system-prompt-file': { type: 'string' },
  'prompt-file': { type: 'string' },
  tools: { type: 'string' },
  'mcp-server': { type: 'string', multiple: true },
  'max-iterations': { type: 'string', default: '25' },
  'output-schema': { type: 'string' },
  grammar: { type: 'string' },
  'stall-ms': { type: 'string', default: '120000' },
  'wall-ms': { type: 'string', default: '1800000' },
  'include-tool-io': { type: 'boolean', default: false },
  engine: { type: 'string' },
} as const

const ENGINE_MODES = ['shared', 'ephemeral'] as const

/**
 * A script named by `OBREW_LLAMA_SERVER` runs under this same Bun (tests use a fake server
 * written in TypeScript). Only meaningful when running from source: in a compiled binary
 * `process.execPath` is obrew itself.
 */
export const engineCommand = (binary: string): string[] =>
  /\.[cm]?[jt]s$/.test(binary) ? [process.execPath, binary] : [binary]

async function readPrompt(positionals: string[], promptFile: string | undefined): Promise<string> {
  if (promptFile) return (await readFile(promptFile, 'utf8')).trim()
  const inline = positionals.join(' ').trim()
  if (inline === '-') return (await Bun.stdin.text()).trim()
  if (!inline) throw new UsageError('a prompt is required (or --prompt-file)')
  return inline
}

export async function runExec(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, OPTIONS)
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const out = createOutput(values.json)

  // `exec resume <id> <prompt…>` — a subcommand, not a flag, like codex.
  let resumeId: string | null = null
  let rest = positionals
  if (rest[0] === 'resume') {
    resumeId = rest[1] ?? null
    if (!resumeId) throw new UsageError('resume needs a session id')
    rest = rest.slice(2)
  }

  const prompt = await readPrompt(rest, values['prompt-file'])
  const effort = parseEffort(values.effort)
  const pairs = parseConfigPairs(values.config)
  const gen = generationFor(effort, pairs)
  const cwd = resolve(values.cwd ?? process.cwd())
  const stallMs = asInt(values['stall-ms'], '--stall-ms')
  const wallMs = asInt(values['wall-ms'], '--wall-ms')
  const systemPrompt = values['system-prompt-file']
    ? await readFile(values['system-prompt-file'], 'utf8')
    : (values['system-prompt'] ?? DEFAULT_SYSTEM_PROMPT)
  const registry = builtinRegistry(values.tools)
  const mcpSpecs = (values['mcp-server'] ?? []).map(parseMcpServerSpec)
  const engineMode = oneOf(values.engine ?? process.env.OBREW_ENGINE ?? 'shared', ENGINE_MODES, '--engine')
  const maxIterations = asInt(values['max-iterations'], '--max-iterations')
  const outputSchema = values['output-schema'] ? await loadOutputSchema(values['output-schema']) : undefined
  const grammar = values.grammar ? await loadGrammar(values.grammar) : undefined
  if (outputSchema && grammar) throw new UsageError('--output-schema and --grammar cannot be combined')
  const requestedMode = pairs.tool_mode
  if (requestedMode !== undefined && !['native', 'universal', 'none'].includes(String(requestedMode))) {
    throw new UsageError(`-c tool_mode must be native|universal|none, got "${String(requestedMode)}"`)
  }

  const startedAt = Date.now()
  const controller = new AbortController()
  track(controller)
  let failCode: FailCode | null = null
  const stop = (code: FailCode) => {
    failCode ??= code
    controller.abort()
  }
  const onSignal = () => stop('aborted')
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stop('timeout'), stallMs)
  }
  const wallTimer = setTimeout(() => stop('timeout'), wallMs)

  let handle: EngineHandle | null = null
  const mcpClients: McpClient[] = []
  const emit = (event: ExecEvent) => out.event(event)

  try {
    await reapOrphans(out.log)
    if ((await reapIdleShared()) ) out.log('engine: stopped the idle shared llama-server')
    const config = await loadConfig()
    const model = await resolveModel(values.model)
    const engine = await requireEngine(config)

    // The host's tools, dialled per invocation. Connected before the engine starts so a dead
    // URL fails fast, and so the model load and the handshake overlap nothing that matters.
    for (const spec of mcpSpecs) {
      try {
        const client = await McpClient.connect(spec, { signal: controller.signal, cwd, log: out.log })
        mcpClients.push(client)
        for (const tool of await client.tools(controller.signal)) registry.add(tool)
      } catch (err) {
        if (err instanceof McpError) throw new ObrewError('tool_error', err.message)
        throw err
      }
    }

    const session = resumeId ? await loadSession(resumeId) : null
    const sessionId = session?.header.id ?? newSessionId()
    if (!session) await createSession({ id: sessionId, createdAt: new Date().toISOString(), model: model.id, cwd })

    const loadOpts = loadOptionsFrom(pairs, {
      ctxSize: config.ctxSize ?? DEFAULT_CTX_SIZE,
      ...(model.mmprojPath ? { mmprojPath: model.mmprojPath } : {}),
    })
    armStall()
    handle = await acquireEngine({
      mode: engineMode,
      command: engineCommand(engine.binary),
      args: launchArgs(model.path, null, loadOpts),
      model: model.id,
      signal: controller.signal,
      log: out.log,
      onStatus: (state) => {
        armStall()
        emit({ type: 'engine.status', state })
      },
    })
    emit({ type: 'session', sessionId, model: model.id, engine: { tag: engine.tag, variant: engine.variant, port: handle.port } })

    const history = (session?.messages ?? []).filter((m) => m.role !== 'system')
    const userMessage: ChatMessage = { role: 'user', content: prompt }
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history, userMessage]
    const toStore: ChatMessage[] = session ? [userMessage] : [messages[0]!, userMessage]

    const client = handle.client
    const touch = handle.touch
    let lastTouch = Date.now()
    const onActivity = () => {
      armStall()
      // Keep the shared engine's idle clock moving during a long generation, cheaply.
      if (Date.now() - lastTouch > 30_000) {
        lastTouch = Date.now()
        void touch()
      }
    }
    // Native tool calling needs a template that knows about tools; otherwise the universal
    // two-step, which constrains with an explicit schema and works with any template.
    let toolMode: ToolMode = 'none'
    if (registry.size > 0) {
      if (requestedMode !== undefined) toolMode = String(requestedMode) as ToolMode
      else toolMode = templateSupportsTools(await client.props(controller.signal)) ? 'native' : 'universal'
    }

    const result = await runAgent({
      client,
      messages,
      gen,
      registry,
      toolMode,
      toolContext: { cwd, signal: controller.signal },
      maxIterations,
      signal: controller.signal,
      emit,
      onActivity,
      includeToolIo: values['include-tool-io'],
      outputSchema,
      grammar,
    })
    toStore.push(...result.produced)
    await appendMessages(sessionId, toStore)

    emit({
      type: 'turn.completed',
      sessionId,
      durationMs: Date.now() - startedAt,
      iterations: result.iterations,
      usage: result.usage,
      stopReason: result.stopReason,
      ...(result.output !== undefined ? { output: result.output } : {}),
    })
    return result.stopReason === 'max_iterations' ? 1 : 0
  } catch (err) {
    const code: FailCode = failCode ?? (err instanceof ObrewError ? err.code : isAbortError(err) ? 'aborted' : 'engine_failed')
    const message =
      failCode === 'timeout'
        ? 'no output within the time limit'
        : failCode === 'aborted'
          ? 'stopped'
          : err instanceof Error
            ? err.message
            : String(err)
    if (handle && (code === 'aborted' || code === 'timeout')) await handle.client.eraseSlot()
    emit({ type: 'turn.failed', code, message })
    if (code === 'engine_missing' || code === 'model_missing') out.log(NOT_READY_HINT)
    if (err instanceof UsageError) throw err
    return 1
  } finally {
    clearTimeout(wallTimer)
    if (stallTimer) clearTimeout(stallTimer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (handle) await handle.release()
    for (const client of mcpClients) await client.close().catch(() => {})
    untrack(controller)
  }
}
