/**
 * Installing image model bundles against a fake Hugging Face Hub (tree listings per revision,
 * downloads with Range support): the plan before any byte moves, smallest file first, a file two
 * bundles share fetched and stored once, files already on disk adopted or replaced, checksum and
 * disk-space failures, default slots, the registry's resolve / setSlot / remove, and custom
 * bundles named component by component.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tempHome } from '../../test/fixtures/home'
import { imageModelsDir, imageRegistryPath, upscalersDir } from './paths'
import {
  DEFAULT_EDITOR,
  DEFAULT_GENERATOR,
  DEFAULT_UPSCALER,
  type PinnedFile,
  type Role,
} from './presets'
import {
  destFor,
  parseComponentSpec,
  pullBundle,
  pullCustom,
  type BundleDefinition,
  type CustomBundle,
  type PlanFile,
  type PullCallbacks,
} from './pull'
import {
  isComplete,
  loadImageRegistry,
  removeBundle,
  resolveBundle,
  setSlot,
  slotId,
  type ImageRegistry,
  type Slot,
} from './registry'

const REV = '3b1f5a9dc3abb32238b053aeb3d823c30afdacbd'
const OLD_REV = 'c61c0e422dc8b541b7548cf33a4ef8302b0f8085'
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
/** Deterministic bytes, different for each seed. */
const blob = (size: number, seed: number) =>
  new Uint8Array(size).map((_, i) => (i * 31 + seed * 7) % 251)
const text = (s: string) => new TextEncoder().encode(s)

/** repo → revision → path → bytes. `.md` files are plain git files, which carry no LFS hash. */
const HUB: Record<string, Record<string, Record<string, Uint8Array>>> = {
  'leejet/Turbo-GGUF': { [REV]: { 'turbo-Q5_0.gguf': blob(3000, 1) } },
  'unsloth/Encoder-GGUF': { [REV]: { 'encoder-Q4_K_M.gguf': blob(2000, 2) } },
  'Comfy-Org/turbo': { [REV]: { 'split_files/vae/ae.safetensors': blob(500, 3) } },
  'leejet/Klein-GGUF': { [REV]: { 'klein-Q8_0.gguf': blob(1500, 4) } },
  'Comfy-Org/ESRGAN': { [REV]: { 'RealESRGAN_x4plus.safetensors': blob(800, 5) } },
  // The encoder's bytes again, published by another org.
  'mirror/Encoder': { [REV]: { 'enc.gguf': blob(2000, 2) } },
  // One path, re-uploaded: different bytes at main than at the older commit.
  'org/custom': {
    main: { 'models/custom-Q4_0.gguf': blob(1300, 6), 'README.md': text('# custom\n') },
    [OLD_REV]: { 'models/custom-Q4_0.gguf': blob(1100, 7), 'README.md': text('# custom (old)\n') },
  },
  // Its listing carries neither `size` nor `lfs.size`, as some published repos' do.
  'org/sizeless': { main: { 'sizeless-Q4_0.gguf': blob(900, 8) } },
}
const SIZELESS = new Set(['org/sizeless'])

const pin = (repo: string, path: string, revision = REV): PinnedFile => {
  const bytes = HUB[repo]![revision]![path]!
  return { repo, revision, path, sha256: sha(bytes), size: bytes.length }
}
const bytesOf = (f: PinnedFile) => HUB[f.repo]![f.revision]![f.path]!
const TURBO_DIT = pin('leejet/Turbo-GGUF', 'turbo-Q5_0.gguf')
const ENCODER = pin('unsloth/Encoder-GGUF', 'encoder-Q4_K_M.gguf')
const VAE = pin('Comfy-Org/turbo', 'split_files/vae/ae.safetensors')
const KLEIN_DIT = pin('leejet/Klein-GGUF', 'klein-Q8_0.gguf')
const ESRGAN = pin('Comfy-Org/ESRGAN', 'RealESRGAN_x4plus.safetensors')
const MIRRORED = pin('mirror/Encoder', 'enc.gguf')

