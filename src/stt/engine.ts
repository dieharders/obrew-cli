/**
 * The transcription engine: a second llama-server running an ASR model (Qwen3-ASR) with its
 * audio projector, attached to this process and started on first use — the same shape as the
 * embedding engine, for the same reason: it is a different model from the chat engine's and
 * must not evict it.
 *
 * The model is an ordinary registry entry pulled WITH its projector
 * (`obrew models pull ggml-org/Qwen3-ASR-0.6B-GGUF --mmproj`). `config.asrModel` names it, or
 * the first installed entry that looks like an ASR model is used.
 */
import { engineCommand } from '../cli/commands/exec'
import { launchArgs } from '../engine/flags'
import { requireEngine } from '../engine/install'
import { LlamaServer } from '../engine/llama-server'
import { freePort } from '../engine/ports'
import { findModel, isOnDisk, loadRegistry, projectorPath, type ModelEntry } from '../models/registry'
import { loadConfig } from '../shared/config'
import { ObrewError } from '../shared/errors'

export const BUILT_IN_ASR_MODEL = 'ggml-org/Qwen3-ASR-0.6B-GGUF:Qwen3-ASR-0.6B-Q8_0.gguf'
const ASR_CTX = 8192

/** The ASR model to run, or null when none is installed. Never throws. */
export async function findAsrModel(): Promise<ModelEntry | null> {
  const config = await loadConfig()
  const registry = await loadRegistry()
  const candidates = [config.asrModel, BUILT_IN_ASR_MODEL].filter((id): id is string => Boolean(id))
  for (const id of candidates) {
    const entry = findModel(registry, id)
    if (entry && (await isOnDisk(entry)) && (await projectorPath(entry))) return entry
  }
  for (const entry of registry.models) {
    if (/asr|whisper|voxtral/i.test(entry.id) && (await isOnDisk(entry)) && (await projectorPath(entry))) return entry
  }
  return null
}

export class AsrEngine {
  private server: LlamaServer | null = null
  private starting: Promise<LlamaServer> | null = null
  model: ModelEntry | null = null

  constructor(private readonly log?: (message: string) => void) {}

  get running(): { model: string; port: number } | null {
    return this.server && this.model ? { model: this.model.id, port: this.server.port } : null
  }

  async ensure(signal?: AbortSignal): Promise<{ server: LlamaServer; model: ModelEntry }> {
    const model = await findAsrModel()
    if (!model) {
      throw new ObrewError('model_missing', `no transcription model installed; run \`obrew models pull ${BUILT_IN_ASR_MODEL.split(':')[0]} --mmproj\``)
    }
    if (this.server && this.model?.id === model.id && (await this.server.client.health()) === 'ok') {
      return { server: this.server, model }
    }
    if (this.starting) {
      const server = await this.starting
      if (this.model?.id === model.id) return { server, model }
    }
    this.starting = (async () => {
      await this.stop()
      const engine = await requireEngine()
      const mmprojPath = await projectorPath(model)
      const port = await freePort()
      this.log?.(`loading transcription model ${model.id}`)
      const server = await LlamaServer.start({
        command: engineCommand(engine.binary),
        args: launchArgs(model.path, port, { ctxSize: ASR_CTX, ...(mmprojPath ? { mmprojPath } : {}) }),
        port,
        model: `${model.id} (asr)`,
        signal,
        onStatus: (state) => this.log?.(`[asr] ${state}`),
      })
      this.server = server
      this.model = model
      return server
    })()
    try {
      const server = await this.starting
      return { server, model }
    } finally {
      this.starting = null
    }
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => null)
    const server = this.server
    this.server = null
    this.model = null
    await server?.stop()
  }
}
