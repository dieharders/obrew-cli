/**
 * The warm shared engine.
 *
 * An ephemeral run loads the model, answers one turn and stops — and pays the model load
 * every time. A host runs ten or twenty turns per job, so the shared mode keeps ONE
 * llama-server alive across obrew invocations: the first run starts it detached and records
 * it in `<data>/engine/shared.json`; later runs with the same model and launch flags find the
 * record, check the process is alive and healthy, and reuse it. A different model or flags
 * stops the old engine and starts a new one. An engine idle past its TTL is reaped by
 * whichever run comes next, or by `obrew engine stop`.
 *
 * Only one shared engine at a time, on purpose: a laptop has one GPU's worth of memory.
 *
 * Concurrency note: two runs against one engine queue on its single slot, and a cancel
 * (`/slots/0?action=erase`) is not scoped to the caller. Acceptable for a host that runs
 * one turn at a time; revisit with `--parallel` when that changes.
 */
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { ObrewError } from '../shared/errors'
import { dataDir } from '../shared/paths'
import { EngineClient } from './client'
import { spawnDetached, waitReady } from './detach'
import { LlamaServer, defaultLogPath, type SpawnOptions } from './llama-server'
import { freePort } from './ports'
import { isAlive, recordRunning, removeRunning } from './running'

export const SharedRecordSchema = z.object({
  pid: z.number(),
  port: z.number(),
  model: z.string(),
  /** launch args minus the port, which is what "same engine" means. */
  key: z.string(),
  startedAt: z.string(),
  lastUsed: z.number(),
  /** How long the engine may sit idle before a later run reaps it. */
  idleTtlMs: z.number().optional(),
})
export type SharedRecord = z.infer<typeof SharedRecordSchema>

export const DEFAULT_IDLE_TTL_MS = 10 * 60_000

export const sharedRecordPath = () => join(dataDir(), 'engine', 'shared.json')

export async function readShared(): Promise<SharedRecord | null> {
  const file = Bun.file(sharedRecordPath())
  if (!(await file.exists())) return null
  try {
    const parsed = SharedRecordSchema.safeParse(await file.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function writeShared(record: SharedRecord): Promise<void> {
  const path = sharedRecordPath()
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(record))
}

export async function touchShared(idleTtlMs?: number): Promise<void> {
  const record = await readShared()
  if (record) await writeShared({ ...record, lastUsed: Date.now(), ...(idleTtlMs ? { idleTtlMs } : {}) })
}

/** How long a stopped engine gets to exit on its own before it is killed outright. */
const STOP_GRACE_MS = 10_000
const EXIT_POLL_MS = 100

/**
 * Block until `pid` is gone: the grace period for a clean exit, then SIGKILL and a short
 * bounded wait for that to land. Returns whether it is gone.
 */
async function waitGone(pid: number): Promise<boolean> {
  const soft = Date.now() + STOP_GRACE_MS
  while (isAlive(pid) && Date.now() < soft) await Bun.sleep(EXIT_POLL_MS)
  if (!isAlive(pid)) return true
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Gone between the check and the kill.
  }
  const hard = Date.now() + 2_000
  while (isAlive(pid) && Date.now() < hard) await Bun.sleep(EXIT_POLL_MS)
  return !isAlive(pid)
}

/**
 * Kill the recorded engine if it is still running, WAIT FOR IT TO EXIT, and drop the record.
 *
 * The wait is load-bearing, not tidiness. A replacement engine is started right after this
 * returns, `freePort()` prefers 8082, and llama-server closes its listening socket the
 * moment SIGTERM lands while the process itself lingers for seconds tearing down GPU
 * buffers — so the new engine binds the SAME port the old one just held. This process has
 * already talked to that port (the health check that found the old engine), and Bun's fetch
 * pools connections by host:port, so the first request to the "new" engine rode the pooled
 * keep-alive connection into the OLD, half-dead process and hung there until the stall
 * timer fired: two minutes of nothing on every model swap, measured with Qwen3.5 → Gemma 4
 * and back on macOS. With the old process gone its sockets are closed, the pooled connection
 * is dead, and the next fetch opens a fresh one to the engine that is actually listening.
 */
export async function stopShared(): Promise<boolean> {
  const record = await readShared()
  await rm(sharedRecordPath(), { force: true }).catch(() => {})
  if (!record) return false
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

/**
 * Stop the shared engine if nobody has used it for its TTL (the record's own, else the
 * caller's, else the default). Returns true when reaped.
 */
export async function reapIdleShared(ttlMs?: number): Promise<boolean> {
  const record = await readShared()
  if (!record) return false
  if (!isAlive(record.pid)) {
    await stopShared()
    return false
  }
  const ttl = record.idleTtlMs ?? ttlMs ?? DEFAULT_IDLE_TTL_MS
  if (Date.now() - record.lastUsed < ttl) return false
  return stopShared()
}

/** The launch args with the port removed: two engines with equal keys are interchangeable. */
export function engineKey(model: string, args: string[]): string {
  const stripped: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      i++
      continue
    }
    stripped.push(args[i]!)
  }
  return `${model}|${stripped.join(' ')}`
}

