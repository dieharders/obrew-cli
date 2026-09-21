import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { FAKE_SERVER, tempHome } from '../../test/fixtures/home'
import { authStatus } from '../cli/commands/auth'
import { runLogin } from '../cli/commands/login'
import { modelId, parseModelSpec } from './hf'
import { pullModel } from './pull'
import { BUILT_IN_DEFAULT_MODEL, defaultModelId, loadRegistry, removeModel, resolveModel, saveRegistry, setDefault } from './registry'

/**
 * A fake Hub, served with Range support: one repo with two quants and an mmproj, the built-in
 * default's repo with its one file so `obrew login` can be run against it, and one repo whose
 * listing advertises no sizes at all.
 */
describe('pullModel', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ReturnType<typeof Bun.serve>
  const files: Record<string, Uint8Array> = {
    'm-Q4_K_M.gguf': new Uint8Array(70_000).map((_, i) => i % 251),
    'm-Q8_0.gguf': new Uint8Array(1000).fill(7),
    'mmproj-F16.gguf': new Uint8Array(500).fill(9),
  }
  // Derived, not split by hand: the constant may name a repo with no file, and then the id to
  // expect is whatever `chooseGguf` picks out of the repo — not the constant itself.
  const builtIn = parseModelSpec(BUILT_IN_DEFAULT_MODEL)
  const builtInFile = builtIn.file ?? 'built-in-Q8_0.gguf'
  const builtInId = modelId(builtIn.repoId, builtInFile)
  /** A repo whose tree carries neither `size` nor `lfs.size`, as some published repos do. */
  const SIZELESS = 'org/sizeless'
  const repos: Record<string, Record<string, Uint8Array>> = {
    'org/repo': files,
    [builtIn.repoId]: { [builtInFile]: new Uint8Array(3000).fill(3) },
    [SIZELESS]: { 'n-Q4_K_M.gguf': new Uint8Array(1200).fill(11) },
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
          const sized = tree[1] !== SIZELESS
          return Response.json(
            Object.entries(repo).map(([path, bytes]) => ({
              type: 'file',
              path,
              ...(sized ? { size: bytes.length } : {}),
              lfs: { oid: sha(bytes), ...(sized ? { size: bytes.length } : {}) },
            })),
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

  test('pulls the preferred quant, verifies it, and chooses no default — but is what `exec` runs', async () => {
    const progress: number[] = []
    const entry = await pullModel({ spec: 'org/repo', signal: new AbortController().signal, onProgress: (_f, r) => progress.push(r) })
    expect(entry.id).toBe('org/repo:m-Q4_K_M.gguf')
    expect(entry.mmprojPath).toBeNull()
    expect(entry.sizeBytes).toBe(70_000)
    expect(await Bun.file(entry.path).arrayBuffer()).toHaveLength(70_000)
    expect(progress.at(-1)).toBe(70_000)
    const registry = await loadRegistry()
    expect(registry.models.map((m) => m.id)).toEqual([entry.id])
    // Nothing was chosen — and the only model installed is still the one a bare `obrew exec`
    // has to run, or a machine set up with `models pull` alone could not run anything.
    expect(registry.default).toBeNull()
    expect(defaultModelId(registry)).toBe(entry.id)
    expect(await resolveModel(undefined)).toMatchObject({ id: entry.id })
    expect(await resolveModel('default')).toMatchObject({ id: entry.id })
    expect(await resolveModel(entry.id)).toMatchObject({ id: entry.id })
  })

  test('a listing that advertises no size still installs, and stays installed', async () => {
    const entry = await pullModel({ spec: SIZELESS, signal: new AbortController().signal })
    // The size recorded is the file's own, not the listing's 0, so `isOnDisk` has something
    // to compare against and the model is not re-fetched on every later run.
    expect(entry.sizeBytes).toBe(1200)
    expect(await resolveModel(entry.id)).toMatchObject({ id: entry.id })
    requests = []
    await pullModel({ spec: `${SIZELESS}:n-Q4_K_M.gguf`, signal: new AbortController().signal })
    expect(requests).toEqual([])
  })

  test('an entry recorded with an unknown size is judged on existence alone', async () => {
    const entry = await pullModel({ spec: SIZELESS, signal: new AbortController().signal })
    const registry = await loadRegistry()
    registry.models = registry.models.map((m) => ({ ...m, sizeBytes: 0 }))
    await saveRegistry(registry)
    expect(await resolveModel(entry.id)).toMatchObject({ id: entry.id })
    await rm(entry.path)
    await expect(resolveModel(entry.id)).rejects.toMatchObject({ code: 'model_missing' })
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

  test('explicit file plus mmproj; use sets the default; rm of it falls back to what is left', async () => {
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
    // The choice is gone with the model it named, but the machine still has one it can run,
    // so that is what `exec` falls back to — not the built-in model it has never downloaded.
    expect(registry.default).toBeNull()
    expect(defaultModelId(registry)).toBe(a.id)
    expect(await resolveModel(undefined)).toMatchObject({ id: a.id })
  })

  test('a pull never takes the default away from the model that holds it', async () => {
    const signal = new AbortController().signal
    const a = await pullModel({ spec: 'org/repo:m-Q4_K_M.gguf', signal })
    await setDefault(a.id)
    const b = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', signal })
    const registry = await loadRegistry()
    expect(registry.default).toBe(a.id)
    expect(defaultModelId(registry)).toBe(a.id)
    expect(b.id).not.toBe(a.id)
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
    const login = async (...args: string[]) => {
      const quiet = spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        return await runLogin(['--json', ...args])
      } finally {
        quiet.mockRestore()
      }
    }

    /** One listing and one projector download: what login costs a model that is already here. */
    const PROJECTOR_ONLY = ['GET /api/models/org/repo/tree/main', 'GET /org/repo/resolve/main/mmproj-F16.gguf']

    test('a fresh install gets the built-in default, set as the default', async () => {
      expect(await login()).toBe(0)
      const registry = await loadRegistry()
      expect(registry.default).toBe(builtInId)
      expect(registry.models.map((m) => m.id)).toEqual([builtInId])
    })

    test('--model names one explicitly and replaces a default that was already chosen', async () => {
      const chosen = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', signal: new AbortController().signal })
      await setDefault(chosen.id)
      expect(await login('--model', 'org/repo:m-Q4_K_M.gguf')).toBe(0)
      const registry = await loadRegistry()
      expect(registry.default).toBe('org/repo:m-Q4_K_M.gguf')
      expect(registry.models.map((m) => m.id).sort()).toEqual(['org/repo:m-Q4_K_M.gguf', chosen.id])
    })

    test('a model pulled but never chosen is what login installs, not the built-in one', async () => {
      const pulled = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', signal: new AbortController().signal })
      requests = []
      expect(await login()).toBe(0)
      // Its repo publishes a projector, so that is fetched — and nothing else is.
      expect(requests).toEqual(PROJECTOR_ONLY)
      const registry = await loadRegistry()
      expect(registry.default).toBe(pulled.id)
      expect(registry.models.map((m) => m.id)).toEqual([pulled.id])
    })

    test('a default whose vision projector went missing has it fetched again', async () => {
      const chosen = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', mmproj: true, signal: new AbortController().signal })
      await setDefault(chosen.id)
      await rm(chosen.mmprojPath!)
      expect(await login()).toBe(0)
      // Not "already installed": the entry claims vision, and llama-server does not start with
      // `--mmproj` pointing at nothing.
      expect(await Bun.file(chosen.mmprojPath!).exists()).toBe(true)
      expect((await loadRegistry()).models[0]?.mmprojPath).toBe(chosen.mmprojPath)
    })

    test('a chosen default is respected: login leaves it alone and never installs the built-in one', async () => {
      const chosen = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', signal: new AbortController().signal })
      await setDefault(chosen.id)
      requests = []
      expect(await login()).toBe(0)
      // Its repo publishes a projector, so that is fetched — and nothing else is.
      expect(requests).toEqual(PROJECTOR_ONLY)
      const registry = await loadRegistry()
      expect(registry.default).toBe(chosen.id)
      expect(registry.models.map((m) => m.id)).toEqual([chosen.id])
    })

    test('a chosen default that is missing is downloaded again, not swapped for the built-in one', async () => {
      const chosen = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', signal: new AbortController().signal })
      await setDefault(chosen.id)
      await rm(chosen.path)
      expect(await login()).toBe(0)
      expect(Bun.file(chosen.path).size).toBe(chosen.sizeBytes)
      const registry = await loadRegistry()
      expect(registry.default).toBe(chosen.id)
      expect(registry.models.map((m) => m.id)).toEqual([chosen.id])
    })

    test('a fresh login of a vision model fetches its projector with it', async () => {
      expect(await login('--model', 'org/repo:m-Q8_0.gguf')).toBe(0)
      const entry = (await loadRegistry()).models[0]!
      expect(entry.mmprojPath).toMatch(/mmproj-F16\.gguf$/)
      expect(entry.mmprojPublished).toBe(true)
      expect(await Bun.file(entry.mmprojPath!).exists()).toBe(true)
    })

    test('an install from before projectors were fetched gets one, and its model is not downloaded again', async () => {
      // The state MotionBuff's bare `obrew login` left behind (job-20260921211527-3d1aba52b673):
      // the model on disk, no projector, and an entry that never recorded whether one exists.
      const pulled = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', signal: new AbortController().signal })
      await setDefault(pulled.id)
      const registry = await loadRegistry()
      registry.models = registry.models.map(({ mmprojPublished: _, ...m }) => m)
      await saveRegistry(registry)
      requests = []
      expect(await login()).toBe(0)
      expect(requests).toEqual(PROJECTOR_ONLY)
      const entry = (await loadRegistry()).models[0]!
      expect(entry.mmprojPath).toMatch(/mmproj-F16\.gguf$/)
      expect(entry.mmprojPublished).toBe(true)
      expect(entry.addedAt).toBe(pulled.addedAt)
      // And then it is settled: the next login asks nothing.
      requests = []
      expect(await login()).toBe(0)
      expect(requests).toEqual([])
    })

    test('a text-only repo is recorded as one, so login succeeds and never asks again', async () => {
      expect(await login()).toBe(0)
      const entry = (await loadRegistry()).models[0]!
      expect(entry.mmprojPath).toBeNull()
      expect(entry.mmprojPublished).toBe(false)
    })

    test('an installed model whose size the listing does not advertise is not downloaded again for a projector check', async () => {
      const pulled = await pullModel({ spec: SIZELESS, signal: new AbortController().signal })
      await setDefault(pulled.id)
      const registry = await loadRegistry()
      registry.models = registry.models.map(({ mmprojPublished: _, ...m }) => m)
      await saveRegistry(registry)
      requests = []
      expect(await login()).toBe(0)
      expect(requests).toEqual([`GET /api/models/${SIZELESS}/tree/main`])
    })

    test('a machine that cannot reach the Hub stays set up when only the projector was being checked', async () => {
      const pulled = await pullModel({ spec: 'org/repo:m-Q8_0.gguf', signal: new AbortController().signal })
      await setDefault(pulled.id)
      const endpoint = process.env.HF_ENDPOINT
      process.env.HF_ENDPOINT = 'http://127.0.0.1:1'
      try {
        expect(await login()).toBe(0)
      } finally {
        process.env.HF_ENDPOINT = endpoint
      }
      expect((await loadRegistry()).models[0]?.mmprojPath).toBeNull()
    })

    test('--no-mmproj downloads no projector', async () => {
      expect(await login('--model', 'org/repo:m-Q8_0.gguf', '--no-mmproj')).toBe(0)
      expect(requests.some((r) => r.includes('mmproj'))).toBe(false)
      expect((await loadRegistry()).models[0]?.mmprojPath).toBeNull()
    })

    test('--mmproj stays strict: a text-only repo fails the login', async () => {
      expect(await login('--mmproj')).toBe(1)
    })

    test('auth status reports vision once the projector is on disk', async () => {
      await pullModel({ spec: 'org/repo:m-Q8_0.gguf', makeDefault: true, signal: new AbortController().signal })
      expect((await authStatus()).model).toMatchObject({ installed: true, vision: false, visionPublished: true })
      expect(await login()).toBe(0)
      expect((await authStatus()).model).toMatchObject({ installed: true, vision: true, visionPublished: true })
    })

    test('downloads nothing when the default is already on disk', async () => {
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
      expect(await resolveModel(undefined)).toMatchObject({ id: builtInId })
    })
  })
})
