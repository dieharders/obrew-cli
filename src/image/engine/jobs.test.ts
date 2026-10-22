/**
 * The orphan-job reaper against the fake sd-server: a job whose owner died is cancelled (and the
 * engine stops it before it finishes), a live owner's job is left alone, and a record whose
 * engine is gone is dropped. On Windows a host's kill is TerminateProcess, so this is the only
 * way a cancelled run's job ever leaves the GPU.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_SD_SERVER, tempHome } from '../../../test/fixtures/home'
import { freePort } from '../../engine/ports'
import { imageJobsDir } from '../paths'
import { SdClient } from './client'
import { reapImageJobs, recordJob } from './jobs'

/** A pid that is certainly not running: a process that has already exited. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
  return proc.pid
}

describe('reapImageJobs', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ReturnType<typeof Bun.spawn>
  let client: SdClient
  let port: number
  let cancelLog: string

  beforeEach(async () => {
    home = await tempHome()
    cancelLog = join(home.dir, 'cancel.log')
    port = await freePort()
    server = Bun.spawn([process.execPath, FAKE_SD_SERVER, '--listen-port', String(port), '--diffusion-model', 'model.gguf'], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, FAKE_STEP_MS: '100', FAKE_LOG_CANCEL: cancelLog },
    })
    client = new SdClient(`http://127.0.0.1:${port}`)
    for (let i = 0; i < 100 && (await client.modelStatus()) === null; i++) await Bun.sleep(50)
  })
  afterEach(async () => {
    server.kill()
    await server.exited
    await home.cleanup()
  })

  const submit = () => client.submit({ prompt: 'x', width: 64, height: 64, sample_params: { sample_steps: 20 } } as never)
  const record = (jobId: string, ownerPid: number, enginePid = server.pid) =>
    recordJob({ jobId, port, enginePid, ownerPid, startedAt: new Date().toISOString() })

  test('a dead owner’s job is cancelled, and the engine stops it before it finishes', async () => {
    const id = await submit()
    await record(id, await deadPid())
    expect(await reapImageJobs()).toBe(1)
    expect(await readdir(imageJobsDir())).toEqual([])
    let job = await client.job(id)
    for (let i = 0; i < 20 && job.status !== 'cancelled'; i++) {
      await Bun.sleep(50)
      job = await client.job(id)
    }
    expect(job.status).toBe('cancelled')
    const [, step, steps] = (await readFile(cancelLog, 'utf8')).trim().match(/ cancelled (\d+)\/(\d+)$/) ?? []
    expect(Number(step)).toBeLessThan(Number(steps))
  })

  test('a live owner’s job is left alone', async () => {
    const id = await submit()
    await record(id, process.pid)
    expect(await reapImageJobs()).toBe(0)
    expect(await readdir(imageJobsDir())).toHaveLength(1)
    expect((await client.job(id)).status).not.toBe('cancelled')
  })

  test('a record whose engine is gone is dropped without a request', async () => {
    await record('job_gone', await deadPid(), await deadPid())
    expect(await reapImageJobs()).toBe(0)
    expect(await readdir(imageJobsDir())).toEqual([])
  })
})
