/**
 * The speech engine as a host sees it: "give me a tts-server speaking pack X", started on
 * first use, swapped when a request names another pack, stopped with the host.
 *
 * One instance at a time, like the chat engine, and for the same reason (one GPU's worth of
 * memory). A pack switch restarts the process; the 0.6B pack loads in a few seconds.
 */
import { requireTtsEngine } from '../engine/install'
import { freePort } from '../engine/ports'
import { loadConfig } from '../shared/config'
import { ObrewError } from '../shared/errors'
import { activePack, findPack, isPackInstalled, type VoicePack } from './packs'
import { TtsServer, ttsHealth } from './server'

export interface TtsEngineOptions {
  log?: (message: string) => void
  extraArgs?: string[]
}

export class TtsEngine {
  private server: TtsServer | null = null
  private pack: VoicePack | null = null
  private starting: Promise<TtsServer> | null = null

  constructor(private readonly opts: TtsEngineOptions = {}) {}

  get running(): { pack: string; port: number; pid: number | undefined } | null {
    return this.server && this.pack && this.server.alive ? { pack: this.pack.id, port: this.server.port, pid: this.server.pid } : null
  }

  /** The server speaking `packId` (or the active pack), starting or swapping as needed. */
  async ensure(packId?: string, signal?: AbortSignal): Promise<{ server: TtsServer; pack: VoicePack }> {
    const wanted = packId && packId !== 'default' ? findPack(packId) : null
    if (packId && packId !== 'default' && !wanted) throw new ObrewError('bad_request', `"${packId}" is not a voice pack`)
    if (wanted && !(await isPackInstalled(wanted))) {
      throw new ObrewError('model_missing', `${wanted.id} is not installed; run \`obrew voices pull ${wanted.id}\``)
    }
    const pack = wanted ?? (await activePack())

    if (this.server && this.pack?.id === pack.id && this.server.alive && (await ttsHealth(this.server.baseUrl)) === 'ok') {
      return { server: this.server, pack }
    }
    if (this.starting) {
      const server = await this.starting
      if (this.pack?.id === pack.id) return { server, pack }
    }

    this.starting = (async () => {
      await this.stop()
      const config = await loadConfig()
      const engine = await requireTtsEngine(config)
      const { packFiles } = await import('./packs')
      const files = packFiles(pack)
      const port = await freePort()
      this.opts.log?.(`loading voice pack ${pack.id}`)
      const server = await TtsServer.start({
        binary: engine.binary,
        talker: files.talker,
        codec: files.codec,
        alias: pack.id,
        port,
        signal,
        extraArgs: this.opts.extraArgs,
        onStatus: (state) => this.opts.log?.(`[tts] ${state}`),
      })
      this.server = server
      this.pack = pack
      return server
    })()
    try {
      const server = await this.starting
      return { server, pack }
    } finally {
      this.starting = null
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.pack = null
    await server?.stop()
  }
}
