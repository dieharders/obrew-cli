/**
 * End to end through the real entry point, against the fake llama-server, in a throwaway
 * OBREW_HOME. This is the contract a host relies on: JSON lines on stdout, exit codes,
 * resume, and failure reporting.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_SERVER, tempHome } from '../../../test/fixtures/home'
import { DEFAULT_SYSTEM_PROMPT } from '../../agent/prompts'
import { loadRegistry, saveRegistry } from '../../models/registry'
import type { ExecEvent } from '../../shared/events'
import { ExecEventSchema } from '../../shared/events'

const MAIN = join(import.meta.dir, '..', '..', 'main.ts')

/** Each run spawns obrew, which spawns the fake engine: allow well over the 5 s default. */
const TIMEOUT_MS = 30_000

async function run(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    // Ephemeral by default here: a shared fake engine would outlive the throwaway home.
    env: { ...process.env, OBREW_LLAMA_SERVER: FAKE_SERVER, OBREW_ENGINE: 'ephemeral', ...env },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const json = args.includes('--json')
  const events: ExecEvent[] = json
    ? stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => ExecEventSchema.parse(JSON.parse(line)))
    : []
  return { events, stderr, code, stdout }
}

/** The launch flags of each engine the runs started, as the fake logs them to FAKE_LOG_ARGS. */
const launches = async (log: string) =>
  (await Bun.file(log).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[])

