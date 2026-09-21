/**
 * The loop against the scripted fake engine. Each test starts its own fake with a
 * FAKE_SCRIPT of replies, one per chat request, and asserts both the events and the request
 * bodies the fake logged (that is where "was this request constrained" is visible).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_SERVER, tempHome } from '../../test/fixtures/home'
import { LlamaServer } from '../engine/llama-server'
import { freePort } from '../engine/ports'
import type { ExecEvent } from '../shared/events'
import { generationFor } from './effort'
import { runAgent, type AgentOptions } from './loop'
import { builtinRegistry, ToolRegistry } from './tools/registry'
import type { Tool } from './tools/types'

interface Scripted {
  text?: string
  reasoning?: string
  toolCalls?: Array<{ name: string; arguments: unknown }>
  finish?: string
}

describe('runAgent', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let cwd: string
  let server: LlamaServer | null = null
  let requestLog: string

  beforeEach(async () => {
    home = await tempHome()
    cwd = await mkdtemp(join(tmpdir(), 'obrew-loop-'))
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src', 'main.ts'), 'console.log("hi")\n')
    requestLog = join(cwd, 'requests.jsonl')
  })
  afterEach(async () => {
    await server?.stop()
    server = null
    await rm(cwd, { recursive: true, force: true })
    await home.cleanup()
  })

  async function start(script: Scripted[], template?: string) {
    const port = await freePort()
    server = await LlamaServer.start({
      command: [process.execPath, FAKE_SERVER],
      args: ['-m', 'fake', '--port', String(port)],
      port,
      model: 'fake',
      env: { FAKE_SCRIPT: JSON.stringify(script), FAKE_LOG_REQUESTS: requestLog, ...(template ? { FAKE_TEMPLATE: template } : {}) },
      logPath: null,
    })
    return server.client
  }

  async function requests(): Promise<Record<string, unknown>[]> {
    return (await readFile(requestLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  }

  const base = (client: AgentOptions['client'], registry: ToolRegistry, events: ExecEvent[]): AgentOptions => ({
    client,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read main' }],
    gen: generationFor('low'),
    registry,
    toolMode: 'native',
    toolContext: { cwd, signal: new AbortController().signal },
    maxIterations: 5,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  })

  test('native: a tool call is executed, its result fed back, and the answer streamed', async () => {
    const client = await start([
      { toolCalls: [{ name: 'Read', arguments: { path: 'src/main.ts' } }] },
      { text: 'It logs hi.' },
    ])
    const events: ExecEvent[] = []
    const result = await runAgent(base(client, builtinRegistry('Read'), events))

    expect(result.iterations).toBe(2)
    expect(result.finalText).toBe('It logs hi.')
    expect(result.stopReason).toBe('stop')
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 16 })
    expect(events.map((e) => e.type)).toEqual(['tool.start', 'tool.result', 'delta', 'delta', 'delta', 'delta'])
    expect(events[0]).toMatchObject({ type: 'tool.start', name: 'Read' })
    expect((events[0] as { input?: unknown }).input).toBeUndefined()
    expect(events[1]).toMatchObject({ type: 'tool.result', ok: true })

    // The transcript: assistant call, tool result, final answer.
    expect(result.produced.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect((result.produced[1] as { content: string }).content).toContain('console.log("hi")')

    // The first request carried the tool schemas and auto tool choice; the second did too.
    const reqs = await requests()
    expect(reqs[0]!.tool_choice).toBe('auto')
    expect((reqs[0]!.tools as unknown[]).length).toBe(1)
    expect(reqs[1]!.messages).toHaveLength(4)
  })

  test('invalid arguments are repaired under the tool schema before execution', async () => {
    const client = await start([
      { toolCalls: [{ name: 'Read', arguments: { path: 42 } }] },
      { text: '{"path":"src/main.ts"}' }, // the repair, constrained
      { text: 'done' },
    ])
    const events: ExecEvent[] = []
    const result = await runAgent({ ...base(client, builtinRegistry('Read'), events), includeToolIo: true })
    expect(result.finalText).toBe('done')
    const reqs = await requests()
    expect(reqs[1]!.response_format).toMatchObject({ type: 'json_schema' })
    expect(reqs[1]!.tools).toBeUndefined()
    expect(reqs[1]!.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(events.find((e) => e.type === 'tool.start')).toMatchObject({ input: { path: 'src/main.ts' } })
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ ok: true })
  })

  test('a failing tool and an unknown tool become error results, not loop failures', async () => {
    const client = await start([
      { toolCalls: [{ name: 'Read', arguments: { path: '../escape' } }] },
      { toolCalls: [{ name: 'Nope', arguments: {} }] },
      { text: 'ok' },
    ])
    const events: ExecEvent[] = []
    const result = await runAgent(base(client, builtinRegistry('Read'), events))
    expect(result.finalText).toBe('ok')
    const results = events.filter((e) => e.type === 'tool.result') as Array<{ ok: boolean }>
    expect(results.map((r) => r.ok)).toEqual([false, false])
    expect((result.produced[1] as { content: string }).content).toMatch(/DENIED/)
    expect((result.produced[3] as { content: string }).content).toMatch(/unknown tool "Nope"/)
  })

  test('max iterations stops the loop', async () => {
    const client = await start([{ toolCalls: [{ name: 'Glob', arguments: { pattern: '*' } }] }])
    const events: ExecEvent[] = []
    const result = await runAgent({ ...base(client, builtinRegistry('Glob'), events), maxIterations: 3 })
    expect(result.stopReason).toBe('max_iterations')
    expect(result.iterations).toBe(3)
  })

  test('universal: choose and fill are separate schema-constrained requests', async () => {
    const client = await start([
      { text: '{"tool":"Read","reason":"need the file"}' },
      { text: '{"path":"src/main.ts"}' },
      { text: '{"tool":"none"}' },
      { text: 'final answer' },
    ])
    const events: ExecEvent[] = []
    const result = await runAgent({ ...base(client, builtinRegistry('Read'), events), toolMode: 'universal' })
    expect(result.finalText).toBe('final answer')
    expect(events.filter((e) => e.type === 'tool.start')).toHaveLength(1)
    // The constrained steps do not stream text to the caller.
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('final answer')
    const reqs = await requests()
    expect(reqs[0]!.response_format).toMatchObject({ type: 'json_schema' })
    expect(JSON.stringify(reqs[0]!.response_format)).toContain('"enum":["Read","none"]')
    expect(reqs[1]!.response_format).toMatchObject({ type: 'json_schema' })
    expect(reqs[2]!.response_format).toMatchObject({ type: 'json_schema' })
    expect(reqs[3]!.response_format).toBeUndefined()
    expect(reqs[3]!.tools).toBeUndefined()
    // Choose and fill are sampled near-greedy; the free answer keeps the effort temperature.
    const gen = base(client, builtinRegistry('Read'), []).gen
    expect(reqs[0]!.temperature).toBe(0.1)
    expect(reqs[1]!.temperature).toBe(0.1)
    expect(reqs[3]!.temperature).toBe(gen.temperature)
    // The choose answer is bounded twice (see REASON_MAX_CHARS); the fill keeps the effort's cap.
    expect(JSON.stringify(reqs[0]!.response_format)).toContain(
      '"reason":{"type":"string","maxLength":200}',
    )
    expect(reqs[0]!.max_tokens).toBe(512)
    expect(reqs[1]!.max_tokens).toBe(gen.maxTokens)
  })

  test('universal: a choose cut off at max_tokens is reported on stderr and answered without a tool', async () => {
    const client = await start([
      { text: '{"tool":"Read","reason":"the still shows the still shows the', finish: 'length' },
      { text: 'final answer' },
    ])
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const events: ExecEvent[] = []
      const result = await runAgent({
        ...base(client, builtinRegistry('Read'), events),
        toolMode: 'universal',
      })
      expect(result.finalText).toBe('final answer')
      expect(events.filter((e) => e.type === 'tool.start')).toHaveLength(0)
      expect(stderr).toHaveBeenCalledWith(
        '[universal] choose stopped at max_tokens (512) before its JSON closed',
      )
    } finally {
      stderr.mockRestore()
    }
  })

  test('output schema: tools first, then one constrained request whose JSON is the output', async () => {
    const client = await start([
      { toolCalls: [{ name: 'Glob', arguments: { pattern: '**/*.ts' } }] },
      { text: 'there is one file' },
      { text: '{"count":1}' },
    ])
    const events: ExecEvent[] = []
    const result = await runAgent({
      ...base(client, builtinRegistry('Glob'), events),
      outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    })
    expect(result.output).toEqual({ count: 1 })
    expect(result.finalText).toBe('{"count":1}')
    const reqs = await requests()
    expect(reqs).toHaveLength(3)
    expect(reqs[2]!.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema: { required: ['count'] } } })
    expect(reqs[2]!.tools).toBeUndefined()
  })

  test('output schema with no tools: the constrained request is the whole turn', async () => {
    const client = await start([{ text: '{"count":1}' }])
    const events: ExecEvent[] = []
    const result = await runAgent({
      ...base(client, new ToolRegistry(), events),
      toolMode: 'none',
      outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    })
    expect(result.output).toEqual({ count: 1 })
    expect(result.iterations).toBe(1)
    expect(result.stopReason).toBe('stop')
    // The constrained answer is the turn's streamed text, so a host reading deltas gets exactly it.
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('{"count":1}')
    expect(result.produced.map((m) => m.role)).toEqual(['assistant'])
    const reqs = await requests()
    expect(reqs).toHaveLength(1)
    expect(reqs[0]!.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema: { required: ['count'] } } })
    // Straight after the user's own message: no second user turn in a row.
    expect((reqs[0]!.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user'])
  })

  test('a grammar with no tools is one request too', async () => {
    const client = await start([{ text: 'yes' }])
    const result = await runAgent({ ...base(client, new ToolRegistry(), []), toolMode: 'none', grammar: 'root ::= "yes" | "no"' })
    expect(result.finalText).toBe('yes')
    const reqs = await requests()
    expect(reqs).toHaveLength(1)
    expect(reqs[0]!.grammar).toBe('root ::= "yes" | "no"')
  })

  test('a slow tool hits the per-call timeout and is reported, not fatal', async () => {
    const slow: Tool = {
      name: 'Slow',
      description: 'sleeps',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        await Bun.sleep(2000)
        return { content: 'late' }
      },
    }
    const registry = new ToolRegistry()
    registry.add(slow)
    const client = await start([{ toolCalls: [{ name: 'Slow', arguments: {} }] }, { text: 'gave up' }])
    const events: ExecEvent[] = []
    const result = await runAgent({ ...base(client, registry, events), toolTimeoutMs: 100 })
    expect(result.finalText).toBe('gave up')
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ ok: false })
    expect((result.produced[1] as { content: string }).content).toMatch(/timed out/)
  })
})