const GENERATOR_CAPS = { generate: true, img2img: true, edit: false, upscale: false, maxRefs: 0 }
const definition = (
  id: string,
  files: BundleDefinition['files'],
  over: Partial<BundleDefinition> = {},
): BundleDefinition => ({
  id,
  preset: id,
  kind: 'generator',
  title: id,
  license: 'Apache-2.0',
  files,
  defaults: { steps: 8, cfg: 1 },
  caps: GENERATOR_CAPS,
  align: 16,
  maxPixels: 2_200_000,
  ...over,
})

/** Tiny stand-ins for the three presets. Listed largest first, so the fetch order is the pull's own. */
const TURBO = definition(DEFAULT_GENERATOR, [
  { role: 'diffusion', file: TURBO_DIT },
  { role: 'llm', file: ENCODER },
  { role: 'vae', file: VAE },
])
const KLEIN = definition(
  DEFAULT_EDITOR,
  [
    { role: 'diffusion', file: KLEIN_DIT },
    { role: 'llm', file: ENCODER },
  ],
  {
    defaults: { steps: 4, cfg: 1, sampler: 'euler' },
    caps: { ...GENERATOR_CAPS, edit: true, maxRefs: 4 },
  },
)
const UPSCALER = definition(DEFAULT_UPSCALER, [{ role: 'upscaler', file: ESRGAN }], {
  kind: 'upscaler',
  defaults: { steps: 0, cfg: 0 },
  caps: { generate: false, img2img: false, edit: false, upscale: true, maxRefs: 0, scale: 4 },
  align: 1,
  maxPixels: 0,
})

const signal = new AbortController().signal
const custom = (
  name: string,
  components: CustomBundle['components'],
  caps: CustomBundle['caps'] = {},
): CustomBundle => ({
  name,
  components,
  defaults: { steps: 20, cfg: 4.5 },
  caps,
})