describe('obrew exec --json', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
    const modelPath = join(home.dir, 'models', 'org--repo', 'm.gguf')
    await mkdir(join(home.dir, 'models', 'org--repo'), { recursive: true })
    await writeFile(modelPath, 'GGUF')
    await saveRegistry({
      version: 1,
      default: 'org/repo:m.gguf',
      models: [{ id: 'org/repo:m.gguf', repoId: 'org/repo', file: 'm.gguf', path: modelPath, mmprojPath: null, sizeBytes: 4, addedAt: '' }],
    })
  })
  afterEach(() => home.cleanup())

  test('streams session, deltas, completion; exit 0', async () => {
    const { events, code } = await run(['exec', '--json', 'say hi'], { FAKE_REPLY: 'Hi there!', FAKE_REASONING: 'thinking...' })
    expect(code).toBe(0)
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('engine.status')
    expect(types).toContain('session')
    expect(types).toContain('reasoning.start')
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('Hi there!')
    const done = events.at(-1)
    expect(done).toMatchObject({ type: 'turn.completed', iterations: 1, stopReason: 'stop', usage: { promptTokens: 10 } })
  }, TIMEOUT_MS)

  test('resume replays history and keeps the session id', async () => {
    const first = await run(['exec', '--json', 'first message'], { FAKE_REPLY: 'ok' })
    const session = first.events.find((e) => e.type === 'session') as { sessionId: string }
    const second = await run(['exec', 'resume', session.sessionId, '--json', 'second'], { FAKE_ECHO_LAST: '1' })
    expect(second.code).toBe(0)
    expect((second.events.find((e) => e.type === 'session') as { sessionId: string }).sessionId).toBe(session.sessionId)
    const echoed = second.events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
    expect(echoed).toBe('second')
    const show = Bun.spawnSync([process.execPath, MAIN, 'sessions', 'show', session.sessionId, '--json'], { env: process.env })
    const stored = JSON.parse(show.stdout.toString()) as { messages: Array<{ role: string }> }
    expect(stored.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant'])
  }, TIMEOUT_MS)

  test('no model → turn.failed model_missing, exit 1, hint on stderr', async () => {
    await saveRegistry({ version: 1, default: null, models: [] })
    const { events, code, stderr } = await run(['exec', '--json', 'hi'])
    expect(code).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', code: 'model_missing' })
    expect(stderr).toContain('not ready: run `obrew login`')
  }, TIMEOUT_MS)

  test('engine crash → engine_failed with the stderr tail in the message', async () => {
    const { events, code } = await run(['exec', '--json', 'hi'], { FAKE_EXIT_CODE: '2' })
    expect(code).toBe(1)
    const failed = events.at(-1) as { type: string; code: string; message: string }
    expect(failed.type).toBe('turn.failed')
    expect(failed.code).toBe('engine_failed')
    expect(failed.message).toContain('unable to load model')
  }, TIMEOUT_MS)

  test('stall → timeout', async () => {
    const { events, code } = await run(['exec', '--json', '--stall-ms', '400', 'hi'], { FAKE_REPLY: 'slow', FAKE_SLOW_MS: '2000' })
    expect(code).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', code: 'timeout' })
  }, TIMEOUT_MS)

  test('human mode prints the text on stdout', async () => {
    const { stdout, code } = await run(['exec', 'hi'], { FAKE_REPLY: 'plain text' })
    expect(code).toBe(0)
    expect(stdout).toContain('plain text')
  }, TIMEOUT_MS)

  test('--input-format json: prompt and system prompt from stdin, past the argv size cap', async () => {
    const log = join(home.dir, 'requests.jsonl')
    // Well over the ~32 KB Windows puts on a whole command line.
    const prompt = `build slide 3 ${'x'.repeat(100_000)}`
    const { code } = await run(
      ['exec', '--json', '--tools', 'none', '--input-format', 'json'],
      { FAKE_LOG_REQUESTS: log, FAKE_REPLY: 'ok' },
      JSON.stringify({ prompt, systemPrompt: 'house rules' }),
    )
    expect(code).toBe(0)
    const req = JSON.parse((await Bun.file(log).text()).trim().split('\n')[0]!) as { messages: Array<{ role: string; content: unknown }> }
    expect(req.messages[0]).toEqual({ role: 'system', content: 'house rules' })
    expect(JSON.stringify(req.messages.find((m) => m.role === 'user')!.content)).toContain(prompt)
  }, TIMEOUT_MS)

  test('--input-format json without a systemPrompt uses the default', async () => {
    const log = join(home.dir, 'requests.jsonl')
    const { code } = await run(['exec', '--json', '--tools', 'none', '--input-format', 'json'], { FAKE_LOG_REQUESTS: log, FAKE_REPLY: 'ok' }, JSON.stringify({ prompt: 'hi' }))
    expect(code).toBe(0)
    const req = JSON.parse((await Bun.file(log).text()).trim().split('\n')[0]!) as { messages: Array<{ role: string; content: unknown }> }
    expect(req.messages[0]).toEqual({ role: 'system', content: DEFAULT_SYSTEM_PROMPT })
  }, TIMEOUT_MS)

  test('--input-format json refuses a second prompt source, bad JSON and unknown fields', async () => {
    const withArg = await run(['exec', '--json', '--input-format', 'json', 'hi'], {}, JSON.stringify({ prompt: 'hi' }))
    expect(withArg.code).toBe(2)
    expect(withArg.stderr).toContain('reads the prompt and system prompt from stdin')
    const withFlag = await run(['exec', '--json', '--input-format', 'json', '--system-prompt', 'x'], {}, JSON.stringify({ prompt: 'hi' }))
    expect(withFlag.code).toBe(2)
    const garbage = await run(['exec', '--json', '--input-format', 'json'], {}, 'not json')
    expect(garbage.code).toBe(2)
    expect(garbage.stderr).toContain('stdin is not a JSON object')
    const typo = await run(['exec', '--json', '--input-format', 'json'], {}, JSON.stringify({ prompt: 'hi', system: 'x' }))
    expect(typo.code).toBe(2)
    const nothing = await run(['exec', '--json', '--input-format', 'json'])
    expect(nothing.code).toBe(2)
  }, TIMEOUT_MS)

  test('auth status reflects the fake setup', async () => {
    const proc = Bun.spawnSync([process.execPath, MAIN, 'auth', 'status', '--json'], {
      env: { ...process.env, OBREW_LLAMA_SERVER: FAKE_SERVER },
    })
    const status = JSON.parse(proc.stdout.toString()) as { ready: boolean; model: { installed: boolean } }
    expect(status.ready).toBe(true)
    expect(status.model.installed).toBe(true)
  }, TIMEOUT_MS)
})

