/**
 * GPU leases and making room, with fake peers so no engine runs: a lease marks this process as
 * using an engine until released; other live processes' leases are seen and dead ones cleaned
 * up; makeRoom stops the other engine only when both cannot fit with 10% to spare, it is on the
 * GPU, and it is idle — waiting, within a bound, while another process holds it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempHome } from '../../test/fixtures/home'
import { isAlive } from '../engine/running'
import {
  liveLeases,
  makeRoom,
  takeLease,
  waitForIdle,
  type EngineKind,
  type MakeRoomOptions,
  type Peer,
} from './gpu'

const GIB = 1024 ** 3

let home: Awaited<ReturnType<typeof tempHome>>
beforeEach(async () => {
  home = await tempHome()
})
afterEach(() => home.cleanup())

const leasesDir = () => join(home.dir, 'gpu', 'leases')
const leaseFile = (pid: number, kind: EngineKind) => join(leasesDir(), `${pid}-${kind}.json`)

/** A lease as another obrew process would leave it. */
async function foreignLease(
  pid: number,
  kind: EngineKind,
  footprintBytes = 6 * GIB,
): Promise<string> {
  await mkdir(leasesDir(), { recursive: true })
  await writeFile(
    leaseFile(pid, kind),
    JSON.stringify({ pid, kind, footprintBytes, since: '2026-10-22T09:00:00.000Z' }),
  )
  return leaseFile(pid, kind)
}

/** A pid no process has: 999999 unless, improbably, that one is taken. */
function deadPid(): number {
  let pid = 999_999
  while (isAlive(pid)) pid++
  return pid
}

/** Our parent (the shell or runner that started bun): alive, and not us. */
const LIVE_PID = process.ppid

function fakePeer(kind: EngineKind, warm: { footprintBytes: number; onGpu: boolean } | null) {
  const calls = { running: 0, stop: 0 }
  const peer: Peer = {
    kind,
    running: async () => {
      calls.running++
      return warm
    },
    stop: async () => {
      calls.stop++
    },
  }
  return { peer, calls }
}

describe('takeLease', () => {
  test('writes this process’s lease until release(); releasing twice is harmless', async () => {
    const lease = await takeLease('image', 7 * GIB)
    const [name] = await readdir(leasesDir())
    expect(name).toMatch(new RegExp(`^${process.pid}-image-\\d+\\.json$`))
    const path = join(leasesDir(), name!)
    expect(await Bun.file(path).json()).toEqual({
      pid: process.pid,
      kind: 'image',
      footprintBytes: 7 * GIB,
      since: expect.any(String),
    })
    await lease.release()
    expect(existsSync(path)).toBe(false)
    await lease.release()
    expect(existsSync(path)).toBe(false)
  })

  test(
    'two leases of one kind in one process: releasing the first leaves the engine marked in use',
    async () => {
      const first = await takeLease('image', 7 * GIB)
      const second = await takeLease('image', 7 * GIB)
      await first.release()
      expect(
        (await readdir(leasesDir())).some((name) => name.startsWith(`${process.pid}-image`)),
      ).toBe(true)
      await second.release()
      expect(await readdir(leasesDir())).toEqual([])
    },
  )
})

describe('liveLeases', () => {
  test('counts this process’s own leases too: in `obrew serve` a sibling request is someone else’s work', async () => {
    const lease = await takeLease('text', 6 * GIB)
    expect((await liveLeases('text')).map((l) => l.pid)).toEqual([process.pid])
    await lease.release()
    expect(await liveLeases('text')).toEqual([])
  })

  test('returns other live processes’ leases, and drops the records of dead ones', async () => {
    const dead = await foreignLease(deadPid(), 'image')
    await foreignLease(LIVE_PID, 'image', 5 * GIB)
    expect(await liveLeases('image')).toEqual([
      { pid: LIVE_PID, kind: 'image', footprintBytes: 5 * GIB, since: '2026-10-22T09:00:00.000Z' },
    ])
    expect(existsSync(dead)).toBe(false)
  })

  test('only the kind asked for; the other kind’s files are not touched', async () => {
    const text = await foreignLease(deadPid(), 'text')
    expect(await liveLeases('image')).toEqual([])
    expect(existsSync(text)).toBe(true)
  })

  test('a record that is not a lease is removed; one that does not parse (mid-write) is skipped', async () => {
    await mkdir(leasesDir(), { recursive: true })
    const wrong = join(leasesDir(), '123-image.json')
    const partial = join(leasesDir(), '456-image.json')
    await writeFile(wrong, JSON.stringify({ pid: 'nope' }))
    await writeFile(partial, '{"pid": 45')
    expect(await liveLeases('image')).toEqual([])
    expect(existsSync(wrong)).toBe(false)
    expect(existsSync(partial)).toBe(true)
  })

  test('no leases directory yet: none', async () => {
    expect(await liveLeases('image')).toEqual([])
  })
})

