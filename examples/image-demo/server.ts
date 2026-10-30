/**
 * The image demo's server: one page, and a few routes that each run the obrew CLI and relay
 * what it says to the browser — exactly how a host app (MotionBuff) integrates image generation.
 *
 *   GET  /api/status    obrew auth status --json                → JSON (the `image` block)
 *   GET  /api/models    obrew image models list --json          → JSON
 *   POST /api/setup     obrew image setup --json                → SSE, one CLI message per frame
 *   POST /api/upload    (no CLI) saves an image into the output dir for --image / --ref
 *   POST /api/generate  obrew image --json --input-format json … → SSE; the prompt goes on stdin
 *   POST /api/upscale   obrew image upscale <file> --json …     → SSE
 *   GET  /files/…       images from the output directory, and nothing outside it
 *
 * A browser that disconnects (Cancel, a closed tab) aborts the request, which kills the CLI,
 * which cancels its job in the engine. Run it: `bun run demo:image`, then open the printed URL.
 */
import { mkdir } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { runCli, runJson, type CliMessage } from './cli'
import { USE_CASES } from './presets'

const PUBLIC = join(import.meta.dir, 'public')
const encoder = new TextEncoder()
const IMAGE_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

export interface DemoOptions {
  port?: number
  out?: string
  log?: (message: string) => void
}

interface GenerateBody {
  prompt?: unknown
  negativePrompt?: unknown
  model?: unknown
  aspect?: unknown
  size?: unknown
  seed?: unknown
  count?: unknown
  steps?: unknown
  image?: unknown
  strength?: unknown
  refs?: unknown
  upscale?: unknown
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)