describe('obrew exec --json with tools', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let cwd: string
  beforeEach(async () => {
    home = await tempHome()
    const modelPath = join(home.dir, 'models', 'org--repo', 'm.gguf')
    await mkdir(join(home.dir, 'models', 'org--repo'), { recursive: true })
    await writeFile(modelPath, 'GGUF')
    await saveRegistry({
      version: 1,
      default: 'org/repo:m.gguf',
      models: [{ id: 'org/repo:m.gguf', repoId: 'org/repo', file: 'm.gguf', path: modelPath, mmprojPath: null, sizeBytes: 4, addedAt: '' }],
    })
    cwd = join(home.dir, 'work')
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src', 'main.ts'), 'export const answer = 42\n')
  })
  afterEach(() => home.cleanup())

  test('Glob then Read through the real CLI, with the transcript persisted', async () => {
    const script = JSON.stringify([
      { toolCalls: [{ name: 'Glob', arguments: { pattern: '**/*.ts' } }] },
      { toolCalls: [{ name: 'Read', arguments: { path: 'src/main.ts' } }] },
      { text: 'The answer is 42.' },
    ])
    const { events, code } = await run(['exec', '--json', '--cwd', cwd, 'what is the answer'], { FAKE_SCRIPT: script })
    expect(code).toBe(0)
    const tools = events.filter((e) => e.type === 'tool.start').map((e) => (e as { name: string }).name)
    expect(tools).toEqual(['Glob', 'Read'])
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', iterations: 3, stopReason: 'stop' })
    const session = events.find((e) => e.type === 'session') as { sessionId: string }
    const show = Bun.spawnSync([process.execPath, MAIN, 'sessions', 'show', session.sessionId, '--json'], { env: process.env })
    const stored = JSON.parse(show.stdout.toString()) as { messages: Array<{ role: string }> }
    expect(stored.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
  }, TIMEOUT_MS)

  test('--output-schema puts parsed JSON on turn.completed, in one constrained request', async () => {
    const log = join(home.dir, 'requests.jsonl')
    const script = JSON.stringify([{ text: '{"n": 7}' }])
    const { events, code } = await run(
      ['exec', '--json', '--tools', 'none', '--output-schema', '{"type":"object","properties":{"n":{"type":"integer"}}}', 'how many'],
      { FAKE_SCRIPT: script, FAKE_LOG_REQUESTS: log },
    )
    expect(code).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', output: { n: 7 }, iterations: 1 })
    const reqs = (await Bun.file(log).text()).trim().split('\n')
    expect(reqs).toHaveLength(1)
    expect(JSON.parse(reqs[0]!)).toMatchObject({ response_format: { type: 'json_schema' } })
  }, TIMEOUT_MS)

  test('--input-format json carries the output schema, past the argv size cap', async () => {
    const log = join(home.dir, 'requests.jsonl')
    // Well over the ~32 KB Windows puts on a whole command line.
    const outputSchema = { type: 'object', properties: { n: { type: 'integer', description: 'x'.repeat(40_000) } }, required: ['n'] }
    const { events, code } = await run(
      ['exec', '--json', '--tools', 'none', '--input-format', 'json'],
      { FAKE_SCRIPT: JSON.stringify([{ text: '{"n": 3}' }]), FAKE_LOG_REQUESTS: log },
      JSON.stringify({ prompt: 'how many', outputSchema }),
    )
    expect(code).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', output: { n: 3 } })
    const req = JSON.parse((await Bun.file(log).text()).trim().split('\n')[0]!) as { response_format: { json_schema: { schema: unknown } } }
    expect(req.response_format.json_schema.schema).toEqual(outputSchema)
  }, TIMEOUT_MS)

  test('an output schema on stdin and --output-schema together is a usage error', async () => {
    const { code, stderr } = await run(
      ['exec', '--json', '--input-format', 'json', '--output-schema', '{"type":"object"}'],
      {},
      JSON.stringify({ prompt: 'hi', outputSchema: { type: 'object' } }),
    )
    expect(code).toBe(2)
    expect(stderr).toContain('cannot be combined')
  }, TIMEOUT_MS)

  test('--max-iterations exhaustion reports max_iterations on a completed turn (exit 0)', async () => {
    const script = JSON.stringify([{ toolCalls: [{ name: 'Glob', arguments: { pattern: '*' } }] }])
    const { events, code } = await run(['exec', '--json', '--cwd', cwd, '--max-iterations', '2', 'loop'], { FAKE_SCRIPT: script })
    expect(code).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', stopReason: 'max_iterations', iterations: 2 })
  }, TIMEOUT_MS)
})

