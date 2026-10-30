/**
 * The warm image engine: one sd-server that outlives obrew, like the text engine's — and kept
 * apart from it.
 *
 * Loading a 6–7 GB model costs seconds to minutes; a host makes many images per job. So the
 * first run starts sd-server detached (../../engine/detach.ts) and records it in
 * `<data>/image/engine/shared.json`, and later runs with the same bundle and flags (the key from
 * ./flags.ts) reuse it. A run that needs a different model waits until no other obrew is using
 * the engine (GPU leases, ../../shared/gpu.ts), then replaces it. An upscale needs no model and
 * reuses whatever engine is warm. Idle past its TTL, it is stopped by the next image or text run,
 * by `obrew serve`'s reaper, or by `obrew engine stop`.
 *
 * Why not the text engine's `acquireEngine`: it has ONE slot (starting an image engine would
 * evict the text engine every time), it polls `/health` (sd-server has none: readiness is
 * `GET /sdcpp/v1/models/status`, which also reports a model that failed to load — sd-server
 * stays up with `state: "error"` rather than exiting), and it passes llama-server's `--log-file`
 * (sd-server has none: its stdout and stderr are redirected to `<data>/image/logs/sd-server.log`).
 */
import { closeSync, openSync } from 'node:fs'
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { engineCommand } from '../../engine/command'
import { spawnDetached } from '../../engine/detach'
import { findEngine } from '../../engine/install'
import { logTail } from '../../engine/llama-server'
import { freePort } from '../../engine/ports'
import { isAlive, reapOrphans, recordRunning, removeRunning, listRunning } from '../../engine/running'
import { readShared, stopShared, waitGone } from '../../engine/shared'
import { findModel, loadRegistry } from '../../models/registry'
import { ObrewError } from '../../shared/errors'
import { makeRoom, takeLease, waitForIdle, type LeaseHandle, type Peer } from '../../shared/gpu'
import { imageRunningDir, imageSharedRecordPath, serverLogPath } from '../paths'
import type { ResolvedBundle } from '../registry'
import { SdClient } from './client'
import { GIB, memoryBudgetBytes, type Hardware } from './hardware'
import type { ImageEngineRecord } from './install'
import { reapImageJobs } from './jobs'
import { serverPlan } from './flags'

/** Ports the image engine prefers: after the text engine's 8082–8095. */
export const IMAGE_PORTS: [number, number] = [8096, 8105]
export const DEFAULT_IMAGE_IDLE_TTL_MS = 10 * 60_000
const READY_TIMEOUT_MS = 600_000

export const ImageSharedRecordSchema = z.object({
  pid: z.number(),
  port: z.number(),
  /** The bundle it loaded, or null for an engine started only to upscale. */
  bundle: z.string().nullable(),
  key: z.string(),
  variant: z.string(),
  footprintBytes: z.number(),
  startedAt: z.string(),
  lastUsed: z.number(),
  idleTtlMs: z.number().optional(),
})
export type ImageSharedRecord = z.infer<typeof ImageSharedRecordSchema>