export function startDemo(opts: DemoOptions = {}) {
  const out = resolve(opts.out ?? process.env.OBREW_DEMO_OUT ?? join(import.meta.dir, '.out'))
  const log = opts.log ?? ((m: string) => console.error(m))

  /** A path inside the output directory, or null for anything that would escape it. */
  const inside = (name: string): string | null => {
    const full = resolve(out, name)
    return full.startsWith(out + sep) ? full : null
  }
  const urlFor = (path: string) => `/files/${relative(out, path).split(sep).map(encodeURIComponent).join('/')}`

  /** Relay a CLI run as SSE; `image.saved` events gain a `url` the page can show. */
  function relay(req: Request, args: string[], stdin?: string): Response {
    const ac = new AbortController()
    req.signal.addEventListener('abort', () => ac.abort(), { once: true })
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (msg: CliMessage) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`))
          } catch {
            // The browser left.
          }
        }
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            // Closed.
          }
        }, 15_000)
        try {
          for await (const msg of runCli(args, { stdin, signal: ac.signal })) {
            if (msg.kind === 'event' && msg.event.type === 'image.saved' && typeof msg.event.path === 'string') {
              msg.event.url = urlFor(msg.event.path)
              msg.event.name = relative(out, msg.event.path)
            }
            send(msg)
          }
        } catch (err) {
          send({ kind: 'log', line: `demo: ${err instanceof Error ? err.message : String(err)}` })
          send({ kind: 'exit', code: 1 })
        } finally {
          clearInterval(heartbeat)
          try {
            controller.close()
          } catch {
            // Already closed.
          }
        }
      },
      cancel() {
        ac.abort()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
  }

  async function generate(req: Request): Promise<Response> {
    const body = ((await req.json().catch(() => null)) ?? {}) as GenerateBody
    const prompt = str(body.prompt)
    if (!prompt) return Response.json({ error: 'prompt is required' }, { status: 400 })
    const args = ['image', '--json', '--input-format', 'json', '--out', out, '--preview', 'fast']
    const model = str(body.model)
    if (model && model !== 'default') args.push('--model', model)
    const size = str(body.size)
    const aspect = str(body.aspect)
    if (size) args.push('--size', size)
    else if (aspect) args.push('--aspect', aspect)
    const seed = num(body.seed)
    if (seed !== undefined) args.push('--seed', String(Math.trunc(seed)))
    const count = num(body.count)
    if (count !== undefined) args.push('--count', String(Math.trunc(count)))
    // Empty means the model's own default (MOSS-Image's is 50; fewer is the practical test setting).
    const steps = num(body.steps)
    if (steps !== undefined && steps >= 1) args.push('--steps', String(Math.trunc(steps)))
    const upscale = num(body.upscale)
    if (upscale === 2 || upscale === 4) args.push('--upscale', String(upscale))
    const image = str(body.image)
    if (image) {
      const path = inside(image)
      if (!path) return Response.json({ error: 'image not found' }, { status: 400 })
      args.push('--image', path, '--strength', String(num(body.strength) ?? 0.6))
    }
    for (const ref of Array.isArray(body.refs) ? body.refs : []) {
      const path = typeof ref === 'string' ? inside(ref) : null
      if (!path) return Response.json({ error: 'reference image not found' }, { status: 400 })
      args.push('--ref', path)
    }
    const negativePrompt = str(body.negativePrompt)
    return relay(req, args, JSON.stringify({ prompt, ...(negativePrompt ? { negativePrompt } : {}) }))
  }

  async function upload(req: Request): Promise<Response> {
    const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim()
    const ext = IMAGE_TYPES[type]
    if (!ext) return Response.json({ error: 'upload a PNG, JPEG or WebP image' }, { status: 415 })
    const bytes = new Uint8Array(await req.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024) return Response.json({ error: 'the image must be under 20 MB' }, { status: 413 })
    const stem = basename(req.headers.get('x-filename') ?? 'upload').replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'upload'
    const name = join('uploads', `${Date.now()}-${stem}${ext}`)
    await mkdir(join(out, 'uploads'), { recursive: true })
    await Bun.write(join(out, name), bytes)
    return Response.json({ name, url: urlFor(join(out, name)) })
  }

  async function file(path: string): Promise<Response> {
    const name = decodeURIComponent(path.slice('/files/'.length))
    const full = inside(name)
    if (!full) return new Response('not found', { status: 404 })
    const f = Bun.file(full)
    return (await f.exists()) ? new Response(f) : new Response('not found', { status: 404 })
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? Number(process.env.OBREW_DEMO_PORT ?? 8790),
    // Generations stream for minutes; heartbeats keep the connection busy, this is the backstop.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      try {
        if (path === '/' || path === '/index.html') return new Response(Bun.file(join(PUBLIC, 'index.html')))
        if (path === '/app.js') return new Response(Bun.file(join(PUBLIC, 'app.js')), { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
        if (path === '/api/use-cases') return Response.json(USE_CASES)
        if (path === '/api/status') return Response.json(await runJson(['auth', 'status', '--json']))
        if (path === '/api/models') return Response.json(await runJson(['image', 'models', 'list', '--json']))
        if (path === '/api/setup' && req.method === 'POST') return relay(req, ['image', 'setup', '--json'])
        if (path === '/api/upload' && req.method === 'POST') return upload(req)
        if (path === '/api/generate' && req.method === 'POST') return generate(req)
        if (path === '/api/upscale' && req.method === 'POST') {
          const body = ((await req.json().catch(() => null)) ?? {}) as { file?: unknown; scale?: unknown }
          const source = typeof body.file === 'string' ? inside(body.file) : null
          if (!source || !(await Bun.file(source).exists())) return Response.json({ error: 'image not found' }, { status: 400 })
          return relay(req, ['image', 'upscale', source, '--scale', num(body.scale) === 4 ? '4' : '2', '--json', '--out', out])
        }
        if (path.startsWith('/files/')) return file(path)
        return new Response('not found', { status: 404 })
      } catch (err) {
        log(`demo: ${path}: ${err instanceof Error ? err.message : String(err)}`)
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
      }
    },
  })
  return { server, out, url: `http://127.0.0.1:${server.port}` }
}

if (import.meta.main) {
  const { url, out } = startDemo()
  console.log(`obrew image demo → ${url}`)
  console.log(`images are saved in ${out}`)
}
