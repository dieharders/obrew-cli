import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_SERVER, tempHome } from '../../test/fixtures/home'
import { stopShared } from '../engine/shared'
import { saveRegistry } from '../models/registry'
import { ObrewServer } from './server'

describe('obrew serve', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ObrewServer
  let base: string

  beforeEach(async () => {
    home = await tempHome()
    process.env.OBREW_LLAMA_SERVER = FAKE_SERVER
    process.env.FAKE_REPLY = 'served'
    const dir = join(home.dir, 'models', 'o--r')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.gguf'), 'GGUF')
    await writeFile(join(dir, 'b.gguf'), 'GGUF')
    await saveRegistry({
      version: 1,
      default: 'o/r:a.gguf',
      models: [
        { id: 'o/r:a.gguf', repoId: 'o/r', file: 'a.gguf', path: join(dir, 'a.gguf'), mmprojPath: null, sizeBytes: 4, addedAt: '2026-01-01T00:00:00Z' },
        { id: 'o/r:b.gguf', repoId: 'o/r', file: 'b.gguf', path: join(dir, 'b.gguf'), mmprojPath: null, sizeBytes: 4, addedAt: '2026-01-02T00:00:00Z' },
      ],
    })
    server = new ObrewServer({ host: '127.0.0.1', port: 0, idleTtlMs: 60_000 })
    await server.start()
    base = `http://127.0.0.1:${server.port}`
  })
  afterEach(async () => {
    await server.stop()
    await stopShared()
    delete process.env.OBREW_LLAMA_SERVER
    delete process.env.FAKE_REPLY
    await home.cleanup()
  })

  test('/v1/models lists the registry', async () => {
    const res = await fetch(`${base}/v1/models`)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((m) => m.id)).toEqual(['o/r:a.gguf', 'o/r:b.gguf'])
  })

  test('/v1/chat/completions streams through the engine and swaps models on demand', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    // A detached engine does not inherit this process's env, so the fake's default reply.
    expect(text).toContain('"content":"Hel"')
    expect(text).toContain('[DONE]')

    const status1 = (await (await fetch(`${base}/obrew/status`)).json()) as { loaded: string; port: number }
    expect(status1.loaded).toBe('o/r:a.gguf')

    const res2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'o/r:b.gguf', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res2.status).toBe(200)
    const status2 = (await (await fetch(`${base}/obrew/status`)).json()) as { loaded: string; port: number }
    expect(status2.loaded).toBe('o/r:b.gguf')
    expect(status2.port).not.toBe(status1.port)
  })

  test('an unknown model is 404, embeddings 501, junk body 400', async () => {
    const missing = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [] }),
    })
    expect(missing.status).toBe(404)
    expect((await fetch(`${base}/v1/embeddings`, { method: 'POST' })).status).toBe(501)
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: 'x' })).status).toBe(400)
  })
})
