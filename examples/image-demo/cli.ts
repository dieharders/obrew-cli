/**
 * Run the obrew CLI the way a host app does: a subprocess per request, JSON on stdin, one JSON
 * event per stdout line, diagnostics on stderr, the exit code at the end, and a kill to cancel.
 * This file imports nothing from obrew's sources on purpose — the demo uses the CLI's public
 * contract only, the same one MotionBuff uses.
 *
 * `OBREW_BIN` picks the CLI: a compiled binary (`./obrew`), or a `.ts` entry point run under this
 * Bun. Unset, it is this checkout's `src/main.ts`.
 */
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')

export function obrewCommand(): string[] {
  const bin = process.env.OBREW_BIN
  if (!bin) return [process.execPath, join(REPO, 'src', 'main.ts')]
  return /\.[cm]?[jt]s$/.test(bin) ? [process.execPath, resolve(bin)] : [resolve(bin)]
}

export type CliMessage =
  | { kind: 'event'; event: Record<string, unknown> }
  | { kind: 'log'; line: string }
  | { kind: 'exit'; code: number }

/** Split a byte stream into lines, holding back a partial line (and a partial UTF-8 sequence). */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() ?? ''
    for (const line of parts) if (line.trim()) yield line
  }
  buffer += decoder.decode()
  if (buffer.trim()) yield buffer
}

/** A tiny queue both pipes write into, so stderr lines arrive while stdout is quiet. */
function channel<T>() {
  const items: T[] = []
  let wake: (() => void) | null = null
  let closed = false
  return {
    push(item: T) {
      items.push(item)
      wake?.()
      wake = null
    },
    close() {
      closed = true
      wake?.()
      wake = null
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        if (items.length) {
          yield items.shift()!
          continue
        }
        if (closed) return
        await new Promise<void>((r) => (wake = r))
      }
    },
  }
}

export async function* runCli(args: string[], opts: { stdin?: string; signal?: AbortSignal } = {}): AsyncGenerator<CliMessage> {
  const proc = Bun.spawn([...obrewCommand(), ...args], {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Explicit: this Bun does not hand a child the changes made to process.env after startup.
    env: { ...process.env },
  })
  const kill = () => proc.kill()
  opts.signal?.addEventListener('abort', kill, { once: true })
  const out = channel<CliMessage>()
  const pump = Promise.all([
    (async () => {
      for await (const line of lines(proc.stdout)) {
        try {
          out.push({ kind: 'event', event: JSON.parse(line) as Record<string, unknown> })
        } catch {
          out.push({ kind: 'log', line })
        }
      }
    })(),
    (async () => {
      // Human-mode progress lines end in `\r`; keep only what a log should show.
      for await (const line of lines(proc.stderr)) out.push({ kind: 'log', line: line.split('\r').pop()!.trim() })
    })(),
  ]).then(async () => {
    out.push({ kind: 'exit', code: await proc.exited })
    out.close()
  })
  try {
    yield* out.drain()
    await pump
  } finally {
    opts.signal?.removeEventListener('abort', kill)
    if (proc.exitCode === null) proc.kill()
  }
}

/** Run a command that prints one JSON document (`auth status --json`, `models list --json`). */
export async function runJson<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn([...obrewCommand(), ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`obrew ${args.join(' ')} exited ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`)
  return JSON.parse(stdout) as T
}
