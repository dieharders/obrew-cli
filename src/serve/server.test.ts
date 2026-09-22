import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_SERVER, tempHome } from '../../test/fixtures/home'
import { readShared, stopShared } from '../engine/shared'
import { loadRegistry, saveRegistry } from '../models/registry'
import { ObrewServer } from './server'

describe('obrew serve', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ObrewServer
  let base: string

  beforeEach(async () => {
    home = await tempHome()
    process.env.OBREW_LLAMA_SERVER = FAKE_SERVER
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
    // The fake's DEFAULT reply, and no FAKE_REPLY is set anywhere in this file: whether a
    // detached engine inherits our env is platform-specific — `nohup` on POSIX passes it
    // straight down, while a process created through Win32_Process.Create gets the WMI
    // host's environment instead. Asserting on an env-driven reply only works on Windows.
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
    // The loaded model is the swap; the port is not. `freePort()` prefers 8082 upwards and
    // the engine we just replaced frees its port immediately, so the new one often rebinds it.
    expect(status2.loaded).toBe('o/r:b.gguf')
    expect(status2.port).toBeGreaterThan(0)
  })

  test('a model is loaded with its vision projector only under --vision', async () => {
    const mmproj = join(home.dir, 'models', 'o--r', 'mmproj.gguf')
    await writeFile(mmproj, 'GGUF')
    const registry = await loadRegistry()
    await saveRegistry({ ...registry, models: registry.models.map((m) => ({ ...m, mmprojPath: mmproj })) })
    const chat = async (at: string) => {
      const res = await fetch(`${at}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })
      await res.text()
      return res.status
    }
    // The shared engine's key is its launch flags, which is where a projector would show.
    expect(await chat(base)).toBe(200)
    expect((await readShared())?.key).not.toContain('--mmproj')
    const vision = new ObrewServer({ host: '127.0.0.1', port: 0, idleTtlMs: 60_000, vision: true })
    await vision.start()
    try {
      expect(await chat(`http://127.0.0.1:${vision.port}`)).toBe(200)
      expect((await readShared())?.key).toContain(`--mmproj ${mmproj}`)
    } finally {
      await vision.stop()
    }
  })

  test('an unknown model is 404, junk body 400', async () => {
    const missing = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [] }),
    })
    expect(missing.status).toBe(404)
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: 'x' })).status).toBe(400)
  })

  test('/obrew/models/pull installs a model with SSE progress and leaves the default alone', async () => {
    // A one-file fake Hub, just enough for a pull.
    const bytes = new Uint8Array(2000).fill(5)
    const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    const hub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url)
        if (pathname === '/api/models/o/r/tree/main') {
          return Response.json([{ type: 'file', path: 'c.gguf', size: bytes.length, lfs: { oid: sha256, size: bytes.length } }])
        }
        if (pathname === '/o/r/resolve/main/c.gguf') return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
        return new Response('nf', { status: 404 })
      },
    })
    process.env.HF_ENDPOINT = `http://127.0.0.1:${hub.port}`
    try {
      const pull = (body: unknown) =>
        fetch(`${base}/obrew/models/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect((await pull({})).status).toBe(400)
      const res = await pull({ spec: 'o/r:c.gguf' })
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const text = await res.text()
      expect(text).toContain('"type":"download.done"')
      expect(text).toContain('"ok":true')
      const registry = (await (await fetch(`${base}/obrew/models`)).json()) as { default: string; models: Array<{ id: string }> }
      expect(registry.models.map((m) => m.id)).toEqual(['o/r:a.gguf', 'o/r:b.gguf', 'o/r:c.gguf'])
      expect(registry.default).toBe('o/r:a.gguf')
    } finally {
      hub.stop(true)
      delete process.env.HF_ENDPOINT
    }
  })

  test('/obrew/models/default is `obrew models use` over HTTP', async () => {
    const setDefault = (body: unknown) =>
      fetch(`${base}/obrew/models/default`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await setDefault({})).status).toBe(400)
    expect((await setDefault({ id: 'o/r:nope.gguf' })).status).toBe(404)
    const res = await setDefault({ id: 'o/r:b.gguf' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ default: 'o/r:b.gguf' })
    const status = (await (await fetch(`${base}/obrew/status`)).json()) as { default: string; chosen: string | null }
    expect(status).toMatchObject({ default: 'o/r:b.gguf', chosen: 'o/r:b.gguf' })
  })

  test('/obrew/status and /obrew/models give the same answer when no default was chosen', async () => {
    await saveRegistry({ ...(await loadRegistry()), default: null })
    type View = { default: string; chosen: string | null; defaultInstalled: boolean }
    const status = (await (await fetch(`${base}/obrew/status`)).json()) as View
    const models = (await (await fetch(`${base}/obrew/models`)).json()) as View
    // Not null and not the built-in model this machine has never downloaded: the model a
    // completion with no `model` would actually run, reported the same way by both routes.
    expect(status).toMatchObject({ default: 'o/r:a.gguf', chosen: null, defaultInstalled: true })
    expect(models).toMatchObject({ default: 'o/r:a.gguf', chosen: null, defaultInstalled: true })
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
  })

  test('/v1/embeddings answers in the OpenAI shape once an embedding model is set', async () => {
    const none = await fetch(`${base}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'x' }) })
    expect(none.status).toBe(404)
    const { saveConfig } = await import('../shared/config')
    await saveConfig({ embedModel: 'o/r:b.gguf' })
    const res = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: ['ab', 'cdef'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; model: string; data: Array<{ index: number; embedding: number[] }> }
    expect(body.object).toBe('list')
    expect(body.model).toBe('o/r:b.gguf')
    expect(body.data.map((d) => d.embedding)).toEqual([[2, 1, 0], [4, 1, 0]])
  })
})
