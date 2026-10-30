/**
 * The demo server against a fake obrew CLI (./fixtures/fake-obrew.ts): what it sends the CLI
 * (argv, stdin), what it relays to the browser (SSE, file URLs), that files stay inside the
 * output directory, and that a browser going away kills the CLI.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDemo } from './server'

const FAKE = join(import.meta.dir, 'fixtures', 'fake-obrew.ts')

interface Msg {
  kind: 'event' | 'log' | 'exit'
  event?: Record<string, unknown>
  line?: string
  code?: number
}

/** POST and read every SSE frame until the stream ends. */
async function sse(url: string, body: unknown): Promise<Msg[]> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  return (await res.text())
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Msg)
}

describe('image demo server', () => {
  let out: string
  let base: string
  let logFile: string
  let stop: () => void
  const calls = async () =>
    (await readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; stdin: string; pid: number })

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'obrew-demo-'))
    logFile = join(out, 'calls.jsonl')
    process.env.OBREW_BIN = FAKE
    process.env.FAKE_OBREW_LOG = logFile
    const demo = startDemo({ port: 0, out, log: () => {} })
    base = demo.url
    stop = () => demo.server.stop(true)
  })
  afterAll(async () => {
    stop()
    delete process.env.OBREW_BIN
    delete process.env.FAKE_OBREW_LOG
    await rm(out, { recursive: true, force: true })
  })

  test('the page, use cases, status and models', async () => {
    expect((await fetch(base)).headers.get('content-type')).toContain('text/html')
    expect((await fetch(`${base}/app.js`)).status).toBe(200)
    const useCases = (await (await fetch(`${base}/api/use-cases`)).json()) as Array<{ id: string }>
    expect(useCases.map((u) => u.id)).toEqual(['thumbnail', 'character', 'photoreal', 'architecture', 'abstract', 'poster'])
    const status = (await (await fetch(`${base}/api/status`)).json()) as { image: { ready: boolean } }
    expect(status.image.ready).toBe(true)
    const models = (await (await fetch(`${base}/api/models`)).json()) as { default: string }
    expect(models.default).toBe('flux2-klein-4b')
  })

  test('generate: the prompt goes on stdin, the flags on argv, saved images come back with a URL', async () => {
    const msgs = await sse(`${base}/api/generate`, { prompt: 'a lighthouse', negativePrompt: 'text', aspect: '16:9', seed: 3, count: 1, model: 'default' })
    const saved = msgs.find((m) => m.event?.type === 'image.saved')!.event!
    expect(saved.url).toBe('/files/fake-1.png')
    expect(saved.name).toBe('fake-1.png')
    expect(msgs.some((m) => m.kind === 'log' && m.line?.includes('step 1/4'))).toBe(true)
    expect(msgs.at(-1)).toEqual({ kind: 'exit', code: 0 })
    const call = (await calls()).at(-1)!
    expect(call.argv.slice(0, 4)).toEqual(['image', '--json', '--input-format', 'json'])
    expect(call.argv).toContain('--aspect')
    expect(call.argv).not.toContain('--model')
    expect(JSON.parse(call.stdin)).toEqual({ prompt: 'a lighthouse', negativePrompt: 'text' })
    expect((await fetch(`${base}${saved.url}`)).status).toBe(200)
  })

  test('uploads become --ref / --image paths; nothing outside the output directory is reachable', async () => {
    const up = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-filename': 'me.png' }, body: new Uint8Array([1, 2, 3]) })
    const { name } = (await up.json()) as { name: string }
    expect(name).toMatch(/^uploads\/\d+-me\.png$/)
    await sse(`${base}/api/generate`, { prompt: 'same', refs: [name] })
    const argv = (await calls()).at(-1)!.argv
    expect(argv[argv.indexOf('--ref') + 1]).toBe(join(out, name))

    const escape = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', refs: ['../../etc/passwd'] }) })
    expect(escape.status).toBe(400)
    expect((await fetch(`${base}/files/..%2Fcalls.jsonl`)).status).toBe(404)
    expect((await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415)
  })

  test('setup and upscale are relayed', async () => {
    const setup = await sse(`${base}/api/setup`, {})
    expect(setup.map((m) => m.event?.type).filter(Boolean)).toEqual(['download.plan', 'download.progress', 'setup.done'])
    await sse(`${base}/api/upscale`, { file: 'fake-1.png', scale: 2 })
    const argv = (await calls()).at(-1)!.argv
    expect(argv.slice(0, 2)).toEqual(['image', 'upscale'])
    expect(argv).toContain('--scale')
  })

  test('a browser that goes away kills the CLI', async () => {
    process.env.FAKE_OBREW_SLOW = '1'
    try {
      const ac = new AbortController()
      const res = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'slow' }), signal: ac.signal })
      const reader = res.body!.getReader()
      await reader.read() // the first frame: the CLI is running
      ac.abort()
      await reader.cancel().catch(() => {})
      const { pid } = (await calls()).at(-1)!
      let alive = true
      for (let i = 0; i < 50 && alive; i++) {
        await Bun.sleep(100)
        try {
          process.kill(pid, 0)
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)
    } finally {
      delete process.env.FAKE_OBREW_SLOW
    }
  })
})