describe('obrew exec --json with an MCP server', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
    const modelPath = join(home.dir, 'models', 'org--repo', 'm.gguf')
    await mkdir(join(home.dir, 'models', 'org--repo'), { recursive: true })
    await writeFile(modelPath, 'GGUF')
    await saveRegistry({
      version: 1,
      default: 'org/repo:m.gguf',
      models: [{ id: 'org/repo:m.gguf', repoId: 'org/repo', file: 'm.gguf', path: modelPath, mmprojPath: null, sizeBytes: 4, addedAt: '' }],
    })
  })
  afterEach(() => home.cleanup())

  test('dials the server, exposes mcp__<name>__<tool>, and feeds results back', async () => {
    const { startFakeMcp } = await import('../../../test/fixtures/fake-mcp')
    const fake = startFakeMcp()
    try {
      const script = JSON.stringify([
        { toolCalls: [{ name: 'mcp__host__add', arguments: { a: 40, b: 2 } }] },
        { toolCalls: [{ name: 'mcp__host__fail', arguments: {} }] },
        { text: 'forty-two' },
      ])
      const { events, code } = await run(['exec', '--json', '--tools', 'none', '--mcp-server', `host=${fake.url}`, 'add them'], { FAKE_SCRIPT: script })
      expect(code).toBe(0)
      const starts = events.filter((e) => e.type === 'tool.start').map((e) => (e as { name: string }).name)
      expect(starts).toEqual(['mcp__host__add', 'mcp__host__fail'])
      const results = events.filter((e) => e.type === 'tool.result') as Array<{ ok: boolean }>
      expect(results.map((r) => r.ok)).toEqual([true, false])
      expect(events.at(-1)).toMatchObject({ type: 'turn.completed', iterations: 3 })
    } finally {
      fake.stop()
    }
  }, TIMEOUT_MS)

  test('an unreachable server is a tool_error failure before the engine starts', async () => {
    const { events, code } = await run(['exec', '--json', '--mcp-server', 'dead=http://127.0.0.1:1/mcp', 'hi'])
    expect(code).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', code: 'tool_error' })
    expect(events.some((e) => e.type === 'engine.status')).toBe(false)
  }, TIMEOUT_MS)
})

describe('obrew exec --engine shared', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
    const modelPath = join(home.dir, 'models', 'org--repo', 'm.gguf')
    await mkdir(join(home.dir, 'models', 'org--repo'), { recursive: true })
    await writeFile(modelPath, 'GGUF')
    await saveRegistry({
      version: 1,
      default: 'org/repo:m.gguf',
      models: [{ id: 'org/repo:m.gguf', repoId: 'org/repo', file: 'm.gguf', path: modelPath, mmprojPath: null, sizeBytes: 4, addedAt: '' }],
    })
  })
  afterEach(async () => {
    Bun.spawnSync([process.execPath, MAIN, 'engine', 'stop'], { env: process.env })
    await home.cleanup()
  })

  test('the engine survives the first run and is reused by the second; engine stop ends it', async () => {
    const first = await run(['exec', '--json', '--engine', 'shared', 'one'], { FAKE_REPLY: 'a' })
    expect(first.code).toBe(0)
    const port1 = (first.events.find((e) => e.type === 'session') as { engine: { port: number } }).engine.port
    // Still up after obrew exited.
    expect((await fetch(`http://127.0.0.1:${port1}/health`)).status).toBe(200)

    const second = await run(['exec', '--json', '--engine', 'shared', 'two'], { FAKE_REPLY: 'b' })
    expect(second.code).toBe(0)
    const port2 = (second.events.find((e) => e.type === 'session') as { engine: { port: number } }).engine.port
    expect(port2).toBe(port1)
    expect(second.events.filter((e) => e.type === 'engine.status').map((e) => (e as { state: string }).state)).toEqual(['ready'])

    const status = Bun.spawnSync([process.execPath, MAIN, 'engine', 'status', '--json'], { env: process.env })
    expect((JSON.parse(status.stdout.toString()) as { shared: { port: number } }).shared.port).toBe(port1)

    const stop = Bun.spawnSync([process.execPath, MAIN, 'engine', 'stop'], { env: process.env })
    expect(stop.stdout.toString()).toContain('stopped 1')
    await Bun.sleep(500)
    await expect(fetch(`http://127.0.0.1:${port1}/health`)).rejects.toThrow()
  }, TIMEOUT_MS)

  test('engine start --vision warms the engine a --vision run reuses; a run without vision replaces it', async () => {
    const mmproj = join(home.dir, 'models', 'org--repo', 'mmproj.gguf')
    await writeFile(mmproj, 'GGUF')
    const registry = await loadRegistry()
    await saveRegistry({ ...registry, models: registry.models.map((m) => ({ ...m, mmprojPath: mmproj })) })
    const start = Bun.spawnSync([process.execPath, MAIN, 'engine', 'start', '--vision'], { env: { ...process.env, OBREW_LLAMA_SERVER: FAKE_SERVER } })
    expect(start.exitCode).toBe(0)
    const states = (r: Awaited<ReturnType<typeof run>>) => r.events.filter((e) => e.type === 'engine.status').map((e) => (e as { state: string }).state)

    const vision = await run(['exec', '--json', '--engine', 'shared', '--vision', '--tools', 'none', 'one'])
    expect(vision.code).toBe(0)
    expect(states(vision)).toEqual(['ready'])
    // The projector is a launch flag like any other: an engine that has one is not the engine
    // a text-only run asked for.
    const text = await run(['exec', '--json', '--engine', 'shared', '--tools', 'none', 'two'])
    expect(text.code).toBe(0)
    expect(states(text)).toContain('starting')
  }, TIMEOUT_MS)
})

