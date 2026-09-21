/**
 * Warm Needle side-cars: the tool model, running beside llama-server.
 *
 * Needle's runner is its own small process (`needle --serve`, about 75 MB resident), so unlike
 * a second GGUF it costs the GPU nothing and the "one shared engine" rule in ../engine/shared.ts
 * does not apply to it. It is kept warm for the same reason the shared engine is: a host runs
 * many `obrew exec` turns per job. Warm is also BETTER, not just faster — the one-shot
 * `--prompt` mode gave visibly worse extractions than the server on identical input (spike,
 * macOS arm64: the server copied a 200-character summary verbatim, one-shot cut it to a clause).
 *
 * A runner is bound at launch to ONE toolset (`--tools`), and a run uses up to two: its
 * callable tools, and the single `answer` tool that carries an output schema. So there is one
 * side-car per toolset, recorded at `<data>/engine/needle/<key>.json` where the key hashes the
 * weights, the flags and the tools. At most MAX_SIDECARS stay alive; the least recently used is
 * stopped to make room, and idle ones are reaped like the shared engine.
 *
 * The runner keeps one conversation per process and earlier turns bleed into later ones (the
 * published notebook shows "order me a pizza" re-firing the previous thermostat call), so
 * `complete()` always resets first. Two obrew runs sharing a side-car could interleave between
 * the reset and the completion; acceptable for a host that runs one turn at a time, the same
 * bargain the shared engine's single slot makes.
 *
 * TELEMETRY IS OFF, ALWAYS. The runner reports usage to its publisher unless told otherwise.
 * obrew is a local engine: every launch goes through `needleEnv()`, which is applied over the
 * caller's environment so nothing a user or host sets can turn it back on.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { spawnDetached } from '../engine/detach'
import { freePort } from '../engine/ports'
import { isAlive, recordRunning, removeRunning } from '../engine/running'
import { DEFAULT_IDLE_TTL_MS, waitGone } from '../engine/shared'
import { ObrewError } from '../shared/errors'
import { needleDir, needleRecordsDir } from '../shared/paths'
import type { NeedleInstall } from './install'

/** The environment every Needle process gets. Not configurable, on purpose: see the header. */
export const needleEnv = (): Record<string, string> => ({ NEEDLE_TELEMETRY: '0', DO_NOT_TRACK: '1' })

/** A tool as the runner's `--tools` file describes it. */
export interface NeedleTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface NeedleCall {
  name: string
  arguments: Record<string, unknown>
}

export interface NeedleReply {
  calls: NeedleCall[]
  /** The runner's calibrated score in [0,1], or null when it gave none (a fine-tune has no head). */
  confidence: number | null
  /** The runner's own failure, e.g. `truncated` when the call outgrew the token budget. */
  error: string | null
}

const ReplySchema = z.object({
  function_calls: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })).default([]),
  confidence: z.number().nullable().optional(),
  success: z.boolean().optional(),
  error: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
})

export class NeedleClient {
  constructor(readonly baseUrl: string) {}

