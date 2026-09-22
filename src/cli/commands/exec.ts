/**
 * `obrew exec [resume <sessionId>] [--json] [options] "<prompt>"`
 *
 * The provider entry point. A host spawns this once per turn, reads JSON lines from stdout,
 * and stops it with a kill. The turn's text comes from argv, or with `--input-format json`
 * from one JSON object on stdin (`ExecInputSchema`), which is how a host passes a prompt
 * (or an output schema) too long for a command line. Everything that can go wrong is reported as a `turn.failed`
 * event AND a non-zero exit, so a host may rely on either.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadGrammar, loadOutputSchema, templateSupportsTools } from '../../agent/constrain'
import { runAgent, type ToolMode } from '../../agent/loop'
import { builtinRegistry } from '../../agent/tools/registry'
import type { JsonSchema } from '../../agent/tools/types'
import { McpClient } from '../../mcp/client'
import { parseMcpServerSpec } from '../../mcp/spec'
import { McpError } from '../../mcp/types'
import { generationFor, parseEffort } from '../../agent/effort'
import type { ChatMessage } from '../../agent/messages'
import { imagePart, transcriptContent, userContent } from '../../agent/images'
import { DEFAULT_SYSTEM_PROMPT } from '../../agent/prompts'
import { appendMessages, createSession, loadSession, newSessionId } from '../../agent/session'
import { engineConsoleFrom, launchArgs, loadOptionsFrom } from '../../engine/flags'
import { requireEngine } from '../../engine/install'
import { acquireEngine, reapIdleShared, type EngineHandle } from '../../engine/shared'
import { reapOrphans } from '../../engine/running'
import { projectorPath, resolveModel } from '../../models/registry'
import { DEFAULT_CTX_SIZE, loadConfig } from '../../shared/config'
import { isAbortError, NOT_READY_HINT, ObrewError, UsageError, type FailCode } from '../../shared/errors'
import { ExecInputSchema, type ExecEvent } from '../../shared/events'
import { track, untrack } from '../../shared/proc'
import { asInt, oneOf, parse, parseConfigPairs } from '../args'
import { createOutput } from '../output'

const HELP = `obrew exec [resume <sessionId>] [--json] [options] "<prompt>"

  --json                     one JSON event per line on stdout
  --model <id>               installed model id (default: \`obrew models use\`'s, else built-in)
  --effort low|medium|high   thinking on/off and answer length (default: low)
  -c key=value               run knob; repeatable. thinking, max_tokens, temperature,
                             tool_temperature (tool choice/arguments; default 0.1), top_p,
                             top_k, min_p, seed, stop, ctx_size, n_gpu_layers, threads,
                             batch_size, cache_type_k, cache_type_v, mmap, mlock
  --cwd <dir>                working directory for tools (default: current)
  --system-prompt <text>     system message; --system-prompt-file <path> reads it from a file
  --prompt-file <path>       read the prompt from a file ("-" as prompt reads stdin)
  --input-format text|json   json: read {"prompt", "systemPrompt"?, "outputSchema"?} from stdin
                             as one JSON object, instead of the prompt argument and the flags
                             above; "outputSchema" is --output-schema with no argv size limit
  --tools <list|none>        built-in tools: Read,Grep,Glob (default), WebSearch, or none
  --image <path>             attach an image (png/jpg/gif/webp); the run loads the model's
                             vision projector to see it. Repeatable.
  --vision                   load the model's vision projector without attaching an image, so
                             Read can show the model images. Off by default: it costs memory.
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
                             OBREW_ENGINE sets the default. -c engine_idle_ms=N sets how long
                             the shared engine may idle before a later run stops it.
                             -c engine_console=true (Windows) gives a shared engine this run
                             starts a visible console window showing its log.

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
  'input-format': { type: 'string', default: 'text' },
  tools: { type: 'string' },
  'mcp-server': { type: 'string', multiple: true },
  'max-iterations': { type: 'string', default: '25' },
  'output-schema': { type: 'string' },
  grammar: { type: 'string' },
  'stall-ms': { type: 'string', default: '120000' },
  'wall-ms': { type: 'string', default: '1800000' },
  'include-tool-io': { type: 'boolean', default: false },
  engine: { type: 'string' },
  image: { type: 'string', multiple: true },
  vision: { type: 'boolean', default: false },
} as const

const ENGINE_MODES = ['shared', 'ephemeral'] as const
const INPUT_FORMATS = ['text', 'json'] as const

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

/**
 * `--input-format json`: the prompt and the system prompt from one JSON object on stdin.
 * Stdin is the ONLY source in this mode, so an argv prompt or a prompt flag beside it is a
 * usage error rather than a question of which one wins. `systemPrompt: null` means "not
 * given", so the default applies, the same as omitting `--system-prompt`. An output schema
 * may come from either place, but not from both, for the same reason.
 */
