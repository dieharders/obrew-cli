import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { tempHome } from '../../test/fixtures/home'
import { isAlive, listRunning, reapOrphans, recordRunning } from './running'

describe('reapOrphans', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
  })
  afterEach(() => home.cleanup())

  const base = { port: 1, model: 'm', startedAt: '', shared: false }

  test('drops records of dead engines and keeps live owned ones', async () => {
    await recordRunning({ ...base, pid: 999_999_9, ownerPid: process.pid })
    await recordRunning({ ...base, pid: process.pid, ownerPid: process.pid })
    expect(await reapOrphans()).toBe(0)
    const left = await listRunning()
    expect(left.map((r) => r.pid)).toEqual([process.pid])
  })

  test('kills a live engine whose owner is gone', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{}, 60000)'], { stdout: 'ignore', stderr: 'ignore' })
    await recordRunning({ ...base, pid: child.pid, ownerPid: 999_999_9 })
    expect(await reapOrphans()).toBe(1)
    await child.exited
    expect(isAlive(child.pid)).toBe(false)
    expect(await listRunning()).toHaveLength(0)
  })

  test('leaves a shared engine alone even when its owner is gone', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{}, 60000)'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await recordRunning({ ...base, pid: child.pid, ownerPid: 999_999_9, shared: true })
      expect(await reapOrphans()).toBe(0)
      expect(isAlive(child.pid)).toBe(true)
    } finally {
      child.kill()
      await child.exited
    }
  })
})