  /**
   * The body is `JSON.stringify` output and must stay that way: the runner's parser reads
   * `{"input":"…"}` but not `{"input": "…"}` — with a space after the colon it silently
   * decodes an EMPTY input and answers from the tool schemas alone (spike: two different
   * prompts, byte-identical nonsense replies).
   */
  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(body), signal })
  }

  async ready(): Promise<boolean> {
    try {
      return (await this.post('/reset', {}, AbortSignal.timeout(1_000))).ok
    } catch {
      return false
    }
  }

  /** One stateless completion: reset the conversation, then answer `input`. */
  async complete(input: string, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<NeedleReply> {
    const timeout = AbortSignal.timeout(opts.timeoutMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    await this.post('/reset', {}, signal)
    const res = await this.post('/complete', { input }, signal)
    if (!res.ok) throw new Error(`needle: HTTP ${res.status}`)
    const parsed = ReplySchema.parse(await res.json())
    const failed = parsed.success === false
    return {
      calls: failed ? [] : parsed.function_calls,
      confidence: parsed.confidence ?? null,
      error: failed ? (parsed.error_code ?? parsed.error ?? 'failed') : null,
    }
  }
}

export const NeedleRecordSchema = z.object({
  pid: z.number(),
  port: z.number(),
  key: z.string(),
  model: z.string(),
  /** Tool names, for `obrew engine status`; the key is what identifies the toolset. */
  tools: z.array(z.string()),
  startedAt: z.string(),
  lastUsed: z.number(),
  idleTtlMs: z.number().optional(),
})
export type NeedleRecord = z.infer<typeof NeedleRecordSchema>

/** About 75 MB each; three covers a run's tools, its answer schema, and the previous phase's. */
const MAX_SIDECARS = 3
/** Cold load measured at 0.9 s; generous because a first launch may also be a virus scan. */
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 100
/**
 * The longest tool call the runner may write. Its default is 512, which an eight-field answer
 * with a 200-character summary already half fills; a call that outgrows the budget comes back
 * as the `truncated` error rather than as a shorter answer, so the headroom is cheap insurance.
 */
const MAX_NEW_TOKENS = 2048

/**
 * Needle's own port range, clear of llama-server's 8082–8095. The side-car starts WHILE the
 * engine loads, and two `freePort()` calls racing over one range both proved 8082 free: the
 * engine bound it and the runner exited at startup, on the first real run.
 */
const NEEDLE_PORTS: [number, number] = [8182, 8195]

const recordPath = (key: string) => join(needleRecordsDir(), `${key}.json`)
const toolsPath = (key: string) => join(needleDir(), 'tools', `${key}.json`)

/** Same rule as `engineCommand` in cli/commands/exec.ts: a test's fake runner is a script. */
const runnerCommand = (runner: string): string[] => (/\.[cm]?[jt]s$/.test(runner) ? [process.execPath, runner] : [runner])

export function needleKey(weights: string, forced: boolean, tools: NeedleTool[]): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(JSON.stringify([weights, forced, MAX_NEW_TOKENS, tools]))
  return hasher.digest('hex').slice(0, 16)
}

export async function listNeedles(): Promise<NeedleRecord[]> {
  let names: string[]
  try {
    names = await readdir(needleRecordsDir())
  } catch {
    return []
  }
  const out: NeedleRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = NeedleRecordSchema.safeParse(await Bun.file(join(needleRecordsDir(), name)).json())
      if (parsed.success) out.push(parsed.data)
    } catch {
      // Unreadable record; dropped by whoever next stops or reaps.
    }
  }
  return out
}

async function writeRecord(record: NeedleRecord): Promise<void> {
  await mkdir(needleRecordsDir(), { recursive: true })
  await Bun.write(recordPath(record.key), JSON.stringify(record))
}

async function stopNeedle(record: NeedleRecord): Promise<boolean> {
  await rm(recordPath(record.key), { force: true }).catch(() => {})
  await rm(toolsPath(record.key), { force: true }).catch(() => {})
  let killed = false
  if (isAlive(record.pid)) {
    try {
      process.kill(record.pid)
      killed = true
    } catch {
      // Already gone.
    }
    await waitGone(record.pid)
  }
  await removeRunning(record.pid)
  return killed
}

export async function stopAllNeedles(): Promise<number> {
  let stopped = 0
  for (const record of await listNeedles()) if (await stopNeedle(record)) stopped++
  return stopped
}

/** Stop side-cars idle past their TTL and forget dead ones. Returns how many were stopped. */
export async function reapIdleNeedles(ttlMs?: number): Promise<number> {
  let reaped = 0
  for (const record of await listNeedles()) {
    const ttl = record.idleTtlMs ?? ttlMs ?? DEFAULT_IDLE_TTL_MS
    if (!isAlive(record.pid) || Date.now() - record.lastUsed >= ttl) {
      if (await stopNeedle(record)) reaped++
    }
  }
  return reaped
}

