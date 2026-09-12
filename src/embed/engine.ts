/**
 * The embedding engine: a second llama-server, `--embedding --pooling mean`, attached to
 * this process and started on first use. Port of obrew-engine's gguf_embedder_server.py and
 * image_embedder.py. Ephemeral by design — embeddings are computed for one run's in-memory
 * index, so there is nothing for a warm engine to save between runs but a few seconds of load.
 *
 * An embedding model is an ordinary registry entry (`obrew models pull nomic-ai/…`); the one
 * to use is `config.embedModel`, or `--model`. A vision embedding model is one pulled with
 * `--mmproj`; `embedImage` sends the bytes with llama.cpp's `[img-N]` placeholder contract.
 */
import { extname } from 'node:path'
import { launchArgs } from '../engine/flags'
import { requireEngine } from '../engine/install'
import { LlamaServer } from '../engine/llama-server'
import { freePort } from '../engine/ports'
import { engineCommand } from '../cli/commands/exec'
import { resolveModel, type ModelEntry } from '../models/registry'
import { loadConfig } from '../shared/config'
import { ObrewError } from '../shared/errors'

const EMBED_CTX = 2048

export class EmbeddingEngine {
  private server: LlamaServer | null = null
  private starting: Promise<LlamaServer> | null = null
  readonly model: ModelEntry

  private constructor(model: ModelEntry, private readonly signal?: AbortSignal) {
    this.model = model
  }

  /** Resolve the embedding model (query → config.embedModel → error). Nothing starts yet. */
  static async open(query: string | undefined, signal?: AbortSignal): Promise<EmbeddingEngine> {
    const config = await loadConfig()
    const key = query ?? config.embedModel
    if (!key) {
      throw new ObrewError('model_missing', 'no embedding model set; pull one (e.g. nomic-ai/nomic-embed-text-v1.5-GGUF) and run `obrew models use --embed <id>`')
    }
    return new EmbeddingEngine(await resolveModel(key), signal)
  }

  private async ensure(): Promise<LlamaServer> {
    if (this.server) return this.server
    if (!this.starting) {
      this.starting = (async () => {
        const engine = await requireEngine()
        const port = await freePort()
        const server = await LlamaServer.start({
          command: engineCommand(engine.binary),
          args: launchArgs(this.model.path, port, {
            embedding: true,
            ctxSize: EMBED_CTX,
            ...(this.model.mmprojPath ? { mmprojPath: this.model.mmprojPath } : {}),
          }),
          port,
          model: `${this.model.id} (embedding)`,
          signal: this.signal,
        })
        this.server = server
        return server
      })()
    }
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  async embed(text: string): Promise<number[]> {
    const server = await this.ensure()
    return server.client.embed(text, this.signal)
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (const t of texts) out.push(await this.embed(t))
    return out
  }

  /** Embed an image (needs a vision embedding model, i.e. one pulled with --mmproj). */
  async embedImage(path: string, prompt = ''): Promise<number[]> {
    if (!this.model.mmprojPath) throw new ObrewError('bad_request', `${this.model.id} has no vision projector; pull it with --mmproj to embed images`)
    const file = Bun.file(path)
    if (!(await file.exists())) throw new ObrewError('bad_request', `image not found: ${path}`)
    const ext = extname(path).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) throw new ObrewError('bad_request', `unsupported image type: ${path}`)
    const data = Buffer.from(await file.arrayBuffer()).toString('base64')
    const server = await this.ensure()
    return server.client.embed(`[img-1]${prompt ? ` ${prompt}` : ''}`, this.signal, [{ id: 1, data }])
  }

  async close(): Promise<void> {
    if (this.starting) await this.starting.catch(() => null)
    await this.server?.stop()
    this.server = null
  }
}