describe('obrew exec --image', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let modelPath: string
  beforeEach(async () => {
    home = await tempHome()
    modelPath = join(home.dir, 'models', 'org--repo', 'm.gguf')
    await mkdir(join(home.dir, 'models', 'org--repo'), { recursive: true })
    await writeFile(modelPath, 'GGUF')
    await writeFile(join(home.dir, 'still.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })
  afterEach(() => home.cleanup())

  /** `onDisk: false` records a projector the machine does not have, as a deleted file leaves. */
  const registry = async (mmproj: string | null, onDisk = true) => {
    if (mmproj && onDisk) await writeFile(mmproj, 'GGUF')
    await saveRegistry({
      version: 1,
      default: 'org/repo:m.gguf',
      models: [{ id: 'org/repo:m.gguf', repoId: 'org/repo', file: 'm.gguf', path: modelPath, mmprojPath: mmproj, sizeBytes: 4, addedAt: '' }],
    })
  }

  test('sends the image as a data URL part and keeps a marker in the transcript', async () => {
    await registry(join(home.dir, 'mmproj.gguf'))
    const log = join(home.dir, 'requests.jsonl')
    const args = join(home.dir, 'args.jsonl')
    const { events, code } = await run(['exec', '--json', '--tools', 'none', '--image', join(home.dir, 'still.png'), 'describe'], {
      FAKE_LOG_REQUESTS: log,
      FAKE_LOG_ARGS: args,
      FAKE_REPLY: 'a picture',
    })
    expect(code).toBe(0)
    // An image to look at is the run asking for vision: the projector is loaded for it.
    expect((await launches(args))[0]).toContain('--mmproj')
    const req = JSON.parse((await Bun.file(log).text()).trim().split('\n')[0]!) as { messages: Array<{ role: string; content: unknown }> }
    const user = req.messages.find((m) => m.role === 'user')!
    expect(user.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
      { type: 'text', text: 'describe' },
    ])
    const session = events.find((e) => e.type === 'session') as { sessionId: string }
    const show = Bun.spawnSync([process.execPath, MAIN, 'sessions', 'show', session.sessionId, '--json'], { env: process.env })
    const stored = JSON.parse(show.stdout.toString()) as { messages: Array<{ role: string; content: string }> }
    expect(stored.messages[1]!.content).toMatch(/^\[image: .*still\.png\]\ndescribe$/)
  }, TIMEOUT_MS)

  test('a run that asks for no vision does not load the projector the model has', async () => {
    await registry(join(home.dir, 'mmproj.gguf'))
    const args = join(home.dir, 'args.jsonl')
    const { code } = await run(['exec', '--json', '--tools', 'none', 'describe'], { FAKE_LOG_ARGS: args })
    expect(code).toBe(0)
    expect((await launches(args))[0]).not.toContain('--mmproj')
  }, TIMEOUT_MS)

  test('a model without an mmproj drops --image with a warning and answers on text alone', async () => {
    // A host attaches a still to every critique turn; failing the turn would fail its job on
    // the first slide. The image is dropped, the log says so, and the prompt still names the
    // file for the model to Read.
    await registry(null)
    const log = join(home.dir, 'requests.jsonl')
    const { events, code, stderr } = await run(['exec', '--json', '--tools', 'none', '--image', join(home.dir, 'still.png'), 'describe'], { FAKE_LOG_REQUESTS: log })
    expect(code).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed' })
    expect(stderr).toMatch(/no vision projector/)
    const req = JSON.parse((await Bun.file(log).text()).trim().split('\n')[0]!) as { messages: Array<{ role: string; content: unknown }> }
    expect(req.messages.find((m) => m.role === 'user')!.content).toBe('describe')
  }, TIMEOUT_MS)

  test('a projector the registry records but the machine does not have degrades the same way', async () => {
    // Not a failure to start: `--mmproj <missing path>` stops llama-server dead, so a recorded
    // projector that is gone is no vision support. `obrew models pull <id>` fetches it back.
    await registry(join(home.dir, 'mmproj.gguf'), false)
    const log = join(home.dir, 'requests.jsonl')
    const { code, stderr } = await run(['exec', '--json', '--tools', 'none', '--image', join(home.dir, 'still.png'), 'describe'], { FAKE_LOG_REQUESTS: log })
    expect(code).toBe(0)
    expect(stderr).toMatch(/no vision projector/)
    const req = JSON.parse((await Bun.file(log).text()).trim().split('\n')[0]!) as { messages: Array<{ role: string; content: unknown }> }
    expect(req.messages.find((m) => m.role === 'user')!.content).toBe('describe')
  }, TIMEOUT_MS)
})

describe('obrew exec: images through Read', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let cwd: string
  let modelPath: string
  beforeEach(async () => {
    home = await tempHome()
    modelPath = join(home.dir, 'models', 'org--repo', 'm.gguf')
    await mkdir(join(home.dir, 'models', 'org--repo'), { recursive: true })
    await writeFile(modelPath, 'GGUF')
    cwd = join(home.dir, 'job')
    await mkdir(join(cwd, 'stills'), { recursive: true })
    await writeFile(join(cwd, 'stills', 'slide-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })
  afterEach(() => home.cleanup())

  const registry = async (mmproj: string | null) => {
    if (mmproj) await writeFile(mmproj, 'GGUF')
    await saveRegistry({
      version: 1,
      default: 'org/repo:m.gguf',
      models: [{ id: 'org/repo:m.gguf', repoId: 'org/repo', file: 'm.gguf', path: modelPath, mmprojPath: mmproj, sizeBytes: 4, addedAt: '' }],
    })
  }

  const readStill = JSON.stringify([{ toolCalls: [{ name: 'Read', arguments: { path: 'stills/slide-1.png' } }] }, { text: 'a slide' }])

  test('with --vision on a vision model, Read of a still hands the model the image', async () => {
    await registry(join(home.dir, 'mmproj.gguf'))
    const log = join(home.dir, 'requests.jsonl')
    const args = join(home.dir, 'args.jsonl')
    const { events, code } = await run(['exec', '--json', '--vision', '--cwd', cwd, 'critique'], { FAKE_SCRIPT: readStill, FAKE_LOG_REQUESTS: log, FAKE_LOG_ARGS: args })
    expect(code).toBe(0)
    expect((await launches(args))[0]).toContain('--mmproj')
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ ok: true })
    const second = JSON.parse((await Bun.file(log).text()).trim().split('\n')[1]!) as { messages: Array<{ role: string; content: unknown }> }
    const last = second.messages.at(-1)!
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('data:image/png;base64,iVBORw==')
  }, TIMEOUT_MS)

  test('without --vision, Read of a still is an error even though the model has its projector', async () => {
    await registry(join(home.dir, 'mmproj.gguf'))
    const args = join(home.dir, 'args.jsonl')
    const { events, code } = await run(['exec', '--json', '--cwd', cwd, '--include-tool-io', 'critique'], { FAKE_SCRIPT: readStill, FAKE_LOG_ARGS: args })
    expect(code).toBe(0)
    expect((await launches(args))[0]).not.toContain('--mmproj')
    const result = events.find((e) => e.type === 'tool.result') as { ok: boolean; output?: string }
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/--vision/)
  }, TIMEOUT_MS)

  test('without a vision model, --vision is ignored with a warning and Read of a still is an error result, not a base64 dump', async () => {
    await registry(null)
    const { events, code, stderr } = await run(['exec', '--json', '--vision', '--cwd', cwd, '--include-tool-io', 'critique'], { FAKE_SCRIPT: readStill })
    expect(code).toBe(0)
    expect(stderr).toMatch(/no vision projector, so --vision is ignored/)
    const result = events.find((e) => e.type === 'tool.result') as { ok: boolean; output?: string }
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/cannot see images/)
  }, TIMEOUT_MS)
})
