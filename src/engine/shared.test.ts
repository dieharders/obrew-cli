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
    expect(isAlive(record!.pid)).toBe(false)
    const replaced = await readShared()
    expect(replaced?.model).toBe('m2')
    // A different PROCESS is what "replaces it" means; the port is not part of the contract.
    // `freePort()` prefers 8082, and the engine we just killed has released it by the time
    // `stopShared` returns (it waits for the exit), so the replacement binds the very same port.
    expect(replaced?.pid).not.toBe(record!.pid)
    expect((await listRunning()).filter((r) => isAlive(r.pid))).toHaveLength(1)
    // Two detached starts plus a health poll at 500 ms: on a Windows runner, where each one
    // goes out through PowerShell and the WMI provider host, that does not fit bun's default
    // 5 s. A timeout here also corrupts the NEXT test — the aborted acquire keeps running and
    // writes its shared record into the following test's OBREW_HOME.
  }, 60_000)

  test('replacing waits for the old process to die, so the first request reaches the new engine', async () => {
    // llama-server closes its listener the moment SIGTERM lands and lingers for seconds
    // tearing down GPU buffers. The replacement binds the same port, and this process has a
    // pooled keep-alive connection to it from the health check that found the old engine —
    // so unless the old process is gone first, the first request rides that connection into
    // the dead engine and hangs. Measured on real model swaps; the fake reproduces it.
    const first = await acquireEngine({
      mode: 'shared',
      command,
      args: ['-m', 'm1'],
      model: 'm1',
      logPath: null,
      env: { FAKE_LINGER_MS: '2500' },
    })
    const old = (await readShared())!.pid
    await first.release()

    const startedAt = Date.now()
    const second = await acquire('m2')
    expect(isAlive(old)).toBe(false)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2000) // it actually waited

    const deltas: string[] = []
    for await (const d of second.client.chat({ messages: [{ role: 'user', content: 'hi' }] }, AbortSignal.timeout(5000))) {
      if (d.content) deltas.push(d.content)
    }
    expect(deltas.join('')).toBe('Hello from the fake engine.')
    await second.release()
  }, 60_000)

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