export interface NeedleHandle {
  client: NeedleClient
  port: number
  /** Whether this run started the side-car (as opposed to finding it warm). */
  started: boolean
  touch(): Promise<void>
}

export interface AcquireNeedleOptions {
  install: NeedleInstall
  /** The id to show in status output (`needle3`, or a fine-tune's path). */
  model: string
  tools: NeedleTool[]
  /** `--forced`: always dispatch a call. For the `answer` tool, where "no call" is never right. */
  forced: boolean
  idleTtlMs?: number
  signal?: AbortSignal
  log?: (message: string) => void
}

/** The warm side-car for this toolset when there is one, otherwise a fresh one. */
export async function acquireNeedle(opts: AcquireNeedleOptions): Promise<NeedleHandle> {
  const key = needleKey(opts.install.weights, opts.forced, opts.tools)
  const touchOf = (record: NeedleRecord) => () =>
    writeRecord({ ...record, lastUsed: Date.now(), ...(opts.idleTtlMs ? { idleTtlMs: opts.idleTtlMs } : {}) })

  const records = await listNeedles()
  const existing = records.find((r) => r.key === key)
  if (existing) {
    const client = new NeedleClient(`http://127.0.0.1:${existing.port}`)
    if (isAlive(existing.pid) && (await client.ready())) {
      opts.log?.(`needle: reusing side-car pid ${existing.pid} on port ${existing.port}`)
      const touch = touchOf(existing)
      await touch()
      return { client, port: existing.port, started: false, touch }
    }
    await stopNeedle(existing)
  }

  const live = records.filter((r) => r.key !== key && isAlive(r.pid)).sort((a, b) => a.lastUsed - b.lastUsed)
  while (live.length >= MAX_SIDECARS) await stopNeedle(live.shift()!)

  const file = toolsPath(key)
  await mkdir(dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(opts.tools))

  const port = await freePort(NEEDLE_PORTS)
  const [bin, ...prefix] = runnerCommand(opts.install.runner)
  const argv = [
    bin!,
    ...prefix,
    ...(opts.install.weights ? ['--model', opts.install.weights] : []),
    '--tools',
    file,
    '--serve',
    '--port',
    String(port),
    '--max',
    String(MAX_NEW_TOKENS),
    ...(opts.forced ? ['--forced'] : []),
  ]
  const cwd = prefix.length === 0 ? dirname(bin!) : process.cwd()
  const pid = await spawnDetached(argv, { cwd, env: needleEnv() })
  await recordRunning({ pid, port, ownerPid: process.pid, model: `${opts.model} (tool model)`, startedAt: new Date().toISOString(), shared: true })

  const client = new NeedleClient(`http://127.0.0.1:${port}`)
  const giveUp = async (message: string): Promise<never> => {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
    await removeRunning(pid)
    throw new ObrewError('engine_failed', message)
  }
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (!(await client.ready())) {
    if (opts.signal?.aborted) await giveUp('needle start aborted')
    if (!isAlive(pid)) await giveUp(`needle (pid ${pid}) exited during startup`)
    if (Date.now() > deadline) await giveUp(`needle not ready after ${READY_TIMEOUT_MS / 1000} s`)
    await Bun.sleep(READY_POLL_MS)
  }

  const record: NeedleRecord = {
    pid,
    port,
    key,
    model: opts.model,
    tools: opts.tools.map((t) => t.name),
    startedAt: new Date().toISOString(),
    lastUsed: Date.now(),
    ...(opts.idleTtlMs ? { idleTtlMs: opts.idleTtlMs } : {}),
  }
  await writeRecord(record)
  opts.log?.(`needle: started side-car pid ${pid} on port ${port} (${record.tools.join(', ')})`)
  return { client, port, started: true, touch: touchOf(record) }
}