describe('waitForIdle', () => {
  test('returns at once when no other process holds a lease', async () => {
    await foreignLease(deadPid(), 'image')
    const waits: string[] = []
    const started = Date.now()
    await waitForIdle('image', { waitMs: 50, onWait: (m) => waits.push(m) })
    expect(Date.now() - started).toBeLessThan(400)
    expect(waits).toEqual([])
  })

  test('times out while a live process holds a lease, having said once that it waits', async () => {
    await foreignLease(LIVE_PID, 'image')
    const waits: string[] = []
    await expect(
      waitForIdle('image', {
        waitMs: 50,
        onWait: (m) => waits.push(m),
        why: 'it must be replaced',
      }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: 'the image engine stayed busy, and it must be replaced',
    })
    expect(waits).toEqual(['waiting for the image engine to finish'])
  })

  test('an aborted run stops waiting', async () => {
    await foreignLease(LIVE_PID, 'text')
    const ac = new AbortController()
    ac.abort()
    await expect(waitForIdle('text', { signal: ac.signal, waitMs: 60_000 })).rejects.toMatchObject({
      code: 'aborted',
    })
  })
})

describe('makeRoom', () => {
  /** Making room for an image engine with a 6 GiB footprint on a 16 GiB card. */
  const opts = (over: Partial<MakeRoomOptions> = {}): MakeRoomOptions => ({
    budgetBytes: 16 * GIB,
    footprintBytes: 6 * GIB,
    onGpu: true,
    waitMs: 50,
    ...over,
  })

  test('no warm peer: nothing to stop', async () => {
    const { peer, calls } = fakePeer('text', null)
    expect(await makeRoom(peer, opts())).toBe(false)
    expect(calls).toEqual({ running: 1, stop: 0 })
  })

  test('both fit with 10% to spare: the peer stays', async () => {
    // (6 + 8) × 1.1 = 15.4 ≤ 16
    const { peer, calls } = fakePeer('text', { footprintBytes: 8 * GIB, onGpu: true })
    expect(await makeRoom(peer, opts())).toBe(false)
    expect(calls.stop).toBe(0)
  })

  test('they do not fit and nobody is using the peer: it is stopped, and that is logged', async () => {
    // 7.7 GiB fits in 8 GiB, but not with 10% to spare.
    const { peer, calls } = fakePeer('text', { footprintBytes: 3.8 * GIB, onGpu: true })
    const logs: string[] = []
    await foreignLease(deadPid(), 'text') // a run that died holding it does not count
    expect(
      await makeRoom(
        peer,
        opts({ budgetBytes: 8 * GIB, footprintBytes: 3.9 * GIB, log: (m) => logs.push(m) }),
      ),
    ).toBe(true)
    expect(calls.stop).toBe(1)
    expect(logs).toEqual(['stopping the idle text engine: both do not fit in GPU memory at once'])
  })

  test('an unknown budget evicts nothing, and does not even ask', async () => {
    const { peer, calls } = fakePeer('text', { footprintBytes: 30 * GIB, onGpu: true })
    expect(await makeRoom(peer, opts({ budgetBytes: null }))).toBe(false)
    expect(calls).toEqual({ running: 0, stop: 0 })
  })

  test('a peer off the GPU, or an engine about to start off it, shares nothing', async () => {
    const offGpu = fakePeer('text', { footprintBytes: 30 * GIB, onGpu: false })
    expect(await makeRoom(offGpu.peer, opts())).toBe(false)
    expect(offGpu.calls.stop).toBe(0)
    const onGpu = fakePeer('text', { footprintBytes: 30 * GIB, onGpu: true })
    expect(await makeRoom(onGpu.peer, opts({ onGpu: false }))).toBe(false)
    expect(onGpu.calls).toEqual({ running: 0, stop: 0 })
  })

  test('a peer another process is using is waited for, never killed: the wait times out', async () => {
    await foreignLease(LIVE_PID, 'image')
    const { peer, calls } = fakePeer('image', { footprintBytes: 7 * GIB, onGpu: true })
    const waits: string[] = []
    await expect(
      makeRoom(peer, opts({ budgetBytes: 8 * GIB, onWait: (m) => waits.push(m) })),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: 'the image engine stayed busy, and both do not fit in GPU memory at once',
    })
    expect(waits).toEqual(['waiting for the image engine to finish'])
    expect(calls.stop).toBe(0)
  })

  test('a busy peer that goes idle while waited for is then stopped', async () => {
    const busy = await foreignLease(LIVE_PID, 'text')
    const { peer, calls } = fakePeer('text', { footprintBytes: 7 * GIB, onGpu: true })
    setTimeout(() => void rm(busy, { force: true }), 100)
    expect(await makeRoom(peer, opts({ budgetBytes: 8 * GIB, waitMs: 3_000 }))).toBe(true)
    expect(calls.stop).toBe(1)
  })
})
