/**
 * `generateImages` / `upscaleImage` end to end against the fake sd-server: the events a host
 * reads and their order, seeds, previews, the exact output sizes (direct, crop, ESRGAN +
 * resample), what is sent for img2img and reference edits, capability checks, failure codes,
 * a full queue, and cancelling exactly our job.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_SD_SERVER, tempHome } from '../../test/fixtures/home'
import { seedImageModels } from '../../test/fixtures/image-home'
import type { ExecEvent } from '../shared/events'
import { stopAllImageEngines } from './engine/shared'
import { fileSink, generateImages, memorySink, upscaleImage, type RunContext } from './generate'
import { decodePng, encodePng } from './png'

describe('generateImages', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let out: string
  let events: ExecEvent[]
  const saved = { ...process.env }

  beforeEach(async () => {
    home = await tempHome()
    out = await mkdtemp(join(tmpdir(), 'obrew-img-out-'))
    events = []
    process.env.OBREW_SD_SERVER = FAKE_SD_SERVER
    process.env.OBREW_GPU_BUDGET_GIB = '24'
    process.env.FAKE_STEP_MS = '5'
    await seedImageModels()
  })
  afterEach(async () => {
    await stopAllImageEngines()
    for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_') || k === 'OBREW_SD_SERVER' || k === 'OBREW_GPU_BUDGET_GIB') delete process.env[k]
    Object.assign(process.env, saved)
    await home.cleanup()
    await rm(out, { recursive: true, force: true })
  })

  const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
    runId: 'run1',
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    log: () => {},
    activity: () => {},
    // Attached engines inherit FAKE_* on every platform (a WMI-created one on Windows would not).
    engineMode: 'ephemeral',
    pairs: {},
    sink: fileSink(out, process.cwd(), 1),
    ...overrides,
  })
  const of = <T extends ExecEvent['type']>(type: T) => events.filter((e): e is Extract<ExecEvent, { type: T }> => e.type === type)
  const sizeOf = async (path: string) => {
    const img = decodePng(new Uint8Array(await readFile(path)))
    return `${img.width}x${img.height}`
  }

  test('generates one image: started → progress → saved → completed, on a 1024² default', async () => {
    // Slow enough steps that the 250 ms poll sees some of them.
    process.env.FAKE_STEP_MS = '80'
    const result = await generateImages({ prompt: 'a lighthouse', seed: 42 }, ctx())
    expect(result).toHaveLength(1)
    const types = events.map((e) => e.type).filter((t) => t !== 'engine.status' && t !== 'image.progress')
    expect(types).toEqual(['image.started', 'image.saved', 'image.completed'])
    const started = of('image.started')[0]!
    expect(started).toMatchObject({ mode: 'generate', model: 'z-image-turbo', width: 1024, height: 1024, count: 1, seed: 42 })
    const steps = of('image.progress').filter((p) => p.phase === 'sampling' && p.step !== undefined)
    expect(steps.at(-1)).toMatchObject({ steps: 8 })
    const savedEvent = of('image.saved')[0]!
    expect(savedEvent.path).toBeDefined()
    expect(await sizeOf(savedEvent.path!)).toBe('1024x1024')
    expect(savedEvent).toMatchObject({ seed: 42, format: 'png', model: 'z-image-turbo' })
  })

  test('--count gives one job per image with consecutive seeds; previews only when asked', async () => {
    process.env.FAKE_STEP_MS = '80'
    await generateImages({ prompt: 'x', seed: 7, count: 2, aspect: '16:9', preview: true }, ctx({ sink: fileSink(out, process.cwd(), 2) }))
    const savedEvents = of('image.saved')
    expect(savedEvents.map((s) => s.seed)).toEqual([7, 8])
    expect(savedEvents.map((s) => s.index)).toEqual([0, 1])
    expect(await sizeOf(savedEvents[0]!.path!)).toBe('1280x720')
    expect(of('image.preview').length).toBeGreaterThan(0)
    events = []
    await generateImages({ prompt: 'x', seed: 1 }, ctx())
    expect(of('image.preview')).toHaveLength(0)
  })

  test('--size 1920x1080 is generated at 1920×1088 and cropped, with no upscaler involved', async () => {
    const log = join(out, 'requests.jsonl')
    process.env.FAKE_LOG_REQUESTS = log
    await generateImages({ prompt: 'x', size: { width: 1920, height: 1080 } }, ctx())
    expect(await sizeOf(of('image.saved')[0]!.path!)).toBe('1920x1080')
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(requests.map((r) => r.kind)).toEqual(['img_gen'])
    expect(requests[0]).toMatchObject({ width: 1920, height: 1088 })
  })

  test('a size beyond the native limit goes through the upscaler and comes out exact', async () => {
    await generateImages({ prompt: 'x', size: { width: 3840, height: 2160 } }, ctx())
    expect(await sizeOf(of('image.saved')[0]!.path!)).toBe('3840x2160')
    expect(of('image.progress').some((p) => p.phase === 'upscaling')).toBe(true)
  })

  test('a resampled size refuses JPEG/WebP (obrew encodes PNG only); the engine\'s own ×4 may encode them', async () => {
    await expect(generateImages({ prompt: 'x', size: { width: 1920, height: 1080 }, format: 'jpeg' }, ctx())).rejects.toMatchObject({ code: 'bad_request' })
    await expect(generateImages({ prompt: 'x', upscale: 2, format: 'webp' }, ctx())).rejects.toMatchObject({ code: 'bad_request' })
    const [four] = await generateImages({ prompt: 'x', upscale: 4, format: 'jpeg' }, ctx())
    expect(four!.format).toBe('jpeg')
  })

  test('--upscale 2 is ×4 then an exact halving', async () => {
    await generateImages({ prompt: 'x', upscale: 2 }, ctx())
    expect(await sizeOf(of('image.saved')[0]!.path!)).toBe('2048x2048')
  })

  test('reference images use the default editor and are sent as ref_images', async () => {
    const log = join(out, 'requests.jsonl')
    process.env.FAKE_LOG_REQUESTS = log
    const ref = join(out, 'ref.png')
    await Bun.write(ref, encodePng({ width: 64, height: 36, channels: 3, data: new Uint8Array(64 * 36 * 3).fill(90) }))
    await generateImages({ prompt: 'same scene in winter', refs: [ref] }, ctx())
    expect(of('image.started')[0]).toMatchObject({ mode: 'edit', model: 'flux2-klein-4b' })
    const req = JSON.parse((await readFile(log, 'utf8')).trim())
    expect(req.ref_images).toHaveLength(1)
    // No size given: the reference's 16:9 aspect, at the native area.
    expect(req.width / req.height).toBeCloseTo(16 / 9, 1)
  })

  test('img2img always sends explicit dimensions, from the input image', async () => {
    const log = join(out, 'requests.jsonl')
    process.env.FAKE_LOG_REQUESTS = log
    const init = join(out, 'init.png')
    await Bun.write(init, encodePng({ width: 90, height: 160, channels: 3, data: new Uint8Array(90 * 160 * 3).fill(10) }))
    await generateImages({ prompt: 'x', image: init, strength: 0.4 }, ctx())
    const req = JSON.parse((await readFile(log, 'utf8')).trim())
    expect(req.strength).toBe(0.4)
    // The fake logs a long string (the data URL) as its length.
    expect(req.init_image).toMatch(/^<\d+ chars>$/)
    expect(req.height).toBeGreaterThan(req.width)
  })

  test('an explicit model that cannot edit is a bad request', async () => {
    const ref = join(out, 'ref.png')
    await Bun.write(ref, encodePng({ width: 8, height: 8, channels: 3, data: new Uint8Array(192) }))
    await expect(generateImages({ prompt: 'x', model: 'z-image-turbo', refs: [ref] }, ctx())).rejects.toMatchObject({ code: 'bad_request' })
  })

  test('an engine out-of-memory failure is out_of_memory, other failures engine_failed', async () => {
    process.env.FAKE_FAIL = 'oom'
    await expect(generateImages({ prompt: 'x' }, ctx())).rejects.toMatchObject({ code: 'out_of_memory' })
    await stopAllImageEngines()
    process.env.FAKE_FAIL = 'something odd'
    await expect(generateImages({ prompt: 'x' }, ctx())).rejects.toMatchObject({ code: 'engine_failed' })
  })

  test('a full queue is waited out', async () => {
    process.env.FAKE_QUEUE_FULL = '2'
    const result = await generateImages({ prompt: 'x' }, ctx())
    expect(result).toHaveLength(1)
  })

  test('an abort cancels our job in the engine while it is generating', async () => {
    const cancelLog = join(out, 'cancel.log')
    process.env.FAKE_LOG_CANCEL = cancelLog
    process.env.FAKE_STEP_MS = '200'
    const ac = new AbortController()
    const run = generateImages({ prompt: 'x' }, ctx({ signal: ac.signal, emit: (e) => {
      events.push(e)
      if (e.type === 'image.progress' && e.step === 1) ac.abort()
    } }))
    await expect(run).rejects.toBeDefined()
    // The ephemeral engine goes with the run, so only the request is seen here; the engine
    // stopping the job is engine/jobs.test.ts and the host contract test.
    const [, step, steps] = (await readFile(cancelLog, 'utf8')).trim().match(/^job_fake_\d+ requested (\d+)\/(\d+)$/) ?? []
    expect(Number(step)).toBeLessThan(Number(steps))
  })

  test('the memory sink returns base64 and no path', async () => {
    const [image] = await generateImages({ prompt: 'x', size: { width: 512, height: 512 } }, ctx({ sink: memorySink() }))
    expect(image!.path).toBeUndefined()
    expect(decodePng(new Uint8Array(Buffer.from(image!.b64!, 'base64'))).width).toBe(512)
  })

  test('upscaleImage: ×2 and an exact size', async () => {
    const src = join(out, 'src.png')
    await Bun.write(src, encodePng({ width: 100, height: 50, channels: 3, data: new Uint8Array(100 * 50 * 3).fill(200) }))
    const two = await upscaleImage({ image: src, scale: 2 }, ctx())
    expect(`${two.width}x${two.height}`).toBe('200x100')
    const exact = await upscaleImage({ image: src, size: { width: 300, height: 120 } }, ctx())
    expect(await sizeOf(exact.path!)).toBe('300x120')
    expect(of('image.started').every((s) => s.mode === 'upscale')).toBe(true)
  })
})
