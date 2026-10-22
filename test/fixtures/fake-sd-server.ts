/**
 * A stand-in for stable-diffusion.cpp's `sd-server`, speaking just enough of its native API
 * (`/sdcpp/v1/...`) for the tests, and real PNGs so post-processing runs for real.
 *
 *   bun test/fixtures/fake-sd-server.ts --listen-port <n> [--diffusion-model <p> …]
 *   bun test/fixtures/fake-sd-server.ts --help | --list-devices
 *
 * With a model argument (`--diffusion-model` / `--model`) it reports a command-line preload, as
 * the real server does; without one, `state: "empty"` and only upscaling works. Behaviour is
 * steered by environment variables:
 *   FAKE_LOAD_MS=<n>        models/status says `loading` for the first n ms, then `ready`
 *   FAKE_LOAD_ERROR=<text>  models/status says `error` with this message (the process stays up)
 *   FAKE_EXIT_CODE=<n>      print a fatal line and exit n before listening
 *   FAKE_STEP_MS=<n>        delay between sample steps (default 15)
 *   FAKE_FAIL=<text>        every job fails with this message (`oom` → an out-of-memory message)
 *   FAKE_QUEUE_FULL=<n>     the first n submissions answer 429
 *   FAKE_BLANK=1            images come out flat white
 *   FAKE_LOG_ARGS=<p>       append this process's argv as one JSON line
 *   FAKE_LOG_REQUESTS=<p>   append every img_gen / upscale body (images elided) as JSON lines
 *   FAKE_LOG_CANCEL=<p>     append the id of every cancelled job
 *   FAKE_LINGER_MS=<n>      on SIGTERM close the listener but stay alive n ms
 */
import { appendFileSync } from 'node:fs'
import { decodePng, encodePng, type RasterImage } from '../../src/image/png'

const argv = process.argv.slice(2)
const env = process.env
const flag = (name: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

if (argv.includes('--help')) {
  process.stdout.write(`stable-diffusion.cpp version fake
Svr Options:
  -l, --listen-ip <string>      server listen ip
  --listen-port <int>           server listen port
  --model-dir                   model root
Context Options:
  -m, --model <string>          path to full model
  --llm <string>                path to the llm text encoder
  --diffusion-model <string>    path to the standalone diffusion model
  --vae <string>                path to standalone vae model
  --hires-upscalers-dir <string> highres fix upscaler model directory
  --backend <string>            runtime backend assignment
  --max-vram <string>           per-device budget in GiB
  --list-devices                list devices
  --offload-to-cpu              place the weights in RAM
  --batched-cfg                 on|off
Default Generation Options:
  --steps <int>                 number of sample steps
  --cfg-scale <float>           guidance scale
  --sampling-method             sampling method
  --vae-tiling                  vae tiling
`)
  process.exit(0)
}
if (argv.includes('--list-devices')) {
  process.stdout.write('CPU\tFake CPU\n')
  process.exit(0)
}
if (env.FAKE_LOG_ARGS) appendFileSync(env.FAKE_LOG_ARGS, JSON.stringify(argv) + '\n')
const exitCode = Number(env.FAKE_EXIT_CODE ?? '')
if (env.FAKE_EXIT_CODE && Number.isFinite(exitCode)) {
  process.stderr.write('[E] fake: failed to load model: unknown model architecture\n')
  process.exit(exitCode)
}

const port = Number(flag('--listen-port') ?? 1234)
const model = flag('--diffusion-model') ?? flag('--model') ?? flag('-m') ?? null
const startedAt = Date.now()
const loadMs = Number(env.FAKE_LOAD_MS ?? 0)
const stepMs = Number(env.FAKE_STEP_MS ?? 15)
let queueFull = Number(env.FAKE_QUEUE_FULL ?? 0)

process.stdout.write(`[I] fake sd-server listening on 127.0.0.1:${port} model=${model ?? '(none)'}\n`)
process.stderr.write('[I] fake: stderr is captured too\n')

/** A gradient that depends on the seed, so two seeds give two different images. */
function picture(width: number, height: number, seed: number): RasterImage {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      if (env.FAKE_BLANK === '1') {
        data[i] = data[i + 1] = data[i + 2] = 255
      } else {
        data[i] = (x * 255) / Math.max(1, width - 1)
        data[i + 1] = (y * 255) / Math.max(1, height - 1)
        data[i + 2] = (seed * 37) % 256
      }
    }
  }
  return { width, height, channels: 3, data }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s.replace(/^data:[^,]*,/, ''), 'base64'))

interface Job {
  id: string
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled'
  created: number
  started: number | null
  completed: number | null
  result: unknown
  error: { code: string; message: string } | null
  preview: { pass: number; step: number; total_steps: number; b64_json: string } | null
  body: { width?: number; height?: number; seed?: number; preview?: string; sample_params?: { sample_steps?: number } }
}

const jobs = new Map<string, Job>()
const queue: Job[] = []
let running: Job | null = null
let seq = 0

function logRequest(kind: string, body: Record<string, unknown>) {
  if (!env.FAKE_LOG_REQUESTS) return
  const short = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `<${v.length} chars>` : Array.isArray(v) ? v.map((x) => (typeof x === 'string' && x.length > 200 ? `<${x.length} chars>` : x)) : v]),
  )
  appendFileSync(env.FAKE_LOG_REQUESTS, JSON.stringify({ kind, ...short }) + '\n')
}

