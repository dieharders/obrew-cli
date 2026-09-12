import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FAKE_SERVER, tempHome } from '../../test/fixtures/home'
import { acquireEngine, engineKey, readShared, reapIdleShared, stopShared } from './shared'
import { isAlive, listRunning } from './running'

describe('shared engine', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
  })
  afterEach(async () => {
    await stopShared()
    await home.cleanup()
  })

  const command = [process.execPath, FAKE_SERVER]
  const acquire = (model = 'm1', extra: string[] = []) =>
    acquireEngine({ mode: 'shared', command, args: ['-m', model, ...extra], model, logPath: null })

  test('engineKey ignores the port and nothing else', () => {
    expect(engineKey('m', ['-m', 'x', '--port', '1', '--jinja'])).toBe(engineKey('m', ['-m', 'x', '--port', '2', '--jinja']))
    expect(engineKey('m', ['-m', 'x'])).not.toBe(engineKey('m', ['-m', 'x', '--ctx-size', '8']))
  })

  test('the second acquire reuses the first engine; a different model replaces it', async () => {
    const first = await acquire()
    expect(first.started).toBe(true)
    const record = await readShared()
    expect(record?.port).toBe(first.port)
    await first.release()
    expect(isAlive(record!.pid)).toBe(true) // release keeps a shared engine warm

    const second = await acquire()
    expect(second.started).toBe(false)
    expect(second.port).toBe(first.port)
    await second.release()

    const third = await acquire('m2')
    expect(third.started).toBe(true)
    expect(third.port).not.toBe(first.port)
    expect(isAlive(record!.pid)).toBe(false)
    expect((await readShared())?.model).toBe('m2')
    expect((await listRunning()).filter((r) => isAlive(r.pid))).toHaveLength(1)
  })

  test('ephemeral mode stops on release and never writes the record', async () => {
    const h = await acquireEngine({ mode: 'ephemeral', command, args: ['-m', 'e'], model: 'e', logPath: null })
    expect(await readShared()).toBeNull()
    await h.release()
    expect(await h.client.health()).toBe('down')
  })

  test('idle reaping honours the TTL; a dead pid is cleaned up', async () => {
    const h = await acquire()
    expect(await reapIdleShared(60_000)).toBe(false)
    expect(await reapIdleShared(0)).toBe(true)
    expect(await readShared()).toBeNull()
    expect(await h.client.health()).toBe('down')

    // A record for a process that no longer exists.
    const again = await acquire()
    const pid = (await readShared())!.pid
    process.kill(pid)
    await Bun.sleep(300)
    expect(await reapIdleShared(60_000)).toBe(false)
    expect(await readShared()).toBeNull()
    void again
  })
})
