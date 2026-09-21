/**
 * One run's view of the tool model: side-cars acquired on first use, remembered for the run,
 * and NEVER a reason for the run to fail. Whatever goes wrong here — the runner will not start,
 * a port is refused, a reply does not parse — the caller gets null and decodes under a grammar
 * with the baseline model, exactly as obrew did before the tool model existed.
 */
import type { ResolvedToolModel } from './resolve'
import { acquireNeedle, needleKey, type NeedleHandle, type NeedleReply, type NeedleTool } from './sidecar'

/** A side-car answers in tens of milliseconds; past this it is hung, not thinking. */
const COMPLETE_TIMEOUT_MS = 5_000

export interface NeedleSessionOptions {
  model: ResolvedToolModel
  idleTtlMs?: number
  signal: AbortSignal
  log: (message: string) => void
}

export class NeedleSession {
  private readonly handles = new Map<string, Promise<NeedleHandle | null>>()

  constructor(private readonly opts: NeedleSessionOptions) {}

  get id(): string {
    return this.opts.model.id
  }

  /** Start (or find) the side-car for a toolset. Safe to call early, to overlap a model load. */
  warm(tools: NeedleTool[], forced: boolean): Promise<NeedleHandle | null> {
    const install = this.opts.model.install
    if (!install) return Promise.resolve(null)
    const key = needleKey(install.weights, forced, tools)
    let handle = this.handles.get(key)
    if (!handle) {
      handle = acquireNeedle({
        install,
        model: this.opts.model.id,
        tools,
        forced,
        idleTtlMs: this.opts.idleTtlMs,
        signal: this.opts.signal,
        log: this.opts.log,
      }).catch((err: unknown) => {
        this.opts.log(`needle: unavailable for this run (${err instanceof Error ? err.message : String(err)})`)
        return null
      })
      this.handles.set(key, handle)
    }
    return handle
  }

  async complete(tools: NeedleTool[], forced: boolean, input: string): Promise<NeedleReply | null> {
    const handle = await this.warm(tools, forced)
    if (!handle) return null
    try {
      const reply = await handle.client.complete(input, { signal: this.opts.signal, timeoutMs: COMPLETE_TIMEOUT_MS })
      void handle.touch().catch(() => {})
      return reply
    } catch (err) {
      if (this.opts.signal.aborted) throw err
      this.opts.log(`needle: request failed (${err instanceof Error ? err.message : String(err)})`)
      return null
    }
  }
}
