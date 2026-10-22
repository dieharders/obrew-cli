/**
 * The warm image engine against the fake sd-server: start, reuse on the same key, replace on a
 * different model, an upscale served by whatever is warm, failures reported with the engine's
 * own words (its stdout/stderr are captured to the log, since sd-server has no --log-file), the
 * idle reaper, and stopping everything.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FAKE_SD_SERVER, tempHome } from '../../../test/fixtures/home'
import { seedImageModels } from '../../../test/fixtures/image-home'
import { isAlive } from '../../engine/running'
import { logTail } from '../../engine/llama-server'
import { serverLogPath } from '../paths'
import { resolveBundle } from '../registry'
import { detectHardware } from './hardware'
import { requireImageEngine } from './install'
import { acquireImageEngine, readImageShared, reapIdleImageShared, stopAllImageEngines, type AcquireImageOptions } from './shared'

describe('acquireImageEngine', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
    process.env.OBREW_SD_SERVER = FAKE_SD_SERVER
    process.env.OBREW_GPU_BUDGET_GIB = '24'
    await seedImageModels()
  })
  afterEach(async () => {
    await stopAllImageEngines()
    for (const k of ['OBREW_SD_SERVER', 'OBREW_GPU_BUDGET_GIB', 'FAKE_LOAD_ERROR', 'FAKE_EXIT_CODE', 'FAKE_LOAD_MS']) delete process.env[k]
    await home.cleanup()
  })

  const options = async (model: string | null, overrides: Partial<AcquireImageOptions> = {}): Promise<AcquireImageOptions> => ({
    mode: 'shared',
    engine: await requireImageEngine(),
    resolved: model ? await resolveBundle(model, 'generator') : null,
    hardware: await detectHardware(),
    ...overrides,
  })

  test('starts once, then reuses the warm engine for the same model', async () => {
    const statuses: string[] = []
    const first = await acquireImageEngine(await options('z-image-turbo', { onStatus: (s) => statuses.push(s) }))
    expect(first.started).toBe(true)
    expect(statuses[0]).toBe('starting')
    expect(statuses.at(-1)).toBe('ready')
    await first.release()
    expect(isAlive(first.pid)).toBe(true)
    const record = await readImageShared()
    expect(record).toMatchObject({ pid: first.pid, bundle: 'z-image-turbo' })

    const second = await acquireImageEngine(await options('z-image-turbo'))
    expect(second.started).toBe(false)
    expect(second.pid).toBe(first.pid)
    await second.release()
  })

  test('a different model replaces it; an upscale reuses whatever is warm', async () => {
    const a = await acquireImageEngine(await options('z-image-turbo'))
    await a.release()
    const b = await acquireImageEngine(await options('flux2-klein-4b'))
    expect(b.started).toBe(true)
    expect(b.pid).not.toBe(a.pid)
    expect(isAlive(a.pid)).toBe(false)
    await b.release()
    const up = await acquireImageEngine(await options(null))
    expect(up.started).toBe(false)
    expect(up.pid).toBe(b.pid)
    await up.release()
  })

  test('a model that fails to load is engine_failed with its message, and nothing is left running', async () => {
    process.env.FAKE_LOAD_ERROR = 'unknown model architecture'
    // Ephemeral (attached) so the scripted behaviour reaches the fake on every platform.
    await expect(acquireImageEngine(await options('z-image-turbo', { mode: 'ephemeral' }))).rejects.toMatchObject({ code: 'engine_failed', message: expect.stringContaining('unknown model architecture') })
    expect(await readImageShared()).toBeNull()
  })

  test('an engine that exits at startup is reported with the tail of its captured output', async () => {
    process.env.FAKE_EXIT_CODE = '3'
    await expect(acquireImageEngine(await options('z-image-turbo', { mode: 'ephemeral' }))).rejects.toMatchObject({ code: 'engine_failed', message: expect.stringContaining('unknown model architecture') })
    expect(await logTail(serverLogPath())).toContain('failed to load model')
  })

  test('the idle reaper stops an engine past its TTL; stopAll stops everything', async () => {
    const h = await acquireImageEngine(await options('z-image-turbo', { idleTtlMs: 1 }))
    await h.release()
    await Bun.sleep(10)
    expect(await reapIdleImageShared()).toBe(true)
    expect(isAlive(h.pid)).toBe(false)
    const eph = await acquireImageEngine(await options('z-image-turbo', { mode: 'ephemeral' }))
    expect(await readImageShared()).toBeNull()
    await eph.release()
    expect(isAlive(eph.pid)).toBe(false)
  })
})
