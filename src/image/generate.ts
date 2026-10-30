/**
 * Make images: the one implementation behind `obrew image`, `obrew image upscale` and
 * `obrew serve`'s `/v1/images/generations`. Where the images go is the caller's `ImageSink` (a
 * file per image for the CLI, memory for `serve`); everything else is here.
 *
 * One run, in order:
 *  1. the mode from the inputs: `--ref` images → edit (reference images), `--image` → img2img,
 *     neither → text to image; the bundle from `--model`, else the slot's default (an edit falls
 *     back to the default EDITOR, since the default generator may not edit), checked against
 *     what the bundle can do;
 *  2. the size plan (./size.ts): what to generate, and whether to upscale and resample after;
 *  3. the warm engine (./engine/shared.ts), started or reused;
 *  4. one sd-server job per image (`--count`), seeds `seed, seed+1, …`, so progress is per image
 *     and a cancel keeps the images already finished. Each job is submitted, recorded for the
 *     orphan reaper, and polled every 250 ms: queue position, step and preview become
 *     `image.progress` / `image.preview`, and every change is a sign of life for the caller's
 *     stall timer. An abort cancels THIS job (`POST /sdcpp/v1/jobs/{id}/cancel`), nobody else's.
 *  5. post-processing in-process: ESRGAN through the same engine (`POST /sdcpp/v1/upscale`),
 *     then an exact resample (./png.ts) — so `--size 1920x1080` really is 1920×1080.
 *
 * img2img sends explicit dimensions on purpose: sd-server, given an init image and no size,
 * falls back to 512×512 and centre-crops the input to a square (measured on master-987).
 */
import { randomInt } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { logTail } from '../engine/llama-server'
import { isAbortError, ObrewError } from '../shared/errors'
import type { ExecEvent } from '../shared/events'
import { SdHttpError, type ImgGenRequest, type Job } from './engine/client'
import { detectHardware } from './engine/hardware'
import { requireImageEngine } from './engine/install'
import { recordJob, removeJob } from './engine/jobs'
import { acquireImageEngine, engineFailure, type ImageEngineHandle } from './engine/shared'
import { serverLogPath } from './paths'
import { coverResize, decodePng, encodePng, halve, isBlank, readImageSize } from './png'
import { resolveBundle, type ResolvedBundle } from './registry'
import { MAX_UPSCALED_SIDE, planSize, type Aspect, type Size, type SizePlan } from './size'

export type ImageFormat = 'png' | 'jpeg' | 'webp'
export type ImageMode = 'generate' | 'img2img' | 'edit' | 'upscale'

/** The size limit an input image may have: what `exec --image` allows too. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const POLL_MS = 250

export interface InputImage {
  bytes: Uint8Array
  size: Size
  format: ImageFormat
}

export async function readInputImage(source: string | Uint8Array, label: string): Promise<InputImage> {
  let bytes: Uint8Array
  if (typeof source === 'string') {
    const file = Bun.file(source)
    if (!(await file.exists())) throw new ObrewError('bad_request', `${label}: ${source} not found`)
    if (file.size > MAX_INPUT_BYTES) throw new ObrewError('bad_request', `${label}: ${source} is over 20 MB`)
    bytes = new Uint8Array(await file.arrayBuffer())
  } else {
    bytes = source
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new ObrewError('bad_request', `${label} is over 20 MB`)
  }
  const info = readImageSize(bytes)
  if (!info) throw new ObrewError('bad_request', `${label} is not a PNG, JPEG or WebP image`)
  return { bytes, size: { width: info.width, height: info.height }, format: info.format }
}

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const dataUrl = (bytes: Uint8Array, format: ImageFormat) => `data:image/${format};base64,${toB64(bytes)}`

export interface SavedImage {
  index: number
  path?: string
  b64?: string
  width: number
  height: number
  seed: number | null
  format: ImageFormat
  bytes: number
}

export interface ImageSink {
  save(img: { index: number; bytes: Uint8Array; width: number; height: number; seed: number | null; format: ImageFormat }): Promise<{ path?: string; b64?: string }>
}

const EXT: Record<ImageFormat, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' }
export const formatOfPath = (path: string): ImageFormat | null => {
  const ext = extname(path).toLowerCase()
  return ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext === '.webp' ? 'webp' : null
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Files. `out` naming a file (by extension) writes there, numbered when `count` > 1: that name is
 * the caller's to overwrite. Otherwise `out` (default: the working directory) is a directory and
 * names are `obrew-<date>-<time>-<seed>[-n].png`, created exclusively so nothing is overwritten.
 */
