/**
 * One GPU, two warm engines: the text engine (llama-server) and the image engine (sd-server).
 *
 * Each is kept warm between runs on purpose, and on a 32 GB Mac or a 16 GB+ card both fit at
 * once. On an 8 GB card they do not: Gemma 4 E2B at Q8 plus its context is ~6 GB, Z-Image-Turbo
 * ~7 GB. Starting one while the other holds the GPU would push both into offloading at best and
 * fail to allocate at worst. So before an engine starts, `makeRoom` asks whether the OTHER kind
 * is warm and on the same GPU, whether the two fit together in the budget with 10% to spare,
 * and if not, stops the other one — but only once it is idle. "Idle" is what leases say: every
 * obrew run that is USING an engine holds a lease file in `<data>/gpu/leases/`, so a busy
 * engine is waited for (within a bound), never killed mid-turn.
 *
 * Order matters and avoids a deadlock: make room FIRST, take the lease after. A run waiting for
 * room holds no lease, so a text run and an image run can never wait on each other.
 *
 * The engines are passed in as `Peer`s rather than imported, so this module depends on neither.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isAlive } from '../engine/running'
import { ObrewError } from './errors'
import { dataDir } from './paths'

export type EngineKind = 'text' | 'image'

const leasesDir = () => join(dataDir(), 'gpu', 'leases')

/**
 * One file per lease: `<pid>-<kind>-<n>.json`. Per lease, not per process, because one process
 * can hold several — `obrew serve` answers two image requests at once — and releasing one must
 * not mark the engine idle while the other still runs.
 */
const LEASE_FILE = /^(\d+)-(text|image)(?:-\d+)?\.json$/
let leaseSeq = 0

const LeaseSchema = z.object({ pid: z.number(), kind: z.enum(['text', 'image']), footprintBytes: z.number(), since: z.string() })
export type Lease = z.infer<typeof LeaseSchema>

export interface LeaseHandle {
  release(): Promise<void>
}

/** Mark an engine of `kind` as in use by this process until `release()`. */
export async function takeLease(kind: EngineKind, footprintBytes: number): Promise<LeaseHandle> {
  await mkdir(leasesDir(), { recursive: true })
  const path = join(leasesDir(), `${process.pid}-${kind}-${++leaseSeq}.json`)
  await Bun.write(path, JSON.stringify({ pid: process.pid, kind, footprintBytes, since: new Date().toISOString() }))
  let released = false
  return {
    release: async () => {
      if (released) return
      released = true
      await rm(path, { force: true }).catch(() => {})
    },
  }
}

/**
 * Live leases of `kind`, this process's own included: a run never waits while holding one of
 * the kind it waits for (room is made before the lease is taken), so any lease here is someone
 * else's work — in `obrew serve`, a sibling request's. Records of dead processes are dropped.
 */
export async function liveLeases(kind: EngineKind): Promise<Lease[]> {
  let names: string[]
  try {
    names = await readdir(leasesDir())
  } catch {
    return []
  }
  const out: Lease[] = []
  for (const name of names) {
    const m = name.match(LEASE_FILE)
    if (!m || m[2] !== kind) continue
    const path = join(leasesDir(), name)
    try {
      const parsed = LeaseSchema.safeParse(await Bun.file(path).json())
      if (!parsed.success || !isAlive(parsed.data.pid)) {
        await rm(path, { force: true }).catch(() => {})
        continue
      }
      out.push(parsed.data)
    } catch {
      // Being written or removed right now: skip it this round.
    }
  }
  return out
}

/** The other engine, as `makeRoom` needs to see it. */
export interface Peer {
  kind: EngineKind
  /** The warm engine, or null when none is running. `onGpu` is false for a CPU build. */
  running(): Promise<{ footprintBytes: number; onGpu: boolean } | null>
  /** Stop it and wait for it to exit (its memory is only free once the process is gone). */
  stop(): Promise<unknown>
}

export interface MakeRoomOptions {
  /** Bytes of accelerator memory available, or null when unknown (then nothing is evicted). */
  budgetBytes: number | null
  footprintBytes: number
  /** Whether the engine about to start runs on the GPU at all. */
  onGpu: boolean
  signal?: AbortSignal
  /** How long to wait for a busy peer before giving up (`timeout`). */
  waitMs?: number
  log?: (message: string) => void
  /** Called once, when the peer is busy and this run starts waiting for it. */
  onWait?: (message: string) => void
}

/**
 * Wait until no other process holds a lease of `kind`: the engine is idle and may be stopped.
 * Also how a run that must REPLACE the warm image engine (a different model) avoids killing a
 * generation another obrew is in the middle of.
 */
export async function waitForIdle(
  kind: EngineKind,
  opts: { signal?: AbortSignal; waitMs?: number; onWait?: (message: string) => void; why?: string },
): Promise<void> {
  const deadline = Date.now() + (opts.waitMs ?? 120_000)
  let announced = false
  while ((await liveLeases(kind)).length > 0) {
    if (opts.signal?.aborted) throw new ObrewError('aborted', `stopped while waiting for the ${kind} engine`)
    if (Date.now() > deadline) throw new ObrewError('timeout', `the ${kind} engine stayed busy${opts.why ? `, and ${opts.why}` : ''}`)
    if (!announced) {
      announced = true
      opts.onWait?.(`waiting for the ${kind} engine to finish`)
    }
    await Bun.sleep(500)
  }
}

/** Returns whether the peer was stopped. */
export async function makeRoom(peer: Peer, opts: MakeRoomOptions): Promise<boolean> {
  if (!opts.onGpu || opts.budgetBytes === null) return false
  const other = await peer.running()
  if (!other || !other.onGpu) return false
  if ((opts.footprintBytes + other.footprintBytes) * 1.1 <= opts.budgetBytes) return false
  await waitForIdle(peer.kind, { ...opts, why: 'both do not fit in GPU memory at once' })
  opts.log?.(`stopping the idle ${peer.kind} engine: both do not fit in GPU memory at once`)
  await peer.stop()
  return true
}
