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
import { pullModel } from '../models/pull'
import { defaultModel, loadRegistry, projectorPath, removeModel, resolveModel, setDefault, type ModelEntry } from '../models/registry'
import { DEFAULT_CTX_SIZE, hfToken, loadConfig } from '../shared/config'
import { ObrewError } from '../shared/errors'
import type { ExecEvent } from '../shared/events'
import { frame, HEARTBEAT_MS, PING, SSE_HEADERS } from '../shared/sse'
import { engineCommand } from '../cli/commands/exec'
import { ttsEngineStatus } from '../engine/install'
import { listVoices, PCM_HEADERS, speech, SpeechRequestSchema } from '../tts/client'
import { TtsEngine } from '../tts/engine'
import { installedPacks } from '../tts/packs'
import { transcribeWav } from '../stt/client'
import { AsrEngine, findAsrModel } from '../stt/engine'
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
const error = (status: number, message: string, type = 'invalid_request_error') =>
  json({ error: { message, type, code: status } }, status)

export class ObrewServer {
  private engine: EngineHandle | null = null
  private embedder: EmbeddingEngine | null = null
  private tts: TtsEngine | null = null
  private asr: AsrEngine | null = null
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
   * OpenAI `/v1/audio/speech`. `model` is a voice pack id (absent = the active pack); `pcm`
   * streams s16le 24 kHz mono as it is generated, with the sample headers a player needs.
   */
  private async speech(req: Request): Promise<Response> {
    const raw = await req.json().catch(() => null)
    const parsed = SpeechRequestSchema.safeParse(raw)
    if (!parsed.success) return error(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
    const body = parsed.data
    try {
      this.tts ??= new TtsEngine({ log: (m) => this.log(m) })
      const { server } = await this.tts.ensure(body.model, req.signal)
      const upstream = await speech(server.baseUrl, body, req.signal)
      const headers: Record<string, string> = {
        'content-type': upstream.headers.get('content-type') ?? (body.response_format === 'wav' ? 'audio/wav' : 'audio/pcm'),
        'cache-control': 'no-cache',
        ...(body.response_format === 'pcm' ? PCM_HEADERS : {}),
      }
      return new Response(upstream.body, { status: upstream.status, headers })
    } catch (err) {
      if (err instanceof ObrewError) return error(err.code === 'model_missing' || err.code === 'engine_missing' ? 503 : 502, err.message, err.code)
      throw err
    }
  }

  /** The voices the active (or named) pack answers to, plus the packs on disk. */
  private async voices(req: Request): Promise<Response> {
    const packs = await installedPacks()
    const status = await ttsEngineStatus()
    const wanted = new URL(req.url).searchParams.get('model') ?? undefined
    if (!status.installed || packs.length === 0) {
      return json({ voices: [], pack: null, packs: packs.map((p) => p.id), engine: status.installed ? 'ready' : 'missing' }, 503)
    }
    try {
      this.tts ??= new TtsEngine({ log: (m) => this.log(m) })
      const { server, pack } = await this.tts.ensure(wanted, req.signal)
      const voices = await listVoices(server.baseUrl, req.signal)
      return json({ voices, pack: pack.id, packs: packs.map((p) => p.id), engine: 'ready' })
    } catch (err) {
      if (err instanceof ObrewError) return error(503, err.message, err.code)
      throw err
    }
  }

  private async registerVoice(req: Request): Promise<Response> {
    try {
      this.tts ??= new TtsEngine({ log: (m) => this.log(m) })
      const { server } = await this.tts.ensure(undefined, req.signal)
      const upstream = await fetch(`${server.baseUrl}/v1/audio/voices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await req.text(),
        signal: req.signal,
      })
      return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } })
    } catch (err) {
      if (err instanceof ObrewError) return error(503, err.message, err.code)
      throw err
    }
  }

  /**
   * OpenAI `/v1/audio/transcriptions`: multipart `file` (wav/mp3/flac) with optional
   * `language` and `response_format` (json | text | verbose_json), or JSON `{ audio: <base64 wav> }`.
   */
  private async transcriptions(req: Request): Promise<Response> {
    let audio: Uint8Array | null = null
    let language: string | undefined
    let format = 'json'
    const type = req.headers.get('content-type') ?? ''
    try {
      if (type.includes('multipart/form-data')) {
        const form = await req.formData()
        const file = form.get('file')
        if (!(file instanceof Blob)) return error(400, 'file is required')
        audio = new Uint8Array(await file.arrayBuffer())
        language = typeof form.get('language') === 'string' ? String(form.get('language')) : undefined
        format = typeof form.get('response_format') === 'string' ? String(form.get('response_format')) : 'json'
      } else {
        const body = (await req.json()) as { audio?: string; language?: string; response_format?: string }
        if (typeof body.audio !== 'string') return error(400, 'audio (base64) is required')
        audio = new Uint8Array(Buffer.from(body.audio, 'base64'))
        language = body.language
        format = body.response_format ?? 'json'
      }
    } catch {
      return error(400, 'request body must be multipart/form-data with a file, or JSON with base64 audio')
    }
    if (audio.byteLength === 0) return error(400, 'empty audio')
    if (audio.byteLength > 50 * 1024 * 1024) return error(413, 'audio over 50 MB')
    try {
      this.asr ??= new AsrEngine((m) => this.log(m))
      const { server } = await this.asr.ensure(req.signal)
      const started = Date.now()
      const result = await transcribeWav(server.baseUrl, audio, { language, signal: req.signal })
      if (format === 'text') return new Response(result.text, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
      if (format === 'verbose_json') return json({ text: result.text, language: result.language, duration_ms: Date.now() - started })
      return json({ text: result.text })
    } catch (err) {
      if (err instanceof ObrewError) return error(err.code === 'model_missing' || err.code === 'engine_missing' ? 503 : 502, err.message, err.code)
      throw err
    }
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
    if (path === '/v1/audio/speech' && req.method === 'POST') return this.speech(req)
    if (path === '/v1/audio/voices' && req.method === 'GET') return this.voices(req)
    if (path === '/v1/audio/voices' && req.method === 'POST') return this.registerVoice(req)
    if (path === '/v1/audio/transcriptions' && req.method === 'POST') return this.transcriptions(req)

    // `default`, `chosen` and `defaultInstalled` mean the same thing on both routes: the model
    // a completion with no `model` would run, the one explicitly chosen if any, and whether
    // the first is on disk. A host reading either gets the same answer.
    if (path === '/obrew/status' && req.method === 'GET') {
      const status = await engineStatus()
      const model = await defaultModel(await loadRegistry())
      const tts = await ttsEngineStatus()
      const asrModel = await findAsrModel()
      return json({
        engine: status,
        tts: { ...tts, running: this.tts?.running ?? null, packs: (await installedPacks()).map((p) => p.id) },
        asr: { ready: asrModel !== null, model: asrModel?.id ?? null, running: this.asr?.running ?? null },
        loaded: this.loaded?.id ?? null,
        port: this.engine?.port ?? null,
        default: model.id,
        chosen: model.chosen,
        defaultInstalled: model.installed,
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
    this.reaper = setInterval(() => void reapIdleShared(this.opts.idleTtlMs).then((r) => r && this.log('stopped the idle engine')), 60_000)
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
    // The speech and transcription engines are attached (ours), like the embedder.
    await this.tts?.stop()
    this.tts = null
    await this.asr?.stop()
    this.asr = null
  }
}
