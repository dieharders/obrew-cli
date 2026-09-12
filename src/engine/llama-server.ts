/**
 * One llama-server process: spawn, wait for `/health`, drain stderr, stop.
 *
 * Port of `LlamaServer.start_server / _wait_for_ready / _read_logs / unload` in
 * obrew-engine/backends/inference/llama_server.py. The hard-won parts carried over:
 *
 *  - stderr is drained CONTINUOUSLY. llama-server logs there; on Windows a full 4 KB pipe
 *    blocks the process mid-write and every HTTP response stalls with it.
 *  - the last lines of stderr are kept, so a crash during model load reports WHY ("failed to
 *    allocate", "unknown model architecture") instead of "not ready after 120 s".
 *  - cwd is the binary's directory, so the DLLs / dylibs beside it are found.
 *  - stop() terminates, waits briefly, then kills.
 *
 * This is the ATTACHED engine: it is our child and dies with `stop()` or with us. The warm
 * shared engine, which must outlive us, is started by ./detach.ts instead.
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ObrewError } from '../shared/errors'
import { readLines } from '../shared/ndjson'
import { logsDir } from '../shared/paths'
import { EngineClient } from './client'
import { recordRunning, removeRunning } from './running'

const READY_TIMEOUT_MS = 120_000
const POLL_MS = 500
const STOP_GRACE_MS = 5_000
const TAIL_LINES = 40

export interface SpawnOptions {
  /** The command to run: normally `[binary]`; tests pass `[bun, fixture.ts]`. */
  command: string[]
  args: string[]
  port: number
  /** For the running-record. */
  model: string
  shared?: boolean
  cwd?: string
  env?: Record<string, string | undefined>
  readyTimeoutMs?: number
  signal?: AbortSignal
  /** `loading` fires the first time /health answers 503. */
  onStatus?: (state: 'starting' | 'loading' | 'ready') => void
  /** Where stderr lines go. `undefined` = the data dir's llama-server.log; `null` = nowhere. */
  logPath?: string | null
}

export const defaultLogPath = () => join(logsDir(), 'llama-server.log')

/** The last lines of a log file, for a detached engine's diagnostics. */
export async function logTail(path: string, lines = TAIL_LINES): Promise<string> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export class LlamaServer {
  readonly client: EngineClient
  readonly baseUrl: string
  private proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null
  private tail: string[] = []
  private logStream: WriteStream | null = null
  private drained: Promise<void> = Promise.resolve()

  private constructor(readonly port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`
    this.client = new EngineClient(this.baseUrl)
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  get exitCode(): number | null {
    return this.proc?.exitCode ?? null
  }

  /** The last stderr lines, for diagnostics. */
  stderrTail(): string {
    return this.tail.join('\n')
  }

  static async start(opts: SpawnOptions): Promise<LlamaServer> {
    const server = new LlamaServer(opts.port)
    await server.launch(opts)
    return server
  }

  private async launch(opts: SpawnOptions): Promise<void> {
    const [bin, ...prefix] = opts.command
    if (!bin) throw new ObrewError('engine_failed', 'empty engine command')
    const argv = [bin, ...prefix, ...opts.args]
    const cwd = opts.cwd ?? (prefix.length === 0 ? dirname(bin) : process.cwd())

    const logPath = opts.logPath === undefined ? defaultLogPath() : opts.logPath
    if (logPath) {
      await mkdir(dirname(logPath), { recursive: true })
      this.logStream = createWriteStream(logPath, { flags: 'a' })
      this.logStream.write(`\n--- start ${new Date().toISOString()} ---\n${argv.join(' ')}\n`)
    }

    opts.onStatus?.('starting')
    this.proc = Bun.spawn(argv, {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      windowsHide: true,
    })
    const proc = this.proc

    await recordRunning({
      pid: proc.pid,
      port: opts.port,
      ownerPid: process.pid,
      model: opts.model,
      startedAt: new Date().toISOString(),
      shared: opts.shared ?? false,
    })
    void proc.exited.then(() => removeRunning(proc.pid))

    this.drained = (async () => {
      try {
        for await (const line of readLines(proc.stderr as ReadableStream<Uint8Array>)) {
          this.tail.push(line)
          if (this.tail.length > TAIL_LINES) this.tail.shift()
          this.logStream?.write(line + '\n')
        }
      } catch {
        // Pipe closed; nothing more to read.
      }
    })()

    const deadline = Date.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS)
    let sawLoading = false
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        await this.stop()
        throw new ObrewError('aborted', 'engine start aborted')
      }
      if (proc.exitCode !== null) {
        await this.drained
        throw new ObrewError(
          'engine_failed',
          `llama-server exited with code ${proc.exitCode} during startup:\n${this.stderrTail()}`,
        )
      }
      const health = await this.client.health()
      if (health === 'ok') {
        opts.onStatus?.('ready')
        return
      }
      if (health === 'loading' && !sawLoading) {
        sawLoading = true
        opts.onStatus?.('loading')
      }
      await Bun.sleep(POLL_MS)
    }

    await this.stop()
    throw new ObrewError('engine_failed', `llama-server not ready after ${READY_TIMEOUT_MS / 1000} s:\n${this.stderrTail()}`)
  }

  /** Terminate, wait a moment, kill. Idempotent. */
  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    if (proc.exitCode === null) {
      try {
        proc.kill()
      } catch {
        // Already gone.
      }
      // A cleared timer, not `Bun.sleep`: a pending sleep keeps the event loop alive for its
      // full duration after the race has already been won, so the CLI would exit 5 s late.
      let timer: ReturnType<typeof setTimeout> | undefined
      const grace = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), STOP_GRACE_MS)
      })
      const exited = await Promise.race([proc.exited.then(() => true), grace])
      clearTimeout(timer)
      if (!exited) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        await proc.exited
      }
    }
    await removeRunning(proc.pid)
    await this.drained
    if (this.logStream) {
      this.logStream.end()
      this.logStream = null
    }
  }
}
