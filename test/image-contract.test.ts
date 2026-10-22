/**
 * The host contract of `obrew image`, as a host sees it: the CLI as a subprocess against the fake
 * sd-server. Every stdout line in --json mode must parse as an `ExecEvent`; success exits 0 with
 * `image.completed`, a failure exits 1 with `image.failed`, a usage mistake exits 2 with nothing
 * on stdout. Also the readiness report (`auth status --json`'s `image` block), the model listing
 * the demo reads, `upscale`, and `obrew engine stop` reaching the image engine.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecEventSchema, type ExecEvent } from '../src/shared/events'
import { encodePng } from '../src/image/png'
import { FAKE_SD_SERVER, tempHome } from './fixtures/home'
import { seedImageModels } from './fixtures/image-home'

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')

async function obrew(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

/** Every line must be a valid event; returns them parsed. */
function events(stdout: string): ExecEvent[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = ExecEventSchema.safeParse(JSON.parse(line))
      if (!parsed.success) throw new Error(`not an ExecEvent: ${line.slice(0, 200)}\n${parsed.error.message}`)
      return parsed.data
    })
}

describe('obrew image (host contract)', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let out: string
  const env = () => ({ OBREW_HOME: home.dir, OBREW_SD_SERVER: FAKE_SD_SERVER, OBREW_GPU_BUDGET_GIB: '24', FAKE_STEP_MS: '5' })

  beforeEach(async () => {
    home = await tempHome()
    out = await mkdtemp(join(tmpdir(), 'obrew-contract-'))
  })
  afterEach(async () => {
    await obrew(['image', 'engine', 'stop'], { env: env() })
    await home.cleanup()
    await rm(out, { recursive: true, force: true })
  })

  test('not set up: auth status says so, and a run fails with model_missing and exit 1', async () => {
    const status = JSON.parse((await obrew(['auth', 'status', '--json'], { env: env() })).stdout)
    expect(status.image).toMatchObject({ ready: false, edit: false, upscale: false, setup: 'obrew image setup' })
    const run = await obrew(['image', '--json', 'a cat'], { env: env() })
    expect(run.code).toBe(1)
    const evs = events(run.stdout)
    expect(evs.at(-1)).toMatchObject({ type: 'image.failed', code: 'model_missing' })
    expect(run.stderr).toContain('obrew image setup')
  })

  test('generate with the prompt on stdin: valid events only, files where asked, exit 0', async () => {
    await seedImageModels()
    const status = JSON.parse((await obrew(['auth', 'status', '--json'], { env: env() })).stdout)
    expect(status.image).toMatchObject({ ready: true, edit: true, upscale: true, model: { default: 'z-image-turbo', edit: 'flux2-klein-4b' } })
    expect(status.ready).toBe(false) // the text engine's answer is untouched by images

    const run = await obrew(['image', '--json', '--input-format', 'json', '--aspect', '16:9', '--count', '2', '--seed', '5', '--out', out], {
      env: env(),
      stdin: JSON.stringify({ prompt: 'a lighthouse at dusk', negativePrompt: 'text' }),
    })
    expect(run.code).toBe(0)
    const evs = events(run.stdout)
    const saved = evs.filter((e) => e.type === 'image.saved')
    expect(saved.map((s) => s.type === 'image.saved' && s.seed)).toEqual([5, 6])
    for (const s of saved) if (s.type === 'image.saved') expect(await Bun.file(s.path!).exists()).toBe(true)
    expect(evs.at(-1)!.type).toBe('image.completed')
  })

  test('usage mistakes exit 2 with nothing on stdout', async () => {
    const noPrompt = await obrew(['image', '--json'], { env: env() })
    expect(noPrompt.code).toBe(2)
    expect(noPrompt.stdout).toBe('')
    const badStdin = await obrew(['image', '--json', '--input-format', 'json'], { env: env(), stdin: JSON.stringify({ prompt: 'x', extra: 1 }) })
    expect(badStdin.code).toBe(2)
    expect(badStdin.stdout).toBe('')
  })

  test('models list --json, upscale, and engine stop', async () => {
    await seedImageModels()
    const list = JSON.parse((await obrew(['image', 'models', 'list', '--json'], { env: env() })).stdout)
    expect(list.default).toBe('z-image-turbo')
    expect(list.presets.map((p: { id: string }) => p.id)).toEqual(['z-image-turbo', 'flux2-klein-4b', 'realesrgan-x4plus'])
    expect(list.presets.every((p: { installed: boolean }) => p.installed)).toBe(true)
    expect(list.aspects['16:9']).toEqual([1280, 720])

    const src = join(out, 'small.png')
    await Bun.write(src, encodePng({ width: 40, height: 30, channels: 3, data: new Uint8Array(40 * 30 * 3).fill(128) }))
    const up = await obrew(['image', 'upscale', src, '--scale', '2', '--json', '--out', join(out, 'big.png')], { env: env() })
    expect(up.code).toBe(0)
    expect(events(up.stdout).find((e) => e.type === 'image.saved')).toMatchObject({ width: 80, height: 60 })

    const stop = await obrew(['engine', 'stop'], { env: env() })
    expect(stop.stdout).toMatch(/stopped [1-9]/)
  })
})
