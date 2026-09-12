import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { tempHome } from '../../test/fixtures/home'
import { pullModel } from './pull'
import { loadRegistry, removeModel, resolveModel, setDefault } from './registry'

/** A fake Hub: one repo with two quants and an mmproj, served with Range support. */
describe('pullModel', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ReturnType<typeof Bun.serve>
  const files: Record<string, Uint8Array> = {
    'm-Q4_K_M.gguf': new Uint8Array(70_000).map((_, i) => i % 251),
    'm-Q8_0.gguf': new Uint8Array(1000).fill(7),
    'mmproj-F16.gguf': new Uint8Array(500).fill(9),
  }
  const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')
  let requests: string[] = []

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        requests.push(`${req.method} ${url.pathname} ${req.headers.get('range') ?? ''}`.trim())
        if (url.pathname === '/api/models/org/repo/tree/main') {
          return Response.json(
            Object.entries(files).map(([path, bytes]) => ({ type: 'file', path, size: bytes.length, lfs: { oid: sha(bytes), size: bytes.length } })),
          )
        }
        const m = url.pathname.match(/^\/org\/repo\/resolve\/main\/(.+)$/)
        if (m) {
          const bytes = files[decodeURIComponent(m[1]!)]
          if (!bytes) return new Response('nf', { status: 404 })
          const range = req.headers.get('range')
          if (range) {
            const start = Number(range.replace('bytes=', '').split('-')[0])
            return new Response(bytes.slice(start), {
              status: 206,
              headers: { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length - start) },
            })
          }
          return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
        }
        return new Response('nf', { status: 404 })
      },
    })
    process.env.HF_ENDPOINT = `http://127.0.0.1:${server.port}`
  })
  afterAll(() => {
    server.stop(true)
    delete process.env.HF_ENDPOINT
  })
  beforeEach(async () => {
    home = await tempHome()
    requests = []
  })
  afterEach(() => home.cleanup())

  test('pulls the preferred quant, verifies it, registers it as default', async () => {
    const progress: number[] = []
    const entry = await pullModel({ spec: 'org/repo', signal: new AbortController().signal, onProgress: (_f, r) => progress.push(r) })
    expect(entry.id).toBe('org/repo:m-Q4_K_M.gguf')
    expect(entry.mmprojPath).toBeNull()
    expect(await Bun.file(entry.path).arrayBuffer()).toHaveLength(70_000)
    expect(progress.at(-1)).toBe(70_000)
    const registry = await loadRegistry()
    expect(registry.default).toBe(entry.id)
    expect(await resolveModel(undefined)).toMatchObject({ id: entry.id })
  })

  test('resumes a cut-off download with a Range request and still verifies', async () => {
    // What an interrupted run leaves behind: a `.partial` holding the first 30,000 bytes.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const dir = join(home.dir, 'models', 'org--repo')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'm-Q4_K_M.gguf.partial'), files['m-Q4_K_M.gguf']!.slice(0, 30_000))
    const signal = new AbortController().signal
    const entry = await pullModel({ spec: 'org/repo:m-Q4_K_M.gguf', signal })
    expect(requests.some((r) => r.includes('bytes=30000-'))).toBe(true)
    const bytes = new Uint8Array(await Bun.file(entry.path).arrayBuffer())
    expect(sha(bytes)).toBe(sha(files['m-Q4_K_M.gguf']!))
  })

  test('explicit file plus mmproj; rm removes both files; use switches default', async () => {
    const signal = new AbortController().signal
    const a = await pullModel({ spec: 'org/repo:m-Q4_K_M.gguf', signal })
    const b = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', mmproj: true, signal })
    expect(b.mmprojPath).toMatch(/mmproj-F16\.gguf$/)
    expect((await loadRegistry()).default).toBe(a.id)
    await setDefault('m-Q8_0.gguf')
    expect((await loadRegistry()).default).toBe(b.id)
    await removeModel(b.id)
    expect(await Bun.file(b.path).exists()).toBe(false)
    expect(await Bun.file(b.mmprojPath!).exists()).toBe(false)
    expect((await loadRegistry()).default).toBe(a.id)
  })

  test('a missing model is model_missing', async () => {
    await expect(resolveModel(undefined)).rejects.toMatchObject({ code: 'model_missing' })
    await expect(resolveModel('nope')).rejects.toMatchObject({ code: 'model_missing' })
  })
})
