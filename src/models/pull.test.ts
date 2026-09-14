import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { FAKE_SERVER, tempHome } from '../../test/fixtures/home'
import { runLogin } from '../cli/commands/login'
import { DEFAULT_LOGIN_MODEL } from '../shared/config'
import { pullModel } from './pull'
import { defaultModelId, loadRegistry, removeModel, resolveModel, setDefault } from './registry'

/**
 * A fake Hub, served with Range support: one repo with two quants and an mmproj, and the
 * built-in default's repo with its one file, so `obrew login` can be run against it.
 */
describe('pullModel', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ReturnType<typeof Bun.serve>
  const files: Record<string, Uint8Array> = {
    'm-Q4_K_M.gguf': new Uint8Array(70_000).map((_, i) => i % 251),
    'm-Q8_0.gguf': new Uint8Array(1000).fill(7),
    'mmproj-F16.gguf': new Uint8Array(500).fill(9),
  }
  const [builtInRepo, builtInFile] = DEFAULT_LOGIN_MODEL.split(':') as [string, string]
  const repos: Record<string, Record<string, Uint8Array>> = {
    'org/repo': files,
    [builtInRepo]: { [builtInFile]: new Uint8Array(3000).fill(3) },
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
        const tree = url.pathname.match(/^\/api\/models\/([^/]+\/[^/]+)\/tree\/main$/)
        if (tree) {
          const repo = repos[tree[1]!]
          if (!repo) return new Response('nf', { status: 404 })
          return Response.json(
            Object.entries(repo).map(([path, bytes]) => ({ type: 'file', path, size: bytes.length, lfs: { oid: sha(bytes), size: bytes.length } })),
          )
        }
        const m = url.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/)
        if (m) {
          const bytes = repos[m[1]!]?.[decodeURIComponent(m[2]!)]
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

  test('pulls the preferred quant, verifies it, registers it without making it the default', async () => {
    const progress: number[] = []
    const entry = await pullModel({ spec: 'org/repo', signal: new AbortController().signal, onProgress: (_f, r) => progress.push(r) })
    expect(entry.id).toBe('org/repo:m-Q4_K_M.gguf')
    expect(entry.mmprojPath).toBeNull()
    expect(await Bun.file(entry.path).arrayBuffer()).toHaveLength(70_000)
    expect(progress.at(-1)).toBe(70_000)
    const registry = await loadRegistry()
    expect(registry.models.map((m) => m.id)).toEqual([entry.id])
    expect(registry.default).toBeNull()
    await expect(resolveModel(undefined)).rejects.toMatchObject({ code: 'model_missing' })
    expect(await resolveModel(entry.id)).toMatchObject({ id: entry.id })
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

  test('explicit file plus mmproj; use sets the default; rm of the default leaves none', async () => {
    const signal = new AbortController().signal
    const a = await pullModel({ spec: 'org/repo:m-Q4_K_M.gguf', signal })
    const b = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', mmproj: true, signal })
    expect(b.mmprojPath).toMatch(/mmproj-F16\.gguf$/)
    expect((await loadRegistry()).default).toBeNull()
    await setDefault('m-Q8_0.gguf')
    expect((await loadRegistry()).default).toBe(b.id)
    await removeModel(b.id)
    expect(await Bun.file(b.path).exists()).toBe(false)
    expect(await Bun.file(b.mmprojPath!).exists()).toBe(false)
    const registry = await loadRegistry()
    expect(registry.models.map((m) => m.id)).toEqual([a.id])
    expect(registry.default).toBeNull()
    expect(defaultModelId(registry)).toBe(DEFAULT_LOGIN_MODEL)
  })

  test('a missing model is model_missing', async () => {
    await expect(resolveModel(undefined)).rejects.toMatchObject({ code: 'model_missing' })
    await expect(resolveModel('nope')).rejects.toMatchObject({ code: 'model_missing' })
  })

  describe('obrew login', () => {
    beforeEach(() => {
      process.env.OBREW_LLAMA_SERVER = FAKE_SERVER
    })
    afterEach(() => {
      delete process.env.OBREW_LLAMA_SERVER
    })
    /** Runs login with its JSON events kept off the test output. */
    const login = async () => {
      const quiet = spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        return await runLogin(['--json'])
      } finally {
        quiet.mockRestore()
      }
    }

    test('installs the built-in default even when another model is installed and chosen', async () => {
      const other = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', signal: new AbortController().signal })
      await setDefault(other.id)
      expect(await login()).toBe(0)
      const registry = await loadRegistry()
      expect(registry.default).toBe(DEFAULT_LOGIN_MODEL)
      expect(registry.models.map((m) => m.id)).toEqual([other.id, DEFAULT_LOGIN_MODEL])
      expect(await resolveModel(undefined)).toMatchObject({ id: DEFAULT_LOGIN_MODEL })
    })

    test('downloads nothing when the built-in default is already on disk', async () => {
      expect(await login()).toBe(0)
      requests = []
      expect(await login()).toBe(0)
      expect(requests).toEqual([])
    })

    test('a file of another size is not the same model: login downloads it again', async () => {
      expect(await login()).toBe(0)
      const entry = await resolveModel(undefined)
      await writeFile(entry.path, 'GGUF')
      await expect(resolveModel(undefined)).rejects.toMatchObject({ code: 'model_missing' })
      expect(await login()).toBe(0)
      expect(Bun.file(entry.path).size).toBe(entry.sizeBytes)
      expect(await resolveModel(undefined)).toMatchObject({ id: DEFAULT_LOGIN_MODEL })
    })
  })
})
