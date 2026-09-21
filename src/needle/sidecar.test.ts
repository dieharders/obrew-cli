import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tempHome } from '../../test/fixtures/home'
import { isAlive } from '../engine/running'
import { acquireNeedle, listNeedles, needleEnv, needleKey, stopAllNeedles, type NeedleTool } from './sidecar'

const FAKE_NEEDLE = join(import.meta.dir, '../../test/fixtures/fake-needle.ts')
const install = { runner: FAKE_NEEDLE, weights: '', rev: 'test' }
const tool = (name: string): NeedleTool => ({ name, description: name, parameters: { type: 'object', properties: {} } })

describe('needle side-car', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
  })
  afterEach(async () => {
    await stopAllNeedles()
    delete process.env.FAKE_NEEDLE_ENV_FILE
    delete process.env.FAKE_NEEDLE_REPLY
    delete process.env.FAKE_NEEDLE_EXIT
    delete process.env.NEEDLE_TELEMETRY
    await home.cleanup()
  })

  test('telemetry is off in the runner, even when the caller turned it on', async () => {
    const envFile = join(home.dir, 'env.json')
    process.env.FAKE_NEEDLE_ENV_FILE = envFile
    process.env.NEEDLE_TELEMETRY = '1'
    await acquireNeedle({ install, model: 'needle3', tools: [tool('a')], forced: false })
    expect(await Bun.file(envFile).json()).toEqual({ NEEDLE_TELEMETRY: '0', DO_NOT_TRACK: '1' })
    expect(needleEnv()).toEqual({ NEEDLE_TELEMETRY: '0', DO_NOT_TRACK: '1' })
  })

  test('the same toolset reuses the warm side-car; a different one gets its own', async () => {
    const first = await acquireNeedle({ install, model: 'needle3', tools: [tool('a')], forced: false })
    const again = await acquireNeedle({ install, model: 'needle3', tools: [tool('a')], forced: false })
    const other = await acquireNeedle({ install, model: 'needle3', tools: [tool('b')], forced: false })
    expect(first.started).toBe(true)
    expect(again.started).toBe(false)
    expect(again.port).toBe(first.port)
    expect(other.started).toBe(true)
    expect(other.port).not.toBe(first.port)
    expect((await listNeedles()).length).toBe(2)
  })

  test('at most three stay alive: the least recently used is stopped', async () => {
    const handles = []
    for (const name of ['a', 'b', 'c', 'd']) {
      handles.push(await acquireNeedle({ install, model: 'needle3', tools: [tool(name)], forced: false }))
    }
    const records = await listNeedles()
    expect(records.length).toBe(3)
    expect(records.map((r) => r.tools[0]).sort()).toEqual(['b', 'c', 'd'])
  })

  test('complete() returns the calls and confidence; a runner failure returns none', async () => {
    process.env.FAKE_NEEDLE_REPLY = JSON.stringify({
      success: true,
      function_calls: [{ name: 'a', arguments: { x: 'y' } }],
      confidence: 0.91,
    })
    const ok = await acquireNeedle({ install, model: 'needle3', tools: [tool('a')], forced: false })
    expect(await ok.client.complete('do a', { timeoutMs: 2_000 })).toEqual({
      calls: [{ name: 'a', arguments: { x: 'y' } }],
      confidence: 0.91,
      error: null,
    })
    process.env.FAKE_NEEDLE_REPLY = JSON.stringify({ success: false, error_code: 'truncated', function_calls: [], confidence: 0.1 })
    const bad = await acquireNeedle({ install, model: 'needle3', tools: [tool('b')], forced: false })
    expect((await bad.client.complete('do b', { timeoutMs: 2_000 })).error).toBe('truncated')
  })

  test('a runner that exits at startup is an error, and leaves nothing behind', async () => {
    process.env.FAKE_NEEDLE_EXIT = '1'
    await expect(acquireNeedle({ install, model: 'needle3', tools: [tool('a')], forced: false })).rejects.toThrow(/exited during startup/)
    expect(await listNeedles()).toEqual([])
  })

  test('stopAllNeedles stops every side-car', async () => {
    await acquireNeedle({ install, model: 'needle3', tools: [tool('a')], forced: false })
    const [record] = await listNeedles()
    expect(await stopAllNeedles()).toBe(1)
    expect(isAlive(record!.pid)).toBe(false)
  })

  test('the key changes with the tools, the flag and the weights', () => {
    const base = needleKey('w', false, [tool('a')])
    expect(needleKey('w', false, [tool('a')])).toBe(base)
    expect(needleKey('w', true, [tool('a')])).not.toBe(base)
    expect(needleKey('w2', false, [tool('a')])).not.toBe(base)
    expect(needleKey('w', false, [tool('b')])).not.toBe(base)
  })
})