export function fileSink(out: string | undefined, cwd: string, count: number): ImageSink {
  const target = resolve(cwd, out ?? '.')
  const isFile = out !== undefined && formatOfPath(out) !== null
  const runStamp = stamp()
  return {
    async save(img) {
      if (isFile) {
        const ext = extname(target)
        const path = count > 1 ? `${target.slice(0, -ext.length)}-${img.index + 1}${ext}` : target
        await mkdir(dirname(path), { recursive: true })
        await Bun.write(path, img.bytes)
        return { path }
      }
      await mkdir(target, { recursive: true })
      const stem = `obrew-${runStamp}-${img.seed ?? 'upscaled'}${count > 1 ? `-${img.index + 1}` : ''}`
      for (let n = 1; ; n++) {
        const path = join(target, `${stem}${n > 1 ? `-${n}` : ''}${EXT[img.format]}`)
        try {
          const fh = await open(path, 'wx')
          try {
            await fh.writeFile(img.bytes)
          } finally {
            await fh.close()
          }
          return { path }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
      }
    },
  }
}

/** Memory: the image comes back as base64 on the event and the result (`obrew serve`). */
export const memorySink = (): ImageSink => ({ save: async (img) => ({ b64: toB64(img.bytes) }) })

export interface RunContext {
  runId: string
  signal: AbortSignal
  emit: (event: ExecEvent) => void
  log: (message: string) => void
  /** A sign of life: the caller's stall timer starts over. */
  activity: () => void
  engineMode: 'shared' | 'ephemeral'
  pairs: Record<string, unknown>
  idleTtlMs?: number
  console?: boolean
  sink: ImageSink
}

export interface GenerateRequest {
  prompt: string
  negativePrompt?: string
  model?: string
  aspect?: Aspect
  size?: Size
  steps?: number
  cfg?: number
  seed?: number
  count?: number
  /** img2img: the image to start from. */
  image?: string | Uint8Array
  strength?: number
  /** Reference images: edits, variations, the same character in a new scene. */
  refs?: Array<string | Uint8Array>
  upscale?: 2 | 4
  format?: ImageFormat
  /** Emit `image.preview` frames. */
  preview?: boolean
}

export const newRunId = () => `img_${Date.now().toString(36)}${randomInt(0, 36 ** 4).toString(36)}`

function checkCaps(resolved: ResolvedBundle, mode: ImageMode, refs: number, explicit: boolean): void {
  const { bundle } = resolved
  if (mode === 'edit' && !bundle.caps.edit) {
    throw new ObrewError('bad_request', `${bundle.id} cannot edit with reference images${explicit ? '; drop --model to use the default editor' : ''}`)
  }
  if (mode === 'edit' && refs > bundle.caps.maxRefs) throw new ObrewError('bad_request', `${bundle.id} takes at most ${bundle.caps.maxRefs} reference images`)
  if (mode === 'img2img' && !bundle.caps.img2img) throw new ObrewError('bad_request', `${bundle.id} does not do image-to-image`)
  if (mode === 'generate' && !bundle.caps.generate) throw new ObrewError('bad_request', `${bundle.id} does not generate images`)
}

/** The installed upscaler, as sd-server names it: the file's stem in `--hires-upscalers-dir`. */
async function resolveUpscaler(): Promise<{ id: string; name: string; scale: number }> {
  const resolved = await resolveBundle(null, 'upscaler').catch((err) => {
    if (err instanceof ObrewError && err.code === 'model_missing') {
      throw new ObrewError('model_missing', 'upscaling needs the upscaler; run `obrew image setup` or `obrew image models pull realesrgan-x4plus`')
    }
    throw err
  })
  const path = resolved.paths.upscaler
  if (!path || !resolved.bundle.caps.upscale) throw new ObrewError('model_missing', `${resolved.bundle.id} is not an upscaler`)
  const file = basename(path)
  return { id: resolved.bundle.id, name: file.slice(0, file.length - extname(file).length), scale: resolved.bundle.caps.scale ?? 4 }
}

function httpFailure(err: unknown, what: string): Error {
  if (isAbortError(err)) return err as Error
  if (err instanceof SdHttpError) {
    if (err.status === 400) return new ObrewError('bad_request', err.message)
    if (err.status === 404 || err.status === 410) return new ObrewError('engine_failed', `${what}: the image engine was restarted or replaced`)
    return engineFailure(err.message)
  }
  return engineFailure(`${what}: the image engine stopped answering (${err instanceof Error ? err.message : String(err)})`)
}

async function submit(handle: ImageEngineHandle, body: ImgGenRequest, ctx: RunContext): Promise<string> {
  let wait = 500
  for (;;) {
    try {
      return await handle.client.submit(body, ctx.signal)
    } catch (err) {
      // A full queue, or a model still loading: wait. The caller's stall timer bounds this.
      const busy = err instanceof SdHttpError && (err.status === 429 || (err.status === 503 && err.code === 'model_loading'))
      if (!busy || ctx.signal.aborted) {
        const failure = httpFailure(err, 'submitting the image job')
        if (failure instanceof ObrewError && failure.code === 'engine_failed') throw engineFailure(failure.message, await logTail(serverLogPath(), 15))
        throw failure
      }
      await Bun.sleep(wait)
      wait = Math.min(wait * 2, 5000)
    }
  }
}

async function runJob(handle: ImageEngineHandle, body: ImgGenRequest, index: number, preview: boolean, ctx: RunContext): Promise<Uint8Array> {
  const id = await submit(handle, body, ctx)
  await recordJob({ jobId: id, port: handle.port, enginePid: handle.pid, ownerPid: process.pid, startedAt: new Date().toISOString() })
  let last = ''
  let lastPreview = -1
  try {
    for (;;) {
      if (ctx.signal.aborted) throw new ObrewError('aborted', 'stopped')
      let job: Job
      try {
        job = await handle.client.job(id, ctx.signal)
      } catch (err) {
        const failure = httpFailure(err, `image job ${id}`)
        if (failure instanceof ObrewError && failure.code === 'engine_failed') throw engineFailure(failure.message, await logTail(serverLogPath(), 15))
        throw failure
      }
      const step = job.preview?.step
      const steps = job.preview?.total_steps
      const key = `${job.status}|${job.queue_position ?? 0}|${step ?? ''}/${steps ?? ''}`
      if (key !== last) {
        last = key
        ctx.activity()
        await handle.touch()
        if (job.status === 'queued') {
          ctx.emit({ type: 'image.progress', runId: ctx.runId, index, phase: 'queued', position: job.queue_position ?? 0 })
        } else if (job.status === 'generating') {
          const decoding = step !== undefined && steps !== undefined && step >= steps
          ctx.emit({
            type: 'image.progress',
            runId: ctx.runId,
            index,
            phase: decoding ? 'decoding' : 'sampling',
            ...(step !== undefined && steps !== undefined ? { step, steps } : {}),
          })
        }
      }
      if (preview && job.preview?.b64_json && job.preview.step !== lastPreview) {
        lastPreview = job.preview.step
        ctx.emit({ type: 'image.preview', runId: ctx.runId, index, step: job.preview.step, steps: job.preview.total_steps, b64: job.preview.b64_json })
      }
      if (job.status === 'completed') {
        const out = job.result?.images[0]
        if (!out) throw engineFailure('the image job completed without an image')
        return fromB64(out.b64_json)
      }
      if (job.status === 'failed') {
        throw engineFailure(`image generation failed: ${job.error?.message ?? job.error?.code ?? 'unknown error'}`, await logTail(serverLogPath(), 15))
      }
      if (job.status === 'cancelled') throw new ObrewError('aborted', 'the image job was cancelled')
      await Bun.sleep(POLL_MS)
    }
  } catch (err) {
    if (ctx.signal.aborted) await handle.client.cancel(id)
    throw err
  } finally {
    await removeJob(id)
  }
}

interface Finished {
  bytes: Uint8Array
  width: number
  height: number
  format: ImageFormat
}

/** ESRGAN in the engine, then an exact resample here. Every sign of life is reported. */
async function postProcess(
  handle: ImageEngineHandle,
  input: { bytes: Uint8Array; format: ImageFormat },
  plan: SizePlan,
  upscaler: { name: string } | null,
  index: number,
  wanted: ImageFormat,
  ctx: RunContext,
): Promise<Finished> {
  let bytes = input.bytes
  let format = input.format
  if (plan.upscalePasses > 0 && upscaler) {
    // ×4 with nothing after it: the engine encodes the requested format itself.
    const direct: ImageFormat = plan.resample ? 'png' : wanted
    const beat = () => {
      ctx.activity()
      ctx.emit({ type: 'image.progress', runId: ctx.runId, index, phase: 'upscaling' })
    }
    beat()
    const timer = setInterval(beat, 5000)
    try {
      const res = await handle.client
        .upscale({ image: dataUrl(bytes, format), upscaler: upscaler.name, repeats: plan.upscalePasses, output_format: direct }, ctx.signal)
        .catch((err) => {
          throw httpFailure(err, 'upscaling')
        })
      const out = res.images[0]
      if (!out) throw engineFailure('the upscaler returned no image')
      bytes = fromB64(out.b64_json)
      format = direct
      if (!plan.resample) return { bytes, width: res.width, height: res.height, format }
    } finally {
      clearInterval(timer)
    }
  }
  const img = decodePng(bytes)
  const exactHalf = img.width === plan.final.width * 2 && img.height === plan.final.height * 2
  const out = exactHalf ? halve(img) : coverResize(img, plan.final.width, plan.final.height)
  return { bytes: encodePng(out), width: out.width, height: out.height, format: 'png' }
}

function warnIfBlank(bytes: Uint8Array, format: ImageFormat, ctx: RunContext): void {
  if (format !== 'png') return
  try {
    if (isBlank(decodePng(bytes))) {
      ctx.log('warning: the image came out as one flat colour. On Apple Silicon this is a known engine bug; try again, or report it with `obrew image engine log`.')
    }
  } catch {
    // Not decodable here; nothing to check.
  }
}

/**
 * Resampled images (a crop to an exact size, ×4 then halved) are re-encoded here, and obrew's
 * encoder writes PNG only; the engine's own ×4 can encode JPEG or WebP itself. Refused up front,
 * rather than writing PNG bytes into a file named .jpg.
 */
function checkFormat(plan: SizePlan, format: ImageFormat): void {
  if (plan.resample && format !== 'png') {
    throw new ObrewError('bad_request', `this size needs cropping or resampling, which saves PNG only; use --format png (or a native size, or --upscale 4)`)
  }
}

export async function generateImages(req: GenerateRequest, ctx: RunContext): Promise<SavedImage[]> {
  const started = Date.now()
  const count = req.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new ObrewError('bad_request', '--count must be 1 to 8')
  const refs = req.refs ?? []
  if (refs.length && req.image !== undefined) throw new ObrewError('bad_request', '--image and --ref cannot be combined; use --ref alone to edit')
  const mode: ImageMode = refs.length ? 'edit' : req.image !== undefined ? 'img2img' : 'generate'
  const strength = req.strength ?? 0.6
  if (!(strength > 0 && strength <= 1)) throw new ObrewError('bad_request', '--strength must be above 0 and at most 1')
  if (!req.prompt.trim()) throw new ObrewError('bad_request', 'a prompt is required')

  const resolved = await resolveBundle(req.model, mode === 'edit' ? 'edit' : 'generator')
  if (mode === 'edit' && !req.model) ctx.log(`using ${resolved.bundle.id} for reference edits`)
  checkCaps(resolved, mode, refs.length, !!req.model)
  const init = req.image !== undefined ? await readInputImage(req.image, '--image') : null
  const refImages = await Promise.all(refs.map((r, i) => readInputImage(r, `--ref ${i + 1}`)))
  const { bundle } = resolved
  const plan = planSize({ aspect: req.aspect, size: req.size, upscale: req.upscale, like: init?.size ?? refImages[0]?.size, align: bundle.align, maxPixels: bundle.maxPixels })
  const upscaler = plan.upscalePasses > 0 ? await resolveUpscaler() : null
  const wanted = req.format ?? 'png'
  checkFormat(plan, wanted)

  const hardware = await detectHardware()
  const engine = await requireImageEngine()
  const handle = await acquireImageEngine({
    mode: ctx.engineMode,
    engine,
    resolved,
    hardware,
    pairs: ctx.pairs,
    signal: ctx.signal,
    log: ctx.log,
    idleTtlMs: ctx.idleTtlMs,
    console: ctx.console,
    onStatus: (state, detail) => {
      ctx.activity()
      ctx.emit({ type: 'engine.status', state, ...(detail ? { detail } : {}) })
    },
  })
  try {
    const seed0 = req.seed ?? randomInt(0, 2 ** 31 - 1)
    ctx.emit({
      type: 'image.started',
      runId: ctx.runId,
      mode,
      model: bundle.id,
      engine: { tag: engine.tag, variant: engine.variant, port: handle.port },
      width: plan.final.width,
      height: plan.final.height,
      count,
      seed: seed0,
    })
    const saved: SavedImage[] = []
    for (let index = 0; index < count; index++) {
      const t0 = Date.now()
      const seed = seed0 + index
      const post = plan.upscalePasses > 0 || plan.resample
      const body: ImgGenRequest = {
        prompt: req.prompt,
        ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
        width: plan.gen.width,
        height: plan.gen.height,
        seed,
        batch_count: 1,
        sample_params: {
          sample_steps: req.steps ?? bundle.defaults.steps,
          guidance: { txt_cfg: req.cfg ?? bundle.defaults.cfg },
          ...(bundle.defaults.sampler ? { sample_method: bundle.defaults.sampler } : {}),
        },
        ...(init ? { init_image: dataUrl(init.bytes, init.format), strength } : {}),
        ...(refImages.length ? { ref_images: refImages.map((r) => dataUrl(r.bytes, r.format)) } : {}),
        // Always a cheap latent projection: it is what carries the step count, preview or not.
        preview: 'proj',
        preview_interval: 1,
        output_format: post ? 'png' : wanted,
      }
      const raw = await runJob(handle, body, index, req.preview ?? false, ctx)
      warnIfBlank(raw, body.output_format, ctx)
      const done: Finished = post
        ? await postProcess(handle, { bytes: raw, format: 'png' }, plan, upscaler, index, wanted, ctx)
        : { bytes: raw, width: plan.gen.width, height: plan.gen.height, format: wanted }
      const where = await ctx.sink.save({ index, bytes: done.bytes, width: done.width, height: done.height, seed, format: done.format })
      const image: SavedImage = { index, ...where, width: done.width, height: done.height, seed, format: done.format, bytes: done.bytes.byteLength }
      ctx.emit({ type: 'image.saved', runId: ctx.runId, ...image, model: bundle.id, durationMs: Date.now() - t0 })
      saved.push(image)
    }
    ctx.emit({
      type: 'image.completed',
      runId: ctx.runId,
      durationMs: Date.now() - started,
      images: saved.map((s) => ({ ...(s.path ? { path: s.path } : {}), width: s.width, height: s.height, seed: s.seed })),
    })
    return saved
  } finally {
    await handle.release()
  }
}

export interface UpscaleRequest {
  image: string | Uint8Array
  /** ×2 or ×4 (default 4). */
  scale?: 2 | 4
  /** An exact size instead of a factor. */
  size?: Size
  format?: ImageFormat
}

/** Upscale an existing image. Any warm engine serves it; none needs a model loaded. */
export async function upscaleImage(req: UpscaleRequest, ctx: RunContext): Promise<SavedImage> {
  const started = Date.now()
  const upscaler = await resolveUpscaler()
  const input = await readInputImage(req.image, 'the image')
  const scale = req.scale ?? 4
  if (input.size.width * upscaler.scale > MAX_UPSCALED_SIDE || input.size.height * upscaler.scale > MAX_UPSCALED_SIDE) {
    throw new ObrewError('bad_request', `${input.size.width}×${input.size.height} ×${upscaler.scale} exceeds ${MAX_UPSCALED_SIDE} px per side`)
  }
  const final = req.size ?? { width: input.size.width * scale, height: input.size.height * scale }
  const plan: SizePlan = { gen: input.size, final, upscalePasses: 1, resample: !!req.size || scale !== upscaler.scale }
  const wanted = req.format ?? 'png'
  checkFormat(plan, wanted)

  const hardware = await detectHardware()
  const engine = await requireImageEngine()
  const handle = await acquireImageEngine({
    mode: ctx.engineMode,
    engine,
    resolved: null,
    hardware,
    pairs: ctx.pairs,
    signal: ctx.signal,
    log: ctx.log,
    idleTtlMs: ctx.idleTtlMs,
    console: ctx.console,
    onStatus: (state, detail) => {
      ctx.activity()
      ctx.emit({ type: 'engine.status', state, ...(detail ? { detail } : {}) })
    },
  })
  try {
    ctx.emit({ type: 'image.started', runId: ctx.runId, mode: 'upscale', model: upscaler.id, engine: { tag: engine.tag, variant: engine.variant, port: handle.port }, width: final.width, height: final.height, count: 1, seed: null })
    const done = await postProcess(handle, { bytes: input.bytes, format: input.format }, plan, upscaler, 0, wanted, ctx)
    const where = await ctx.sink.save({ index: 0, bytes: done.bytes, width: done.width, height: done.height, seed: null, format: done.format })
    const image: SavedImage = { index: 0, ...where, width: done.width, height: done.height, seed: null, format: done.format, bytes: done.bytes.byteLength }
    ctx.emit({ type: 'image.saved', runId: ctx.runId, ...image, model: upscaler.id, durationMs: Date.now() - started })
    ctx.emit({ type: 'image.completed', runId: ctx.runId, durationMs: Date.now() - started, images: [{ ...(image.path ? { path: image.path } : {}), width: image.width, height: image.height, seed: null }] })
    return image
  } finally {
    await handle.release()
  }
}
