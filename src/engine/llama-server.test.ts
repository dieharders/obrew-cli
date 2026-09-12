import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FAKE_SERVER, tempHome } from '../../test/fixtures/home'
import { LlamaServer } from './llama-server'
import { freePort } from './ports'
import { isAlive, listRunning } from './running'

describe('LlamaServer', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
  })
  afterEach(() => home.cleanup())

  const command = [process.execPath, FAKE_SERVER]

  test('starts, reports loading then ready, records itself, stops', async () => {
    const port = await freePort()
    const states: string[] = []
    const server = await LlamaServer.start({
      command,
      args: ['-m', 'fake.gguf', '--port', String(port)],
      port,
      model: 'fake',
      env: { FAKE_LOAD_MS: '1200' },
      onStatus: (s) => states.push(s),
      logPath: null,
    })
    expect(states).toEqual(['starting', 'loading', 'ready'])
    expect(await server.client.health()).toBe('ok')
    const running = await listRunning()
    expect(running).toHaveLength(1)
    expect(running[0]!.pid).toBe(server.pid!)
    expect(running[0]!.ownerPid).toBe(process.pid)

    await server.stop()
    expect(isAlive(server.pid!)).toBe(false)
    expect(await listRunning()).toHaveLength(0)
  })

  test('a crash during startup surfaces the stderr tail', async () => {
    const port = await freePort()
    const err = await LlamaServer.start({
      command,
      args: ['--port', String(port)],
      port,
      model: 'fake',
      env: { FAKE_EXIT_CODE: '3' },
      logPath: null,
    }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/exited with code 3/)
    expect((err as Error).message).toMatch(/unable to load model/)
  })

  test('an abort during startup stops the process', async () => {
    const port = await freePort()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const err = await LlamaServer.start({
      command,
      args: ['--port', String(port)],
      port,
      model: 'fake',
      env: { FAKE_LOAD_MS: '10000' },
      signal: controller.signal,
      logPath: null,
    }).catch((e: Error & { code?: string }) => e)
    expect((err as { code?: string }).code).toBe('aborted')
    expect(await listRunning()).toHaveLength(0)
  })
})