export interface EngineHandle {
  client: EngineClient
  port: number
  /** Whether this run reused (or left behind) a shared engine. */
  shared: boolean
  /** Whether this run started the engine (as opposed to finding it). */
  started: boolean
  /** Record activity, so the idle reaper leaves the engine alone. */
  touch(): Promise<void>
  /** Done with this run: stop an ephemeral engine; leave a shared one warm. */
  release(): Promise<void>
}

export interface AcquireOptions {
  mode: 'ephemeral' | 'shared'
  command: string[]
  /** Launch args WITHOUT `--port`; the port is chosen here. */
  args: string[]
  model: string
  signal?: AbortSignal
  onStatus?: SpawnOptions['onStatus']
  log?: (message: string) => void
  env?: Record<string, string | undefined>
  logPath?: string | null
  /** Idle TTL to record on a shared engine (a host with long non-model phases raises it). */
  idleTtlMs?: number
  /** Windows: give a shared engine started here a visible console window (`-c engine_console`). */
  console?: boolean
}

/**
 * An engine for this run: the warm shared one when it matches, otherwise a fresh one.
 */
export async function acquireEngine(opts: AcquireOptions): Promise<EngineHandle> {
  const key = engineKey(opts.model, opts.args)

  if (opts.mode === 'shared') {
    const existing = await readShared()
    if (existing) {
      const client = new EngineClient(`http://127.0.0.1:${existing.port}`)
      const alive = isAlive(existing.pid) && (await client.health()) === 'ok'
      if (alive && existing.key === key) {
        opts.log?.(`engine: reusing shared llama-server pid ${existing.pid} on port ${existing.port}`)
        const touch = () => touchShared(opts.idleTtlMs)
        await touch()
        opts.onStatus?.('ready')
        return { client, port: existing.port, shared: true, started: false, touch, release: touch }
      }
      opts.log?.(alive ? 'engine: shared llama-server runs a different model; replacing it' : 'engine: stale shared record; cleaning up')
      await stopShared()
    }
  }

  const port = await freePort()

  if (opts.mode === 'shared') {
    // Detached: created by WMI / a backgrounding shell, never our child, logging to a file.
    const [bin, ...prefix] = opts.command
    if (!bin) throw new ObrewError('engine_failed', 'empty engine command')
    const logPath = opts.logPath === undefined ? defaultLogPath() : opts.logPath
    const argv = [bin, ...prefix, ...opts.args, '--port', String(port), ...(logPath ? ['--log-file', logPath] : [])]
    const cwd = prefix.length === 0 ? dirname(bin) : process.cwd()
    opts.onStatus?.('starting')
    const pid = await spawnDetached(argv, { cwd, env: opts.env, console: opts.console })
    await recordRunning({ pid, port, ownerPid: process.pid, model: opts.model, startedAt: new Date().toISOString(), shared: true })
    const client = new EngineClient(`http://127.0.0.1:${port}`)
    const giveUp = async () => {
      try {
        process.kill(pid)
      } catch {
        // Already gone.
      }
      await removeRunning(pid)
    }
    try {
      await waitReady({ pid, client, logPath, signal: opts.signal, onStatus: opts.onStatus, onGiveUp: giveUp })
    } catch (err) {
      await removeRunning(pid)
      throw err
    }
    await writeShared({
      pid,
      port,
      model: opts.model,
      key,
      startedAt: new Date().toISOString(),
      lastUsed: Date.now(),
      ...(opts.idleTtlMs ? { idleTtlMs: opts.idleTtlMs } : {}),
    })
    opts.log?.(`engine: started shared llama-server pid ${pid} on port ${port}`)
    const touch = () => touchShared(opts.idleTtlMs)
    return { client, port, shared: true, started: true, touch, release: touch }
  }

  const server = await LlamaServer.start({
    command: opts.command,
    args: [...opts.args, '--port', String(port)],
    port,
    model: opts.model,
    signal: opts.signal,
    onStatus: opts.onStatus,
    env: opts.env,
    logPath: opts.logPath,
  })

  return {
    client: server.client,
    port,
    shared: false,
    started: true,
    touch: async () => {},
    release: () => server.stop(),
  }
}