export async function readImageShared(): Promise<ImageSharedRecord | null> {
  try {
    const parsed = ImageSharedRecordSchema.safeParse(await Bun.file(imageSharedRecordPath()).json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function writeImageShared(record: ImageSharedRecord): Promise<void> {
  await mkdir(dirname(imageSharedRecordPath()), { recursive: true })
  await Bun.write(imageSharedRecordPath(), JSON.stringify(record))
}

export async function touchImageShared(idleTtlMs?: number): Promise<void> {
  const record = await readImageShared()
  if (record) await writeImageShared({ ...record, lastUsed: Date.now(), ...(idleTtlMs ? { idleTtlMs } : {}) })
}

/** Stop the warm image engine and WAIT for it to exit: its GPU memory is free only then. */
export async function stopImageShared(): Promise<boolean> {
  const record = await readImageShared()
  await rm(imageSharedRecordPath(), { force: true }).catch(() => {})
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
  await removeRunning(record.pid, imageRunningDir())
  return killed
}

/** `obrew engine stop` / `obrew image engine stop`: the warm engine and any other sd-server we started. */
export async function stopAllImageEngines(): Promise<number> {
  let stopped = (await stopImageShared()) ? 1 : 0
  for (const r of await listRunning(imageRunningDir())) {
    if (isAlive(r.pid)) {
      try {
        process.kill(r.pid)
        stopped++
        await waitGone(r.pid)
      } catch {
        // Already gone.
      }
    }
    await removeRunning(r.pid, imageRunningDir())
  }
  return stopped
}

export async function reapIdleImageShared(ttlMs?: number): Promise<boolean> {
  const record = await readImageShared()
  if (!record) return false
  if (!isAlive(record.pid)) {
    await stopImageShared()
    return false
  }
  const ttl = record.idleTtlMs ?? ttlMs ?? DEFAULT_IMAGE_IDLE_TTL_MS
  if (Date.now() - record.lastUsed < ttl) return false
  return stopImageShared()
}

/** After a hard kill of an earlier obrew: its non-shared engines, and its jobs in the warm one. */
export async function reapImageOrphans(log?: (m: string) => void): Promise<void> {
  await reapOrphans(log, imageRunningDir())
  await reapImageJobs(log)
}

/** The warm image engine, for the text engine's `makeRoom`. */
export const imagePeer: Peer = {
  kind: 'image',
  running: async () => {
    const record = await readImageShared()
    if (!record || !isAlive(record.pid)) return null
    return { footprintBytes: record.footprintBytes, onGpu: record.variant !== 'cpu' }
  },
  stop: () => stopImageShared(),
}

/** The warm text engine, for the image engine's `makeRoom`. */
export const textPeer: Peer = {
  kind: 'text',
  running: async () => {
    const record = await readShared()
    if (!record || !isAlive(record.pid)) return null
    const engine = await findEngine().catch(() => null)
    const entry = findModel(await loadRegistry().catch(() => ({ version: 1 as const, default: null, models: [] })), record.model)
    // The weights plus a context's worth of KV cache and compute buffers.
    const footprintBytes = (entry?.sizeBytes ?? 4 * GIB) + 1.5 * GIB
    return { footprintBytes, onGpu: engine ? engine.variant !== 'cpu' : true }
  },
  stop: () => stopShared(),
}

/** Out-of-memory, in the words each backend uses for it. */
export const OOM_PATTERN = /out of memory|cudaMalloc|ErrorOutOfDeviceMemory|hipErrorOutOfMemory|Insufficient Memory|failed to allocate|OutOfMemory/i

/** An engine failure as the right code: `out_of_memory` when that is what it was. */
export function engineFailure(message: string, tail = ''): ObrewError {
  const full = tail ? `${message}\n${tail}` : message
  return new ObrewError(OOM_PATTERN.test(full) ? 'out_of_memory' : 'engine_failed', full)
}

export interface ImageEngineHandle {
  client: SdClient
  port: number
  pid: number
  shared: boolean
  started: boolean
  bundle: string | null
  /** Record activity, so the idle reaper leaves the engine alone. */
  touch(): Promise<void>
  /** Done: release this run's lease; stop an ephemeral engine, leave a shared one warm. */
  release(): Promise<void>
}

export interface AcquireImageOptions {
  mode: 'shared' | 'ephemeral'
  engine: ImageEngineRecord
  /** The model to load; null when any engine will do (an upscale). */
  resolved: ResolvedBundle | null
  hardware: Hardware
  pairs?: Record<string, unknown>
  signal?: AbortSignal
  log?: (message: string) => void
  onStatus?: (state: 'starting' | 'loading' | 'ready', detail?: string) => void
  idleTtlMs?: number
  /** Windows: a visible console window for an engine this run starts. */
  console?: boolean
  readyTimeoutMs?: number
  /** How long to wait for another run to finish with an engine that must be replaced. */
  waitMs?: number
}

/** An engine that is our child: its stdout and stderr go to the log file, appended. */
function spawnAttached(argv: string[], cwd: string, env: Record<string, string | undefined>, logPath: string): number {
  const fd = openSync(logPath, 'a')
  try {
    const proc = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdin: 'ignore', stdout: fd, stderr: fd, windowsHide: true })
    return proc.pid
  } finally {
    closeSync(fd)
  }
}

interface ReadyOptions {
  pid: number
  client: SdClient
  expectModel: boolean
  signal?: AbortSignal
  timeoutMs: number
  onStatus?: AcquireImageOptions['onStatus']
}

async function waitImageReady(o: ReadyOptions): Promise<void> {
  const deadline = Date.now() + o.timeoutMs
  let lastBeat = 0
  while (Date.now() < deadline) {
    if (o.signal?.aborted) throw new ObrewError('aborted', 'image engine start aborted')
    const status = await o.client.modelStatus()
    if (status) {
      if (status.state === 'ready' || (!o.expectModel && status.state === 'empty')) {
        o.onStatus?.('ready')
        return
      }
      if (status.state === 'error') {
        throw engineFailure(`the image engine could not load the model: ${status.error ?? 'unknown error'}`, await logTail(serverLogPath(), 15))
      }
    }
    // A heartbeat while loading, so a host's stall timer sees the engine is not stuck.
    if (Date.now() - lastBeat > 10_000) {
      lastBeat = Date.now()
      o.onStatus?.('loading')
    }
    if (!isAlive(o.pid)) throw engineFailure(`the image engine (pid ${o.pid}) exited during startup`, await logTail(serverLogPath(), 15))
    await Bun.sleep(300)
  }
  throw engineFailure(`the image engine was not ready after ${o.timeoutMs / 1000} s`, await logTail(serverLogPath(), 15))
}

function handleFor(o: { client: SdClient; port: number; pid: number; shared: boolean; started: boolean; bundle: string | null; lease: LeaseHandle; idleTtlMs?: number }): ImageEngineHandle {
  const touch = o.shared ? () => touchImageShared(o.idleTtlMs) : async () => {}
  return {
    client: o.client,
    port: o.port,
    pid: o.pid,
    shared: o.shared,
    started: o.started,
    bundle: o.bundle,
    touch,
    release: async () => {
      await o.lease.release()
      if (o.shared) return touch()
      if (isAlive(o.pid)) {
        try {
          process.kill(o.pid)
        } catch {
          // Already gone.
        }
        await waitGone(o.pid)
      }
      await removeRunning(o.pid, imageRunningDir())
    },
  }
}

export async function acquireImageEngine(opts: AcquireImageOptions): Promise<ImageEngineHandle> {
  const { engine, resolved, hardware } = opts
  const plan = serverPlan({ engine, resolved, hardware, pairs: opts.pairs })
  for (const flag of plan.dropped) opts.log?.(`warning: this sd-server build has no ${flag}; running without it`)
  const bundle = resolved?.bundle.id ?? null

  if (opts.mode === 'shared') {
    const existing = await readImageShared()
    if (existing) {
      const alive = isAlive(existing.pid)
      const client = new SdClient(`http://127.0.0.1:${existing.port}`)
      const status = alive ? await client.modelStatus() : null
      const usable = status !== null && status.state !== 'error'
      // An upscale is served by whatever is warm: the upscaler loads beside any model.
      if (usable && (resolved === null || existing.key === plan.key)) {
        const lease = await takeLease('image', existing.footprintBytes)
        await touchImageShared(opts.idleTtlMs)
        opts.log?.(`image engine: reusing sd-server pid ${existing.pid} on port ${existing.port}`)
        opts.onStatus?.('ready')
        return handleFor({ client, port: existing.port, pid: existing.pid, shared: true, started: false, bundle: existing.bundle, lease, idleTtlMs: opts.idleTtlMs })
      }
      if (alive) {
        opts.log?.(`image engine: the warm sd-server runs ${existing.bundle ?? 'no model'}; replacing it`)
        await waitForIdle('image', { signal: opts.signal, waitMs: opts.waitMs, onWait: (m) => opts.onStatus?.('starting', m) })
      }
      await stopImageShared()
    }
  }

  // Make room on the GPU: an idle text engine that cannot share it is stopped first.
  await makeRoom(textPeer, {
    budgetBytes: memoryBudgetBytes(hardware),
    footprintBytes: plan.footprintBytes,
    onGpu: engine.variant !== 'cpu',
    signal: opts.signal,
    waitMs: opts.waitMs,
    log: opts.log,
    onWait: (m) => opts.onStatus?.('starting', m),
  })
  const lease = await takeLease('image', plan.footprintBytes)

  try {
    const port = await freePort(IMAGE_PORTS)
    const { args } = serverPlan({ engine, resolved, hardware, pairs: opts.pairs, port })
    const command = engineCommand(engine.server)
    const argv = [...command, ...args]
    const cwd = command.length > 1 ? process.cwd() : engine.binDir
    const logPath = serverLogPath()
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `\n--- start ${new Date().toISOString()} ---\n${argv.join(' ')}\n`)
    opts.onStatus?.('starting')
    // Shared: detached, so it outlives this run. Ephemeral: our attached child, as the text
    // engine's is — it dies with us, and (unlike a process WMI creates on Windows) inherits our
    // environment. Either way its output is appended to the one log.
    const pid = opts.mode === 'shared' ? await spawnDetached(argv, { cwd, env: plan.env, console: opts.console, stdioLog: logPath }) : spawnAttached(argv, cwd, plan.env, logPath)
    await recordRunning(
      { pid, port, ownerPid: process.pid, model: bundle ?? '(upscale only)', startedAt: new Date().toISOString(), shared: opts.mode === 'shared' },
      imageRunningDir(),
    )
    const client = new SdClient(`http://127.0.0.1:${port}`)
    try {
      await waitImageReady({ pid, client, expectModel: resolved !== null, signal: opts.signal, timeoutMs: opts.readyTimeoutMs ?? READY_TIMEOUT_MS, onStatus: opts.onStatus })
    } catch (err) {
      try {
        process.kill(pid)
      } catch {
        // Already gone.
      }
      await removeRunning(pid, imageRunningDir())
      throw err
    }
    if (opts.mode === 'shared') {
      await writeImageShared({
        pid,
        port,
        bundle,
        key: plan.key,
        variant: engine.variant,
        footprintBytes: plan.footprintBytes,
        startedAt: new Date().toISOString(),
        lastUsed: Date.now(),
        ...(opts.idleTtlMs ? { idleTtlMs: opts.idleTtlMs } : {}),
      })
    }
    opts.log?.(`image engine: started sd-server pid ${pid} on port ${port}${bundle ? ` (${bundle})` : ''}`)
    return handleFor({ client, port, pid, shared: opts.mode === 'shared', started: true, bundle, lease, idleTtlMs: opts.idleTtlMs })
  } catch (err) {
    await lease.release()
    throw err
  }
}

/**
 * For `obrew exec`: before the text engine starts, stop an idle image engine that would not
 * leave it room. One file read when no image engine is running, which is nearly always.
 */
export async function makeRoomForText(o: { footprintBytes: number; onGpu: boolean; hardware: () => Promise<Hardware>; signal?: AbortSignal; log?: (m: string) => void; onWait?: (m: string) => void }): Promise<void> {
  if (!(await imagePeer.running())) return
  const hardware = await o.hardware()
  await makeRoom(imagePeer, { budgetBytes: memoryBudgetBytes(hardware), footprintBytes: o.footprintBytes, onGpu: o.onGpu, signal: o.signal, log: o.log, onWait: o.onWait })
}
