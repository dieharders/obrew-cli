/**
 * stdio transport: the server is a child process, newline-delimited JSON-RPC on its stdin
 * and stdout. Its stderr is drained (never left to fill a pipe) and kept as a tail for
 * diagnostics. Closing ends stdin, waits briefly, then kills.
 */
import { readLines } from '../shared/ndjson'
import { McpError, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse, type Transport } from './types'

const STOP_GRACE_MS = 2_000
const TAIL_LINES = 20

interface Pending {
  resolve: (r: JsonRpcResponse) => void
  reject: (e: Error) => void
}

export class StdioTransport implements Transport {
  private readonly pending = new Map<number, Pending>()
  private tail: string[] = []
  private closed = false

  private constructor(
    private readonly server: string,
    private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
  ) {
    void this.readLoop()
    void this.drainStderr()
    void proc.exited.then((code) => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new McpError(server, `exited with code ${code}\n${this.tail.join('\n')}`))
      this.pending.clear()
    })
  }

  static spawn(server: string, command: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): StdioTransport {
    const [bin, ...args] = command
    if (!bin) throw new McpError(server, 'empty command')
    let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn([bin, ...args], {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      })
    } catch (err) {
      throw new McpError(server, `cannot start ${bin}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return new StdioTransport(server, proc)
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of readLines(this.proc.stdout as ReadableStream<Uint8Array>)) {
        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          continue // a stray log line on stdout
        }
        const items = Array.isArray(msg) ? msg : [msg]
        for (const item of items) {
          const reply = item as JsonRpcResponse
          if (reply && typeof reply.id === 'number' && this.pending.has(reply.id)) {
            this.pending.get(reply.id)!.resolve(reply)
            this.pending.delete(reply.id)
          }
          // Server-initiated requests and notifications are ignored: obrew consumes tools only.
        }
      }
    } catch {
      // Pipe closed.
    }
  }

  private async drainStderr(): Promise<void> {
    try {
      for await (const line of readLines(this.proc.stderr as ReadableStream<Uint8Array>)) {
        this.tail.push(line)
        if (this.tail.length > TAIL_LINES) this.tail.shift()
      }
    } catch {
      // Pipe closed.
    }
  }

  private write(msg: unknown): void {
    if (this.closed) throw new McpError(this.server, 'process has exited')
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
    void this.proc.stdin.flush()
  }

  send(msg: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(msg.id)
        reject(new McpError(this.server, 'aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(msg.id, {
        resolve: (r) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(r)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      try {
        this.write(msg)
      } catch (err) {
        this.pending.delete(msg.id)
        reject(err as Error)
      }
    })
  }

  async notify(msg: JsonRpcNotification): Promise<void> {
    this.write(msg)
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return
    try {
      this.proc.stdin.end()
    } catch {
      // Already closed.
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), STOP_GRACE_MS)
    })
    const exited = await Promise.race([this.proc.exited.then(() => true), grace])
    clearTimeout(timer)
    if (!exited) {
      try {
        this.proc.kill()
      } catch {
        // Already gone.
      }
      await this.proc.exited
    }
  }
}