async function readJsonInput(
  positionals: string[],
  flags: { 'prompt-file'?: string; 'system-prompt'?: string; 'system-prompt-file'?: string; 'output-schema'?: string },
): Promise<{ prompt: string; systemPrompt: string | null; outputSchema?: JsonSchema }> {
  if (positionals.length > 0 || flags['prompt-file'] || flags['system-prompt'] !== undefined || flags['system-prompt-file']) {
    throw new UsageError('--input-format json reads the prompt and system prompt from stdin; drop the prompt argument and the prompt flags')
  }
  let raw: unknown
  try {
    raw = JSON.parse(await Bun.stdin.text())
  } catch {
    throw new UsageError('--input-format json: stdin is not a JSON object')
  }
  const parsed = ExecInputSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    throw new UsageError(`--input-format json: ${issues}`)
  }
  const prompt = parsed.data.prompt.trim()
  if (!prompt) throw new UsageError('a prompt is required')
  if (parsed.data.outputSchema && flags['output-schema'] !== undefined) {
    throw new UsageError('--input-format json: "outputSchema" on stdin and --output-schema cannot be combined')
  }
  return { prompt, systemPrompt: parsed.data.systemPrompt ?? null, outputSchema: parsed.data.outputSchema }
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

  const inputFormat = oneOf(values['input-format'], INPUT_FORMATS, '--input-format')
  const input: { prompt: string; systemPrompt: string | null; outputSchema?: JsonSchema } =
    inputFormat === 'json'
      ? await readJsonInput(rest, values)
      : {
          prompt: await readPrompt(rest, values['prompt-file']),
          systemPrompt: values['system-prompt-file']
            ? await readFile(values['system-prompt-file'], 'utf8')
            : (values['system-prompt'] ?? null),
        }
  const prompt = input.prompt
  const effort = parseEffort(values.effort)
  const pairs = parseConfigPairs(values.config)
  const gen = generationFor(effort, pairs)
  const cwd = resolve(values.cwd ?? process.cwd())
  const stallMs = asInt(values['stall-ms'], '--stall-ms')
  const wallMs = asInt(values['wall-ms'], '--wall-ms')
  const systemPrompt = input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const registry = builtinRegistry(values.tools)
  const mcpSpecs = (values['mcp-server'] ?? []).map(parseMcpServerSpec)
  const engineMode = oneOf(values.engine ?? process.env.OBREW_ENGINE ?? 'shared', ENGINE_MODES, '--engine')
  const maxIterations = asInt(values['max-iterations'], '--max-iterations')
  const outputSchema = input.outputSchema ?? (values['output-schema'] ? await loadOutputSchema(values['output-schema']) : undefined)
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

  // The stall timer watches for a SILENT engine. While a tool runs there is nothing to hear
  // from the engine, so the timer is suspended between tool.start and tool.result; the tool's
  // own timeout (and the wall clock) bound that stretch instead.
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let toolRunning = false
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    if (toolRunning) return
    stallTimer = setTimeout(() => stop('timeout'), stallMs)
  }
  const wallTimer = setTimeout(() => stop('timeout'), wallMs)

  let handle: EngineHandle | null = null
  const mcpClients: McpClient[] = []
  const emit = (event: ExecEvent) => {
    if (event.type === 'tool.start') {
      toolRunning = true
      if (stallTimer) clearTimeout(stallTimer)
    } else if (event.type === 'tool.result') {
      toolRunning = false
      armStall()
    }
    out.event(event)
  }
  const idleTtlMs = pairs.engine_idle_ms !== undefined ? asInt(pairs.engine_idle_ms, '-c engine_idle_ms') : undefined
  const engineConsole = engineConsoleFrom(pairs)

  try {
    await reapOrphans(out.log)
    if ((await reapIdleShared()) ) out.log('engine: stopped the idle shared llama-server')
    const config = await loadConfig()
    const model = await resolveModel(values.model)
    const engine = await requireEngine(config)
    let imagePaths = (values.image ?? []).map((p) => resolve(cwd, p))
    // The projector is loaded only for a run that asks for vision, with `--vision` or an image
    // to look at: it costs memory and load time, and llama-server gives up context shift and
    // cache reuse while one is loaded. As it is on disk, not as the registry remembers it: a
    // recorded path whose file is gone would stop llama-server from starting at all.
    const wantsVision = values.vision || imagePaths.length > 0
    const mmprojPath = wantsVision ? await projectorPath(model) : null
    if (wantsVision && !mmprojPath) {
      // Degrade, loudly, rather than fail: a host attaches a still to every critique turn, and
      // a model pulled without its projector would otherwise fail the whole job on the first
      // one. The prompt still names the file; the turn runs on text alone.
      const ignored = imagePaths.length > 0 ? '--image' : '--vision'
      out.log(`warning: ${model.id} has no vision projector, so ${ignored} is ignored; pull it with --mmproj to see images`)
      imagePaths = []
    }
    const images = await Promise.all(imagePaths.map(imagePart))

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
      ...(mmprojPath ? { mmprojPath } : {}),
    })
    armStall()
    handle = await acquireEngine({
      mode: engineMode,
      command: engineCommand(engine.binary),
      args: launchArgs(model.path, null, loadOpts),
      model: model.id,
      signal: controller.signal,
      log: out.log,
      idleTtlMs,
      console: engineConsole,
      onStatus: (state) => {
        armStall()
        emit({ type: 'engine.status', state })
      },
    })
    emit({ type: 'session', sessionId, model: model.id, engine: { tag: engine.tag, variant: engine.variant, port: handle.port } })

    const history = (session?.messages ?? []).filter((m) => m.role !== 'system')
    const userMessage: ChatMessage = { role: 'user', content: userContent(prompt, images) }
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history, userMessage]
    // The transcript keeps a marker per image, not the base64.
    const storedUser: ChatMessage = { role: 'user', content: transcriptContent(prompt, imagePaths) }
    const toStore: ChatMessage[] = session ? [storedUser] : [messages[0]!, storedUser]

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
      toolContext: { cwd, signal: controller.signal, vision: Boolean(mmprojPath) },
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
    // A completed turn exits 0 whatever stopped it; `stopReason` says whether it was the
    // iteration cap. Exit 1 here made a host treat a persisted, finished turn as a failure.
    return 0
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