describe('runAgent repeat guard', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let cwd: string
  let server: LlamaServer | null = null
  let requestLog: string

  beforeEach(async () => {
    home = await tempHome()
    cwd = await mkdtemp(join(tmpdir(), 'obrew-loop2-'))
    await writeFile(join(cwd, 'a.txt'), 'x')
    requestLog = join(cwd, 'requests.jsonl')
  })
  afterEach(async () => {
    await server?.stop()
    server = null
    await rm(cwd, { recursive: true, force: true })
    await home.cleanup()
  })

  test('the same call twice in a row ends tool use and forces a plain answer', async () => {
    const port = await freePort()
    server = await LlamaServer.start({
      command: [process.execPath, FAKE_SERVER],
      args: ['-m', 'fake', '--port', String(port)],
      port,
      model: 'fake',
      env: {
        FAKE_SCRIPT: JSON.stringify([
          { toolCalls: [{ name: 'Glob', arguments: { pattern: '*' } }] },
          { toolCalls: [{ name: 'Glob', arguments: { pattern: '*' } }] },
          { text: 'answer' },
        ]),
        FAKE_LOG_REQUESTS: requestLog,
      },
      logPath: null,
    })
    const events: ExecEvent[] = []
    const result = await runAgent({
      client: server.client,
      messages: [{ role: 'user', content: 'list' }],
      gen: generationFor('low'),
      registry: builtinRegistry('Glob'),
      toolMode: 'native',
      toolContext: { cwd, signal: new AbortController().signal },
      maxIterations: 10,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
    })
    expect(result.iterations).toBe(3)
    expect(result.finalText).toBe('answer')
    expect(result.stopReason).toBe('stop')
    const reqs = (await readFile(requestLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(reqs[1]!.tools).toBeDefined()
    expect(reqs[2]!.tools).toBeUndefined()
    const last = (reqs[2]!.messages as Array<{ role: string; content: string }>).at(-1)!
    expect(last.role).toBe('user')
    expect(last.content).toMatch(/repeated the same tool call/)
    expect(result.produced.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  /** A registry of counting tools: `build` changes things, `lint` only looks. */
  const counting = () => {
    const runs: string[] = []
    const registry = new ToolRegistry()
    const tool = (name: string, readOnly: boolean): Tool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      ...(readOnly ? { readOnly: true } : {}),
      execute: async (args) => {
        runs.push(`${name}:${String(args.id ?? '')}`)
        return { content: `${name} OK` }
      },
    })
    registry.add(tool('build', false))
    registry.add(tool('lint', true))
    return { registry, runs }
  }

  const run = async (script: unknown[], registry: ToolRegistry) => {
    const port = await freePort()
    server = await LlamaServer.start({
      command: [process.execPath, FAKE_SERVER],
      args: ['-m', 'fake', '--port', String(port)],
      port,
      model: 'fake',
      env: { FAKE_SCRIPT: JSON.stringify(script), FAKE_LOG_REQUESTS: requestLog },
      logPath: null,
    })
    const events: ExecEvent[] = []
    const result = await runAgent({
      client: server.client,
      messages: [{ role: 'user', content: 'build it' }],
      gen: generationFor('low'),
      registry,
      toolMode: 'native',
      toolContext: { cwd, signal: new AbortController().signal },
      maxIterations: 10,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
    })
    return { result, events }
  }

  // The motionbuff case: build → lint ("OK") → the same build. The lint in between used to hide
  // the repeat from a guard that only looked one call back.
  test('a repeat is caught across a read-only call, and is not run or reported a second time', async () => {
    const { registry, runs } = counting()
    const { result, events } = await run(
      [
        { toolCalls: [{ name: 'build', arguments: { id: 's-01' } }] },
        { toolCalls: [{ name: 'lint', arguments: {} }] },
        { toolCalls: [{ name: 'build', arguments: { id: 's-01' } }] },
        { text: 'done' },
      ],
      registry,
    )
    expect(runs).toEqual(['build:s-01', 'lint:'])
    expect(events.filter((e) => e.type === 'tool.start')).toHaveLength(2)
    expect(result.finalText).toBe('done')
    const skipped = result.produced.filter((m) => m.role === 'tool').at(-1)!
    expect(skipped.content).toMatch(/^Not run again/)
    expect(skipped.content).toContain('build OK')
    const reqs = (await readFile(requestLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(reqs.at(-1)!.tools).toBeUndefined()
  })

  test('the same check after a real change is a new check: lint → build → lint runs both lints', async () => {
    const { registry, runs } = counting()
    await run(
      [
        { toolCalls: [{ name: 'lint', arguments: {} }] },
        { toolCalls: [{ name: 'build', arguments: { id: 's-01' } }] },
        { toolCalls: [{ name: 'lint', arguments: {} }] },
        { text: 'done' },
      ],
      registry,
    )
    expect(runs).toEqual(['lint:', 'build:s-01', 'lint:'])
  })

  test('the same tool with different arguments is not a repeat', async () => {
    const { registry, runs } = counting()
    await run(
      [
        { toolCalls: [{ name: 'build', arguments: { id: 's-01' } }] },
        { toolCalls: [{ name: 'build', arguments: { id: 's-02' } }] },
        { text: 'done' },
      ],
      registry,
    )
    expect(runs).toEqual(['build:s-01', 'build:s-02'])
  })
})
