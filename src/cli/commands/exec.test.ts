/**
 * End to end through the real entry point, against the fake llama-server, in a throwaway
 * OBREW_HOME. This is the contract a host relies on: JSON lines on stdout, exit codes,
 * resume, and failure reporting.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_SERVER, tempHome } from '../../../test/fixtures/home'
import { saveRegistry } from '../../models/registry'
import type { ExecEvent } from '../../shared/events'
import { ExecEventSchema } from '../../shared/events'

const MAIN = join(import.meta.dir, '..', '..', 'main.ts')

/** Each run spawns obrew, which spawns the fake engine: allow well over the 5 s default. */
const TIMEOUT_MS = 30_000

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    // Ephemeral by default here: a shared fake engine would outlive the throwaway home.
    env: { ...process.env, OBREW_LLAMA_SERVER: FAKE_SERVER, OBREW_ENGINE: 'ephemeral', ...env },
    stdin: 'ignore',
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

  test('--output-schema puts parsed JSON on turn.completed', async () => {
    const script = JSON.stringify([{ text: 'thinking about it' }, { text: '{"n": 7}' }])
    const { events, code } = await run(
      ['exec', '--json', '--tools', 'none', '--output-schema', '{"type":"object","properties":{"n":{"type":"integer"}}}', 'how many'],
      { FAKE_SCRIPT: script },
    )
    expect(code).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', output: { n: 7 } })
  }, TIMEOUT_MS)

  test('--max-iterations exhaustion reports max_iterations and exits 1', async () => {
    const script = JSON.stringify([{ toolCalls: [{ name: 'Glob', arguments: { pattern: '*' } }] }])
    const { events, code } = await run(['exec', '--json', '--cwd', cwd, '--max-iterations', '2', 'loop'], { FAKE_SCRIPT: script })
    expect(code).toBe(1)
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
})
