/**
 * One `tts-server` process (qwentts.cpp): spawn, wait for `/health`, drain its log, stop.
 *
 * The ATTACHED shape only — it is our child and dies with `stop()` or with us. Unlike the
 * chat engine there is no warm detached instance across invocations: `obrew serve` is the
 * long-lived host that keeps one alive, and `obrew tts` on its own pays the model load, which
 * for the 0.6B pack is a few seconds. The same hard-won rules as llama-server apply: stderr
 * drained continuously (a full pipe stalls the process on Windows), the tail kept for a
 * crash report, cwd at the binary so the backend DLLs beside it are found.
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ObrewError } from '../shared/errors'
import { readLines } from '../shared/ndjson'
import { logsDir } from '../shared/paths'
import { recordRunning, removeRunning } from '../engine/running'

const READY_TIMEOUT_MS = 180_000
const POLL_MS = 400
const STOP_GRACE_MS = 5_000
const TAIL_LINES = 40

export interface TtsSpawnOptions {
  binary: string
  talker: string
  codec: string
  alias: string
  port: number
  /** Default language for requests that omit one (qwentts `--lang`; `auto` lets the model decide). */
  lang?: string
  /** Extra flags for the binary (`-c tts_args=...`), e.g. `--device`, `--max-batch`. */
  extraArgs?: string[]
  signal?: AbortSignal
  onStatus?: (state: 'starting' | 'loading' | 'ready') => void
  logPath?: string | null
}

export const ttsLogPath = () => join(logsDir(), 'tts-server.log')

export async function ttsHealth(baseUrl: string, timeoutMs = 2000): Promise<'ok' | 'down'> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? 'ok' : 'down'
  } catch {
    return 'down'
  }
}

export class TtsServer {
  readonly baseUrl: string
  private proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | null = null
  private tail: string[] = []
  private logStream: WriteStream | null = null
  private drained: Promise<void> = Promise.resolve()

  private constructor(readonly port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  stderrTail(): string {
    return this.tail.join('\n')
  }

  static async start(opts: TtsSpawnOptions): Promise<TtsServer> {
    const server = new TtsServer(opts.port)
    await server.launch(opts)
    return server
  }

  private async launch(opts: TtsSpawnOptions): Promise<void> {
    const argv = [
      opts.binary,
      '--model',
      opts.talker,
      '--codec',
      opts.codec,
      '--host',
      '127.0.0.1',
      '--port',
      String(opts.port),
      '--alias',
      opts.alias,
      ...(opts.lang ? ['--lang', opts.lang] : []),
      ...(opts.extraArgs ?? []),
    ]
    const logPath = opts.logPath === undefined ? ttsLogPath() : opts.logPath
    if (logPath) {
      await mkdir(dirname(logPath), { recursive: true })
      this.logStream = createWriteStream(logPath, { flags: 'a' })
      this.logStream.write(`\n--- start ${new Date().toISOString()} ---\n${argv.join(' ')}\n`)
    }

    opts.onStatus?.('starting')
    this.proc = Bun.spawn(argv, {
      cwd: dirname(opts.binary),
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    const proc = this.proc

    await recordRunning({
      pid: proc.pid,
      port: opts.port,
      ownerPid: process.pid,
      model: `tts:${opts.alias}`,
      startedAt: new Date().toISOString(),
      shared: false,
    })
    void proc.exited.then(() => removeRunning(proc.pid))

    const drain = async (stream: ReadableStream<Uint8Array>) => {
      try {
        for await (const line of readLines(stream)) {
          this.tail.push(line)
          if (this.tail.length > TAIL_LINES) this.tail.shift()
          this.logStream?.write(line + '\n')
        }
      } catch {
        // Pipe closed.
      }
    }
    this.drained = Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>)]).then(() => {})

    const deadline = Date.now() + READY_TIMEOUT_MS
    let sawLoading = false
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        await this.stop()
        throw new ObrewError('aborted', 'tts-server start aborted')
      }
      if (proc.exitCode !== null) {
        await this.drained
        throw new ObrewError('engine_failed', `tts-server exited with code ${proc.exitCode} during startup:\n${this.stderrTail()}`)
      }
      if ((await ttsHealth(this.baseUrl, 1000)) === 'ok') {
        opts.onStatus?.('ready')
        return
      }
      if (!sawLoading) {
        sawLoading = true
        opts.onStatus?.('loading')
      }
      await Bun.sleep(POLL_MS)
    }
    await this.stop()
    throw new ObrewError('engine_failed', `tts-server not ready after ${READY_TIMEOUT_MS / 1000} s:\n${this.stderrTail()}`)
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    if (proc.exitCode === null) {
      try {
        proc.kill()
      } catch {
        // Already gone.
      }
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