describe('image model pulls', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ReturnType<typeof Bun.serve>
  let savedEndpoint: string | undefined
  let requests: string[] = []

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const range = req.headers.get('range')
        requests.push(`${req.method} ${url.pathname}${url.search}${range ? ` ${range}` : ''}`)

        const tree = url.pathname.match(/^\/api\/models\/([^/]+\/[^/]+)\/tree\/([^/]+)$/)
        if (tree) {
          const repo = tree[1]!
          const files = HUB[repo]?.[decodeURIComponent(tree[2]!)]
          if (!files) return Response.json({ error: 'Revision Not Found' }, { status: 404 })
          // Without `recursive=true` the Hub lists the top level only.
          const recursive = url.searchParams.get('recursive') === 'true'
          const sized = !SIZELESS.has(repo)
          const dirs = new Set<string>()
          const entries: object[] = []
          for (const [path, bytes] of Object.entries(files)) {
            const parts = path.split('/')
            for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
            if (!recursive && parts.length > 1) continue
            const lfs = path.endsWith('.md')
              ? {}
              : {
                  lfs: {
                    oid: sha(bytes),
                    ...(sized ? { size: bytes.length, pointerSize: 134 } : {}),
                  },
                }
            entries.push({
              type: 'file',
              oid: sha(bytes).slice(0, 40),
              path,
              ...(sized ? { size: bytes.length } : {}),
              ...lfs,
            })
          }
          for (const dir of dirs)
            if (recursive || !dir.includes('/'))
              entries.push({ type: 'directory', oid: '0'.repeat(40), path: dir, size: 0 })
          return Response.json(entries)
        }

        const resolve = url.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/)
        if (resolve) {
          const bytes =
            HUB[resolve[1]!]?.[decodeURIComponent(resolve[2]!)]?.[decodeURIComponent(resolve[3]!)]
          if (!bytes) return new Response('Entry not found', { status: 404 })
          if (range) {
            const start = Number(range.replace('bytes=', '').split('-')[0])
            if (start >= bytes.length) return new Response(null, { status: 416 })
            return new Response(bytes.slice(start), {
              status: 206,
              headers: {
                'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
                'content-length': String(bytes.length - start),
              },
            })
          }
          return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
        }
        return new Response('nf', { status: 404 })
      },
    })
    savedEndpoint = process.env.HF_ENDPOINT
    process.env.HF_ENDPOINT = `http://127.0.0.1:${server.port}`
  })
  afterAll(() => {
    server.stop(true)
    if (savedEndpoint === undefined) delete process.env.HF_ENDPOINT
    else process.env.HF_ENDPOINT = savedEndpoint
  })
  beforeEach(async () => {
    home = await tempHome()
    requests = []
  })
  afterEach(() => home.cleanup())

  const pull = (
    def: BundleDefinition,
    cb: Partial<PullCallbacks> & { makeDefault?: Slot[] } = {},
  ) => pullBundle(def, { signal, ...cb })
  const downloads = () => requests.filter((r) => r.includes('/resolve/'))
  const fetched = (f: PinnedFile) => `GET /${f.repo}/resolve/${f.revision}/${f.path}`
  async function place(role: Role, file: PinnedFile, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(destFor(role, file)), { recursive: true })
    await writeFile(destFor(role, file), bytes)
  }

  describe('pullBundle', () => {
    test('the plan goes out first: every file, where it goes, none cached, and the bytes to fetch', async () => {
      const plans: Array<{
        files: PlanFile[]
        totalBytes: number
        fetchedSoFar: number
        onDisk: boolean[]
      }> = []
      await pull(TURBO, {
        onPlan: (files, totalBytes) =>
          plans.push({
            files,
            totalBytes,
            fetchedSoFar: downloads().length,
            onDisk: files.map((f) => existsSync(f.dest)),
          }),
      })
      expect(plans).toHaveLength(1)
      expect(plans[0]!.fetchedSoFar).toBe(0)
      expect(plans[0]!.onDisk).toEqual([false, false, false])
      expect(plans[0]!.files).toEqual([
        {
          role: 'diffusion',
          file: TURBO_DIT,
          dest: destFor('diffusion', TURBO_DIT),
          cached: false,
        },
        { role: 'llm', file: ENCODER, dest: destFor('llm', ENCODER), cached: false },
        { role: 'vae', file: VAE, dest: destFor('vae', VAE), cached: false },
      ])
      expect(plans[0]!.totalBytes).toBe(3000 + 2000 + 500)
    })

    test('files are fetched smallest first, whatever order the bundle lists them in', async () => {
      await pull(TURBO)
      expect(downloads()).toEqual([fetched(VAE), fetched(ENCODER), fetched(TURBO_DIT)])
      const resolved = await resolveBundle(DEFAULT_GENERATOR, 'generator')
      expect(resolved.bytes).toBe(5500)
      for (const [role, path] of Object.entries(resolved.paths))
        expect(sha(await Bun.file(path).bytes())).toBe(resolved.hashes[role as Role]!)
    })

    test('destFor: a component at its path in the repo; an upscaler flat, where sd-server scans', () => {
      expect(destFor('vae', VAE)).toBe(
        join(imageModelsDir(), 'Comfy-Org--turbo', 'split_files', 'vae', 'ae.safetensors'),
      )
      expect(
        destFor('upscaler', { ...ESRGAN, path: 'models/x4/RealESRGAN_x4plus.safetensors' }),
      ).toBe(join(upscalersDir(), 'RealESRGAN_x4plus.safetensors'))
    })

    test('a second bundle plans the file it shares as cached and never fetches it again', async () => {
      await pull(TURBO)
      requests = []
      const plans: Array<[PlanFile[], number]> = []
      await pull(KLEIN, { onPlan: (files, total) => plans.push([files, total]) })
      expect(plans[0]![0].map((f) => [f.file.path, f.cached])).toEqual([
        ['klein-Q8_0.gguf', false],
        ['encoder-Q4_K_M.gguf', true],
      ])
      expect(plans[0]![1]).toBe(1500)
      expect(downloads()).toEqual([fetched(KLEIN_DIT)])
      const turbo = await resolveBundle(DEFAULT_GENERATOR, 'generator')
      const klein = await resolveBundle(DEFAULT_EDITOR, 'edit')
      expect(klein.paths.llm).toBe(turbo.paths.llm!)
      expect(Object.keys((await loadImageRegistry()).files)).toHaveLength(4)
    })

    test('the same bytes from another repo are known by their hash: stored once, both sources kept', async () => {
      await pull(KLEIN)
      requests = []
      await pull(
        definition('mirrored', [
          { role: 'diffusion', file: KLEIN_DIT },
          { role: 'llm', file: MIRRORED },
        ]),
      )
      expect(downloads()).toEqual([])
      expect((await loadImageRegistry()).files[ENCODER.sha256]).toEqual({
        size: ENCODER.size,
        path: destFor('llm', ENCODER),
        sources: [
          { repo: ENCODER.repo, revision: REV, path: ENCODER.path },
          { repo: MIRRORED.repo, revision: REV, path: MIRRORED.path },
        ],
      })
    })

    test('a file already at its destination is adopted with no download; one with other bytes is fetched again', async () => {
      await place('llm', ENCODER, bytesOf(ENCODER))
      await place('diffusion', TURBO_DIT, new Uint8Array(TURBO_DIT.size).fill(0xee)) // the right size, the wrong bytes
      const logs: string[] = []
      const plans: PlanFile[][] = []
      await pull(TURBO, { onLog: (m) => logs.push(m), onPlan: (files) => plans.push(files) })
      expect(plans[0]!.map((f) => f.cached)).toEqual([false, true, false])
      expect(downloads()).toEqual([fetched(VAE), fetched(TURBO_DIT)])
      expect(logs).toContain(
        `${TURBO_DIT.path} on disk does not match its checksum; downloading it again`,
      )
      expect(sha(await Bun.file(destFor('diffusion', TURBO_DIT)).bytes())).toBe(TURBO_DIT.sha256)
      expect((await loadImageRegistry()).files[ENCODER.sha256]?.path).toBe(destFor('llm', ENCODER))
      expect((await resolveBundle(DEFAULT_GENERATOR, 'generator')).bundle.id).toBe(
        DEFAULT_GENERATOR,
      )
    })

    test('a cut-off download resumes with a Range request and still verifies', async () => {
      const dest = destFor('diffusion', TURBO_DIT)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(`${dest}.partial`, bytesOf(TURBO_DIT).slice(0, 1000))
      await pull(TURBO)
      expect(downloads()).toContain(`${fetched(TURBO_DIT)} bytes=1000-`)
      expect(sha(await Bun.file(dest).bytes())).toBe(TURBO_DIT.sha256)
      expect(existsSync(`${dest}.partial`)).toBe(false)
    })

    test('a checksum mismatch fails the pull and records no bundle; what did verify is kept', async () => {
      const tampered = { ...TURBO_DIT, sha256: 'f'.repeat(64) } // the largest, so fetched last
      await expect(
        pull(
          definition('tampered', [
            { role: 'diffusion', file: tampered },
            { role: 'vae', file: VAE },
          ]),
        ),
      ).rejects.toThrow('checksum mismatch')
      const registry = await loadImageRegistry()
      expect(registry.bundles).toEqual([])
      expect(Object.keys(registry.files)).toEqual([VAE.sha256])
      expect(existsSync(destFor('diffusion', tampered))).toBe(false)
      expect(existsSync(`${destFor('diffusion', tampered)}.partial`)).toBe(false)
      await expect(resolveBundle('tampered', 'generator')).rejects.toMatchObject({
        code: 'model_missing',
      })
    })

    test('too little disk space fails after the plan and before any download', async () => {
      const huge = { ...TURBO_DIT, size: 2 ** 50 }
      const totals: number[] = []
      await expect(
        pull(
          definition('huge', [
            { role: 'diffusion', file: huge },
            { role: 'vae', file: VAE },
          ]),
          { onPlan: (_f, t) => totals.push(t) },
        ),
      ).rejects.toMatchObject({
        code: 'bad_request',
        message: expect.stringContaining('not enough disk space for huge'),
      })
      expect(totals).toEqual([2 ** 50 + VAE.size])
      expect(downloads()).toEqual([])
    })

    test('makeDefault sets the slots it names; a later pull without it changes none', async () => {
      await pull(KLEIN, { makeDefault: ['generator', 'edit'] })
      await pull(UPSCALER, { makeDefault: ['upscaler'] })
      await pull(TURBO)
      const r = await loadImageRegistry()
      expect([r.default, r.defaultEdit, r.upscaler]).toEqual([
        DEFAULT_EDITOR,
        DEFAULT_EDITOR,
        DEFAULT_UPSCALER,
      ])
      expect((await resolveBundle(null, 'generator')).bundle.id).toBe(DEFAULT_EDITOR)
      expect((await resolveBundle('default', 'edit')).bundle.id).toBe(DEFAULT_EDITOR)
      expect((await resolveBundle(undefined, 'upscaler')).bundle.id).toBe(DEFAULT_UPSCALER)
    })

    test('makeDefault never gives a slot to a bundle that cannot fill it', async () => {
      await pull(UPSCALER, { makeDefault: ['generator'] }).catch(() => {})
      expect((await loadImageRegistry()).default).toBeNull()
    })

    test('a pull again keeps the bundle’s first install time, and one entry', async () => {
      const first = await pull(TURBO)
      await Bun.sleep(5)
      expect((await pull(TURBO)).addedAt).toBe(first.addedAt)
      expect((await loadImageRegistry()).bundles).toHaveLength(1)
    })

    test(
      'a shared file fetched again from another repo, its first copy gone, is where the registry points',
      async () => {
        await pull(KLEIN)
        await rm(destFor('llm', ENCODER))
        await pull(
          definition('mirrored', [
            { role: 'diffusion', file: KLEIN_DIT },
            { role: 'llm', file: MIRRORED },
          ]),
        )
        expect(downloads()).toContain(fetched(MIRRORED))
        expect((await resolveBundle('mirrored', 'generator')).paths.llm).toBe(
          destFor('llm', MIRRORED),
        )
      },
    )
  })

  describe('the registry', () => {
    test('on a fresh machine every slot is model_missing, naming setup; nothing is fetched or written', async () => {
      for (const slot of ['generator', 'edit', 'upscaler'] as const) {
        await expect(resolveBundle(null, slot)).rejects.toMatchObject({
          code: 'model_missing',
          message: expect.stringContaining('obrew image setup'),
        })
      }
      await expect(resolveBundle('nope', 'generator')).rejects.toMatchObject({
        code: 'model_missing',
        message: expect.stringContaining('"nope"'),
      })
      expect(requests).toEqual([])
      expect(existsSync(imageRegistryPath())).toBe(false)
    })

    test('with nothing chosen, a slot resolves to its built-in preset once that is installed', async () => {
      await pull(TURBO)
      const r = await loadImageRegistry()
      expect(r.default).toBeNull()
      expect((await resolveBundle(null, 'generator')).bundle.id).toBe(DEFAULT_GENERATOR)
      await expect(resolveBundle(null, 'edit')).rejects.toMatchObject({ code: 'model_missing' })
    })

    test('slotId: the chosen id, else the built-in preset', () => {
      const empty: ImageRegistry = {
        version: 1,
        default: null,
        defaultEdit: null,
        upscaler: null,
        files: {},
        bundles: [],
      }
      expect([
        slotId(empty, 'generator'),
        slotId(empty, 'edit'),
        slotId(empty, 'upscaler'),
      ]).toEqual([DEFAULT_GENERATOR, DEFAULT_EDITOR, DEFAULT_UPSCALER])
      const chosen = { ...empty, default: 'mine', defaultEdit: 'my-editor', upscaler: 'my-x2' }
      expect([
        slotId(chosen, 'generator'),
        slotId(chosen, 'edit'),
        slotId(chosen, 'upscaler'),
      ]).toEqual(['mine', 'my-editor', 'my-x2'])
    })

    test('a bundle with a file gone, or of another size, is incomplete; model_missing names the pull that fixes it', async () => {
      await pull(TURBO)
      const r = await loadImageRegistry()
      const bundle = r.bundles[0]!
      expect(await isComplete(r, bundle)).toBe(true)
      await writeFile(destFor('vae', VAE), 'truncated')
      expect(await isComplete(r, bundle)).toBe(false)
      await rm(destFor('vae', VAE))
      expect(await isComplete(r, bundle)).toBe(false)
      expect(await isComplete({ ...r, files: {} }, bundle)).toBe(false)
      await expect(resolveBundle(DEFAULT_GENERATOR, 'generator')).rejects.toMatchObject({
        code: 'model_missing',
        message: expect.stringContaining(`obrew image models pull ${DEFAULT_GENERATOR}`),
      })
      requests = []
      await pull(TURBO)
      expect(downloads()).toEqual([fetched(VAE)])
    })

    test('setSlot gives a bundle only the slots its abilities allow', async () => {
      await pull(TURBO)
      await pull(KLEIN)
      await pull(UPSCALER)
      await expect(setSlot(DEFAULT_UPSCALER, 'generator')).rejects.toMatchObject({
        code: 'bad_request',
        message: expect.stringContaining('does not generate images'),
      })
      await expect(setSlot(DEFAULT_GENERATOR, 'edit')).rejects.toMatchObject({
        code: 'bad_request',
        message: expect.stringContaining('cannot edit'),
      })
      await expect(setSlot(DEFAULT_EDITOR, 'upscaler')).rejects.toMatchObject({
        code: 'bad_request',
        message: expect.stringContaining('not an upscaler'),
      })
      await expect(setSlot('nope', 'generator')).rejects.toMatchObject({ code: 'model_missing' })
      let r = await loadImageRegistry()
      expect([r.default, r.defaultEdit, r.upscaler]).toEqual([null, null, null])

      expect((await setSlot(DEFAULT_EDITOR, 'generator')).id).toBe(DEFAULT_EDITOR)
      await setSlot(DEFAULT_EDITOR, 'edit')
      await setSlot(DEFAULT_UPSCALER, 'upscaler')
      r = await loadImageRegistry()
      expect([slotId(r, 'generator'), slotId(r, 'edit'), slotId(r, 'upscaler')]).toEqual([
        DEFAULT_EDITOR,
        DEFAULT_EDITOR,
        DEFAULT_UPSCALER,
      ])
    })

    test('removeBundle deletes only the files no other bundle uses, and un-chooses its slots', async () => {
      await pull(TURBO, { makeDefault: ['generator'] })
      await pull(KLEIN, { makeDefault: ['edit'] })
      const first = await removeBundle(DEFAULT_GENERATOR)
      expect(first.bundle.id).toBe(DEFAULT_GENERATOR)
      expect(first.deleted.sort()).toEqual(
        [destFor('diffusion', TURBO_DIT), destFor('vae', VAE)].sort(),
      )
      expect(existsSync(destFor('diffusion', TURBO_DIT))).toBe(false)
      expect(existsSync(destFor('vae', VAE))).toBe(false)
      expect(existsSync(destFor('llm', ENCODER))).toBe(true)
      let r = await loadImageRegistry()
      expect([r.default, r.defaultEdit]).toEqual([null, DEFAULT_EDITOR])
      expect(r.bundles.map((b) => b.id)).toEqual([DEFAULT_EDITOR])
      expect(Object.keys(r.files).sort()).toEqual([ENCODER.sha256, KLEIN_DIT.sha256].sort())
      expect((await resolveBundle(null, 'edit')).paths.llm).toBe(destFor('llm', ENCODER))

      const last = await removeBundle(DEFAULT_EDITOR)
      expect(last.deleted.sort()).toEqual(
        [destFor('diffusion', KLEIN_DIT), destFor('llm', ENCODER)].sort(),
      )
      expect(existsSync(destFor('llm', ENCODER))).toBe(false)
      r = await loadImageRegistry()
      expect([r.defaultEdit, r.files, r.bundles]).toEqual([null, {}, []])
      await expect(removeBundle(DEFAULT_EDITOR)).rejects.toMatchObject({ code: 'model_missing' })
    })
  })

  describe('parseComponentSpec', () => {
    test('org/repo[@revision]:path, with main when no revision is named', () => {
      expect(parseComponentSpec('leejet/Z-Image-Turbo-GGUF:z_image_turbo-Q5_0.gguf')).toEqual({
        repo: 'leejet/Z-Image-Turbo-GGUF',
        revision: 'main',
        path: 'z_image_turbo-Q5_0.gguf',
      })
      expect(
        parseComponentSpec(` Comfy-Org/z_image_turbo@${REV}:split_files/vae/ae.safetensors `),
      ).toEqual({
        repo: 'Comfy-Org/z_image_turbo',
        revision: REV,
        path: 'split_files/vae/ae.safetensors',
      })
      expect(parseComponentSpec('org/repo@v1.0:file.gguf').revision).toBe('v1.0')
    })

    test('the path is everything after the colon that ends the repo', () => {
      expect(parseComponentSpec('org/repo:dir/a:b@2x.gguf')).toEqual({
        repo: 'org/repo',
        revision: 'main',
        path: 'dir/a:b@2x.gguf',
      })
    })

    test('anything else is a bad request', () => {
      for (const spec of [
        '',
        'org/repo',
        'org/repo:',
        'repo:file.gguf',
        'a/b/c:file.gguf',
        'org/repo@:file.gguf',
        'org/re po:file.gguf',
        '/repo:file',
      ]) {
        expect(() => parseComponentSpec(spec)).toThrow(
          expect.objectContaining({ code: 'bad_request' }),
        )
      }
    })
  })

  describe('pullCustom', () => {
    const OLD = HUB['org/custom']![OLD_REV]!['models/custom-Q4_0.gguf']!
    const LATEST = HUB['org/custom']!.main!['models/custom-Q4_0.gguf']!

    test('each component’s hash and size come from the listing at the revision named', async () => {
      const bundle = await pullCustom(
        custom('my-model', [
          { role: 'diffusion', spec: `org/custom@${OLD_REV}:models/custom-Q4_0.gguf` },
        ]),
        { signal },
      )
      expect(requests).toEqual([
        `GET /api/models/org/custom/tree/${OLD_REV}?recursive=true`,
        `GET /org/custom/resolve/${OLD_REV}/models/custom-Q4_0.gguf`,
      ])
      expect(bundle).toMatchObject({
        id: 'my-model',
        preset: null,
        kind: 'generator',
        title: 'my-model',
        license: null,
        components: [{ role: 'diffusion', sha256: sha(OLD) }],
        defaults: { steps: 20, cfg: 4.5 },
        caps: { generate: true, img2img: true, edit: false, upscale: false, maxRefs: 0 },
        align: 16,
        maxPixels: 1_100_000,
      })
      const entry = (await loadImageRegistry()).files[sha(OLD)]!
      expect(entry).toEqual({
        size: OLD.length,
        path: join(imageModelsDir(), 'org--custom', 'models', 'custom-Q4_0.gguf'),
        sources: [{ repo: 'org/custom', revision: OLD_REV, path: 'models/custom-Q4_0.gguf' }],
      })
      expect(await Bun.file(entry.path).bytes()).toEqual(OLD)
      expect((await resolveBundle('my-model', 'generator')).bytes).toBe(OLD.length)
    })

    test('no revision named means main', async () => {
      const bundle = await pullCustom(
        custom('latest', [{ role: 'diffusion', spec: 'org/custom:models/custom-Q4_0.gguf' }]),
        { signal },
      )
      expect(requests[0]).toBe('GET /api/models/org/custom/tree/main?recursive=true')
      expect(bundle.components).toEqual([{ role: 'diffusion', sha256: sha(LATEST) }])
    })

    test('a lone upscaler makes an upscaler bundle; caps given override the defaults', async () => {
      const x4 = await pullCustom(
        custom('my-x4', [{ role: 'upscaler', spec: `${ESRGAN.repo}@${REV}:${ESRGAN.path}` }]),
        { signal },
      )
      expect(x4).toMatchObject({
        kind: 'upscaler',
        caps: { generate: false, img2img: false, edit: false, upscale: true, maxRefs: 0, scale: 4 },
      })
      expect(existsSync(join(upscalersDir(), ESRGAN.path))).toBe(true)
      const editor = await pullCustom(
        custom(
          'my-editor',
          [
            { role: 'diffusion', spec: `${KLEIN_DIT.repo}@${REV}:${KLEIN_DIT.path}` },
            { role: 'llm', spec: `${ENCODER.repo}@${REV}:${ENCODER.path}` },
          ],
          { edit: true, maxRefs: 2 },
        ),
        { signal, makeDefault: ['edit'] },
      )
      expect(editor).toMatchObject({
        kind: 'generator',
        caps: { generate: true, img2img: true, edit: true, maxRefs: 2 },
      })
      expect((await loadImageRegistry()).defaultEdit).toBe('my-editor')
    })

    test('refused before anything downloads: a non-LFS file, a path not listed, an unknown role, no components', async () => {
      await expect(
        pullCustom(custom('x', [{ role: 'vae', spec: 'org/custom:README.md' }]), { signal }),
      ).rejects.toMatchObject({
        code: 'bad_request',
        message: expect.stringContaining('is not an LFS file'),
      })
      await expect(
        pullCustom(custom('x', [{ role: 'vae', spec: 'org/custom:models/missing.gguf' }]), {
          signal,
        }),
      ).rejects.toMatchObject({
        code: 'bad_request',
        message: expect.stringContaining('is not in org/custom@main'),
      })
      await expect(
        pullCustom(
          custom('x', [{ role: 'unet' as Role, spec: 'org/custom:models/custom-Q4_0.gguf' }]),
          { signal },
        ),
      ).rejects.toMatchObject({
        code: 'bad_request',
        message: 'unknown role unet',
      })
      await expect(pullCustom(custom('x', []), { signal })).rejects.toMatchObject({
        code: 'bad_request',
      })
      expect(downloads()).toEqual([])
      expect((await loadImageRegistry()).bundles).toEqual([])
    })

    test(
      'a component whose listing advertises no size still installs, and resolves',
      async () => {
        const bundle = await pullCustom(
          custom('sizeless', [{ role: 'diffusion', spec: 'org/sizeless:sizeless-Q4_0.gguf' }]),
          { signal },
        )
        expect((await resolveBundle(bundle.id, 'generator')).bytes).toBe(900)
      },
    )

    test(
      'two revisions of one path are two files: installing the second leaves the first intact',
      async () => {
        await pullCustom(
          custom('latest', [{ role: 'diffusion', spec: 'org/custom:models/custom-Q4_0.gguf' }]),
          { signal },
        )
        await pullCustom(
          custom('old', [
            { role: 'diffusion', spec: `org/custom@${OLD_REV}:models/custom-Q4_0.gguf` },
          ]),
          { signal },
        )
        expect((await resolveBundle('old', 'generator')).bytes).toBe(OLD.length)
        const latest = await resolveBundle('latest', 'generator')
        expect(sha(await Bun.file(latest.paths.diffusion!).bytes())).toBe(sha(LATEST))
      },
    )
  })
})
