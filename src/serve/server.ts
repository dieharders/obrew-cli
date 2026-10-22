/**
 * `obrew serve`: an OpenAI-compatible HTTP front on the warm shared engine.
 *
 * llama-server already speaks the OpenAI chat API, so `/v1/chat/completions` and
 * `/v1/completions` are proxied through with the body untouched apart from `model`, which
 * selects (and if necessary swaps) the loaded model. `/v1/models` lists the registry.
 * `/v1/embeddings` waits for the embeddings phase. The `/obrew/*` routes expose what the CLI
 * can do — status, models, pulls with SSE progress — for a host that would rather talk HTTP,
 * as Ollama's API does. A pull here is `obrew models pull`: it never changes the default, and
 * `POST /obrew/models/default` is `obrew models use` for when the host wants to.
 *
 * Loopback by default; there is no auth, on the same reasoning as the MCP endpoints obrew
 * dials: the reachable set is this machine's processes.
 */
import { launchArgs, loadOptionsFrom } from '../engine/flags'
import { engineStatus, requireEngine } from '../engine/install'
import { acquireEngine, reapIdleShared, type EngineHandle } from '../engine/shared'
import { EmbeddingEngine } from '../embed/engine'
import { reapIdleImageShared } from '../image/engine/shared'
import { generateImages, memorySink, newRunId, type GenerateRequest, type ImageFormat } from '../image/generate'
import { ASPECT_NAMES, parseSize, type Aspect } from '../image/size'
import { imageStatus } from '../image/status'
import { pullModel } from '../models/pull'
import { defaultModel, loadRegistry, projectorPath, removeModel, resolveModel, setDefault, type ModelEntry } from '../models/registry'
import { DEFAULT_CTX_SIZE, hfToken, loadConfig } from '../shared/config'
import { ObrewError, type FailCode } from '../shared/errors'
import type { ExecEvent } from '../shared/events'
import { frame, HEARTBEAT_MS, PING, SSE_HEADERS } from '../shared/sse'
import { engineCommand } from '../cli/commands/exec'
import pkg from '../../package.json' with { type: 'json' }

export interface ServeOptions {
  host: string
  port: number
  /** Model to preload; otherwise the first request loads the registry default. */
  model?: string
  /**
   * Load each model with its vision projector, for requests that send images (`--vision`). Off
   * by default, as for `exec`: the projector costs memory for as long as the engine runs.
   */
  vision?: boolean
  idleTtlMs: number
  log?: (message: string) => void
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** An image failure's HTTP status, by obrew's failure code. */
const IMAGE_STATUS: Partial<Record<FailCode, number>> = {
  bad_request: 400,
  model_missing: 404,
  engine_missing: 503,
  engine_failed: 502,
  out_of_memory: 507,
  timeout: 504,
  aborted: 499,
}
const error = (status: number, message: string, type = 'invalid_request_error') =>
  json({ error: { message, type, code: status } }, status)

export class ObrewServer {
  private engine: EngineHandle | null = null
  private embedder: EmbeddingEngine | null = null
  private loaded: ModelEntry | null = null
  private loading: Promise<EngineHandle> | null = null
  private server: ReturnType<typeof Bun.serve> | null = null
  private reaper: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: ServeOptions) {}

  get port(): number {
    return this.server?.port ?? this.opts.port
  }

  private log(message: string): void {
    this.opts.log?.(message)
  }

  /** The engine running `query` (a model id, `default`, or undefined), loading it if needed. */
  private async engineFor(query: string | undefined, signal?: AbortSignal): Promise<EngineHandle> {
    // `resolveModel` owns what `default` and an absent query mean, including which error to
    // raise for each, so the sentinel is not unpacked a second time here.
    const model = await resolveModel(query)
    if (this.engine && this.loaded?.id === model.id && (await this.engine.client.health()) === 'ok') {
      await this.engine.touch()
      return this.engine
    }
    if (this.loading) {
      const h = await this.loading
      if (this.loaded?.id === model.id) return h
    }
    this.loading = (async () => {
      const config = await loadConfig()
      const engine = await requireEngine(config)
      const mmprojPath = this.opts.vision ? await projectorPath(model) : null
      if (this.opts.vision && !mmprojPath) this.log(`${model.id} has no vision projector, so it answers text only; pull it with --mmproj to see images`)
      const loadOpts = loadOptionsFrom({}, {
        ctxSize: config.ctxSize ?? DEFAULT_CTX_SIZE,
        ...(mmprojPath ? { mmprojPath } : {}),
      })
      this.log(`loading ${model.id}`)
      const handle = await acquireEngine({
        mode: 'shared',
        command: engineCommand(engine.binary),
        args: launchArgs(model.path, null, loadOpts),
        model: model.id,
        signal,
        log: (m) => this.log(m),
      })
      this.engine = handle
      this.loaded = model
      return handle
    })()
    try {
      return await this.loading
    } finally {
      this.loading = null
    }
  }