async function work(): Promise<void> {
  if (running) return
  const job = queue.shift()
  if (!job) return
  running = job
  job.status = 'generating'
  job.started = Date.now()
  const steps = job.body.sample_params?.sample_steps ?? 4
  for (let step = 1; step <= steps; step++) {
    await Bun.sleep(stepMs)
    if (job.status !== 'generating') break
    if (job.body.preview && job.body.preview !== 'none') {
      job.preview = { pass: 1, step, total_steps: steps, b64_json: b64(encodePng(picture(16, 9, step))) }
    }
  }
  if (job.status === 'generating') {
    if (env.FAKE_FAIL) {
      job.status = 'failed'
      job.error = { code: 'generation_failed', message: env.FAKE_FAIL === 'oom' ? 'ggml_metal: failed to allocate buffer: out of memory' : env.FAKE_FAIL }
    } else {
      const png = encodePng(picture(job.body.width ?? 512, job.body.height ?? 512, job.body.seed ?? 0))
      job.status = 'completed'
      job.result = { output_format: 'png', images: [{ index: 0, b64_json: b64(png) }] }
    }
    job.completed = Date.now()
    job.preview = null
  }
  running = null
  void work()
}

const stateNow = () => {
  if (!model) return { state: 'empty', error: null }
  if (env.FAKE_LOAD_ERROR) return { state: 'error', error: env.FAKE_LOAD_ERROR }
  if (Date.now() - startedAt < loadMs) return { state: 'loading', error: null }
  return { state: 'ready', error: null, origin: 'command_line', load_elapsed_seconds: loadMs / 1000 }
}

const lingerMs = Number(env.FAKE_LINGER_MS ?? 0)
let stopping = false

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 60,
  async fetch(req) {
    if (stopping) return new Promise<Response>(() => {})
    const url = new URL(req.url)
    const path = url.pathname
    if (path === '/sdcpp/v1/models/status') return Response.json({ recipe: null, models: {}, ...stateNow() })
    if (path === '/sdcpp/v1/capabilities') {
      return Response.json({ upscale: true, upscalers: [{ name: 'RealESRGAN_x4plus', model: true, image_upscale: true }], preview_modes: ['none', 'proj'], limits: { max_width: 4096, max_height: 4096 } })
    }
    if (path === '/sdcpp/v1/img_gen' && req.method === 'POST') {
      const state = stateNow().state
      if (state !== 'ready') return Response.json({ error: 'No model is loaded', code: state === 'loading' ? 'model_loading' : 'model_not_loaded' }, { status: 503 })
      if (queueFull > 0) {
        queueFull--
        return Response.json({ error: 'queue is full' }, { status: 429 })
      }
      const body = (await req.json()) as Job['body'] & Record<string, unknown>
      logRequest('img_gen', body)
      if (!body.width || !body.height) return Response.json({ error: 'width and height are required' }, { status: 400 })
      const id = `job_fake_${++seq}`
      const job: Job = { id, status: 'queued', created: Date.now(), started: null, completed: null, result: null, error: null, preview: null, body }
      jobs.set(id, job)
      queue.push(job)
      void work()
      return Response.json({ id, kind: 'img_gen', status: 'queued', created: job.created, poll_url: `/sdcpp/v1/jobs/${id}` }, { status: 202 })
    }
    const jobMatch = path.match(/^\/sdcpp\/v1\/jobs\/([^/]+)(\/cancel)?$/)
    if (jobMatch) {
      const job = jobs.get(decodeURIComponent(jobMatch[1]!))
      if (!job) return Response.json({ error: 'not found' }, { status: 404 })
      if (jobMatch[2] && req.method === 'POST') {
        if (job.status === 'completed' || job.status === 'failed') return Response.json({ error: 'finished' }, { status: 409 })
        job.status = 'cancelled'
        job.completed = Date.now()
        job.error = { code: 'cancelled', message: 'job cancelled by client' }
        const at = queue.indexOf(job)
        if (at >= 0) queue.splice(at, 1)
        if (env.FAKE_LOG_CANCEL) appendFileSync(env.FAKE_LOG_CANCEL, job.id + '\n')
        return Response.json({ id: job.id, status: 'cancelled' })
      }
      const position = job.status === 'queued' ? queue.indexOf(job) + 1 : 0
      return Response.json({
        id: job.id,
        kind: 'img_gen',
        status: job.status,
        created: job.created,
        started: job.started,
        completed: job.completed,
        queue_position: position,
        result: job.result,
        error: job.error,
        preview: job.preview,
      })
    }
    if (path === '/sdcpp/v1/upscale' && req.method === 'POST') {
      const body = (await req.json()) as { image?: string; repeats?: number; upscaler?: string; output_format?: string }
      logRequest('upscale', body)
      if (!body.image) return Response.json({ error: 'image is required' }, { status: 400 })
      const input = decodePng(fromB64(body.image))
      const factor = 4 ** (body.repeats ?? 1)
      const width = input.width * factor
      const height = input.height * factor
      if (width > 8192 || height > 8192) return Response.json({ error: 'output dimensions exceed the limit' }, { status: 400 })
      const png = encodePng(picture(width, height, 1))
      return Response.json({ images: [{ index: 0, b64_json: b64(png) }], upscaler: body.upscaler ?? 'RealESRGAN_x4plus', scale: 4, repeats: body.repeats ?? 1, width, height, output_format: 'png' })
    }
    return new Response('not found', { status: 404 })
  },
})

if (lingerMs > 0) {
  process.on('SIGTERM', () => {
    stopping = true
    server.stop()
    setTimeout(() => process.exit(0), lingerMs)
  })
}