  private async proxy(path: string, req: Request): Promise<Response> {
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return error(400, 'request body must be JSON')
    }
    const wanted = typeof body.model === 'string' ? body.model : undefined
    let handle: EngineHandle
    try {
      handle = await this.engineFor(wanted, req.signal)
    } catch (err) {
      if (err instanceof ObrewError) return error(err.code === 'model_missing' ? 404 : 503, err.message, err.code)
      throw err
    }
    const upstream = await fetch(`${handle.client.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, model: this.loaded?.id ?? body.model }),
      signal: req.signal,
    })
    void handle.touch()
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-cache',
      },
    })
  }

  /** OpenAI `/v1/embeddings`: `input` is a string or an array of strings. */
  private async embeddings(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { input?: unknown; model?: string } | null
    const inputs = typeof body?.input === 'string' ? [body.input] : Array.isArray(body?.input) ? body.input.map(String) : null
    if (!inputs || inputs.length === 0) return error(400, 'input must be a string or an array of strings')
    try {
      // `EmbeddingEngine.open` owns the `default` sentinel, so `model` goes through as it came.
      if (!this.embedder || (body?.model && body.model !== 'default' && this.embedder.model.id !== body.model)) {
        await this.embedder?.close()
        this.embedder = await EmbeddingEngine.open(body?.model)
      }
      const vectors = await this.embedder.embedMany(inputs)
      return json({
        object: 'list',
        data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
        model: this.embedder.model.id,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      })
    } catch (err) {
      if (err instanceof ObrewError) return error(err.code === 'model_missing' ? 404 : 503, err.message, err.code)
      throw err
    }
  }

  /**
   * OpenAI-shaped `POST /v1/images/generations`, run by obrew's image module: its bundles, size
   * planning and per-job cancel, not a proxy of sd-server's own route. A disconnect cancels the
   * job. `stream: true` answers with the `image.*` events over SSE instead (with heartbeats), for
   * generations longer than a client will wait on a silent connection.
   */
  private async images(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return error(400, 'prompt is required')
    if (body.response_format !== undefined && body.response_format !== 'b64_json') return error(400, 'only response_format "b64_json" is supported')
    const int = (v: unknown, name: string, min: number, max: number): number | undefined => {
      if (v === undefined || v === null) return undefined
      const n = Number(v)
      if (!Number.isInteger(n) || n < min || n > max) throw new ObrewError('bad_request', `${name} must be an integer from ${min} to ${max}`)
      return n
    }
    let request: GenerateRequest
    let format: ImageFormat
    try {
      const requested = body.output_format ?? 'png'
      if (requested !== 'png' && requested !== 'jpeg' && requested !== 'webp') throw new ObrewError('bad_request', 'output_format must be png, jpeg or webp')
      format = requested
      const aspect = body.aspect === undefined ? undefined : ASPECT_NAMES.find((a) => a === body.aspect)
      if (body.aspect !== undefined && !aspect) throw new ObrewError('bad_request', `aspect must be one of ${ASPECT_NAMES.join(', ')}`)
      request = {
        prompt: body.prompt,
        ...(typeof body.negative_prompt === 'string' && body.negative_prompt ? { negativePrompt: body.negative_prompt } : {}),
        model: typeof body.model === 'string' ? body.model : undefined,
        count: int(body.n, 'n', 1, 8) ?? 1,
        size: typeof body.size === 'string' && body.size !== 'auto' ? parseSize(body.size) : undefined,
        aspect: aspect as Aspect | undefined,
        seed: int(body.seed, 'seed', 0, 2 ** 31 - 1),
        steps: int(body.steps, 'steps', 1, 200),
        format,
        preview: body.stream === true && body.preview === true,
      }
    } catch (err) {
      return error(400, err instanceof Error ? err.message : String(err))
    }
    // A generation can run for minutes; Bun's per-connection idle timeout would cut it.
    this.server?.timeout(req, 0)
    const ac = new AbortController()
    req.signal.addEventListener('abort', () => ac.abort(), { once: true })
    const runId = newRunId()
    const base = { runId, signal: ac.signal, log: (m: string) => this.log(m), activity: () => {}, engineMode: 'shared' as const, pairs: {}, sink: memorySink() }

    if (body.stream !== true) {
      try {
        const saved = await generateImages(request, { ...base, emit: () => {} })
        return json({
          created: Math.floor(Date.now() / 1000),
          output_format: format,
          data: saved.map((s) => ({ b64_json: s.b64, seed: s.seed, width: s.width, height: s.height, output_format: s.format })),
        })
      } catch (err) {
        if (err instanceof ObrewError) return error(IMAGE_STATUS[err.code] ?? 500, err.message, err.code)
        throw err
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (e: ExecEvent) => {
          try {
            controller.enqueue(frame(e))
          } catch {
            // Client gone.
          }
        }
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(PING)
          } catch {
            // Closed.
          }
        }, HEARTBEAT_MS)
        try {
          await generateImages(request, { ...base, emit: send })
        } catch (err) {
          send({ type: 'image.failed', code: err instanceof ObrewError ? err.code : 'engine_failed', message: err instanceof Error ? err.message : String(err) })
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
    return new Response(stream, { headers: SSE_HEADERS })
  }

  private async pull(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { spec?: string; mmproj?: boolean | string } | null
    if (!body?.spec) return error(400, 'spec (org/repo[:file]) is required')
    const ac = new AbortController()
    req.signal.addEventListener('abort', () => ac.abort(), { once: true })
    const config = await loadConfig()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (e: ExecEvent) => {
          try {
            controller.enqueue(frame(e))
          } catch {
            // Client gone.
          }
        }
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(PING)
          } catch {
            // Closed.
          }
        }, HEARTBEAT_MS)
        try {
          const entry = await pullModel({
            spec: body.spec!,
            mmproj: body.mmproj,
            token: hfToken(config),
            signal: ac.signal,
            onLog: (message) => send({ type: 'setup.log', message }),
            onProgress: (file, received, total) => send({ type: 'download.progress', file, received, total }),
          })
          send({ type: 'download.done', file: entry.file, path: entry.path })
          send({ type: 'setup.done', ok: true, message: entry.id })
        } catch (err) {
          send({ type: 'setup.done', ok: false, message: err instanceof Error ? err.message : String(err) })
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
    return new Response(stream, { headers: SSE_HEADERS })
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === '/health') return json({ status: 'ok', version: pkg.version })

    if (path === '/v1/models' && req.method === 'GET') {
      const registry = await loadRegistry()
      return json({
        object: 'list',
        data: registry.models.map((m) => ({ id: m.id, object: 'model', owned_by: 'obrew', created: Math.floor(Date.parse(m.addedAt || '0') / 1000) || 0 })),
      })
    }
    if ((path === '/v1/chat/completions' || path === '/v1/completions') && req.method === 'POST') {
      return this.proxy(path, req)
    }
    if (path === '/v1/embeddings' && req.method === 'POST') return this.embeddings(req)
    if (path === '/v1/images/generations' && req.method === 'POST') return this.images(req)

    // `default`, `chosen` and `defaultInstalled` mean the same thing on both routes: the model
    // a completion with no `model` would run, the one explicitly chosen if any, and whether
    // the first is on disk. A host reading either gets the same answer.
    if (path === '/obrew/status' && req.method === 'GET') {
      const status = await engineStatus()
      const model = await defaultModel(await loadRegistry())
      return json({
        engine: status,
        loaded: this.loaded?.id ?? null,
        port: this.engine?.port ?? null,
        default: model.id,
        chosen: model.chosen,
        defaultInstalled: model.installed,
        image: await imageStatus(),
      })
    }
    if (path === '/obrew/models' && req.method === 'GET') {
      const registry = await loadRegistry()
      const model = await defaultModel(registry)
      return json({ ...registry, default: model.id, chosen: model.chosen, defaultInstalled: model.installed })
    }
    if (path === '/obrew/models/pull' && req.method === 'POST') return this.pull(req)
    // `obrew models use` over HTTP: without it a host that can only pull has no way to point
    // the default at what it pulled, and no way back from a default that is not installed.
    if (path === '/obrew/models/default' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { id?: string } | null
      if (!body?.id) return error(400, 'id (an installed model id) is required')
      try {
        const entry = await setDefault(body.id)
        return json({ default: entry.id })
      } catch (err) {
        return error(404, err instanceof Error ? err.message : String(err))
      }
    }
    if (path.startsWith('/obrew/models/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/obrew/models/'.length))
      try {
        const entry = await removeModel(id)
        if (this.loaded?.id === entry.id) {
          this.loaded = null
          this.engine = null
        }
        return json({ removed: entry.id })
      } catch (err) {
        return error(404, err instanceof Error ? err.message : String(err))
      }
    }
    return error(404, `no route for ${req.method} ${path}`)
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      hostname: this.opts.host,
      port: this.opts.port,
      // Bun's default 10 s idle timeout would cut a slow generation; 255 is the ceiling.
      idleTimeout: 255,
      fetch: (req) => this.handle(req),
    })
    this.reaper = setInterval(() => {
      void reapIdleShared(this.opts.idleTtlMs).then((r) => r && this.log('stopped the idle engine'))
      void reapIdleImageShared(this.opts.idleTtlMs).then((r) => r && this.log('stopped the idle image engine'))
    }, 60_000)
    if (this.opts.model) await this.engineFor(this.opts.model)
    this.log(`obrew serve listening on http://${this.opts.host}:${this.port}`)
  }

  async stop(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper)
    this.server?.stop(true)
    this.server = null
    // The embedding engine is attached (ours); the chat engine is shared and stays warm.
    await this.embedder?.close()
    this.embedder = null
  }
}
