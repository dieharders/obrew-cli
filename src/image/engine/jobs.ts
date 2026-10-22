/**
 * Records of image jobs in flight, and the reaper that cancels a dead owner's job.
 *
 * A host stops obrew with a kill; on Windows that is TerminateProcess and nothing of ours runs,
 * so a job obrew submitted would keep the GPU busy inside the WARM engine — which, unlike a
 * text slot, outlives us by design. So every submitted job is written to
 * `<data>/image/engine/jobs/<jobId>.json` with its owner's pid, removed when the run is done
 * with it, and the next obrew invocation cancels any job whose owner is gone.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isAlive } from '../../engine/running'
import { imageJobsDir } from '../paths'
import { SdClient } from './client'

export const JobRecordSchema = z.object({
  jobId: z.string(),
  port: z.number(),
  enginePid: z.number(),
  ownerPid: z.number(),
  startedAt: z.string(),
})
export type JobRecord = z.infer<typeof JobRecordSchema>

const fileFor = (jobId: string) => join(imageJobsDir(), `${jobId.replace(/[^\w.-]/g, '_')}.json`)

export async function recordJob(record: JobRecord): Promise<void> {
  await mkdir(imageJobsDir(), { recursive: true })
  await Bun.write(fileFor(record.jobId), JSON.stringify(record))
}

export async function removeJob(jobId: string): Promise<void> {
  await rm(fileFor(jobId), { force: true }).catch(() => {})
}

/** Cancel jobs whose owner died; drop records of jobs whose engine died. Returns how many were cancelled. */
export async function reapImageJobs(log?: (m: string) => void): Promise<number> {
  let names: string[]
  try {
    names = await readdir(imageJobsDir())
  } catch {
    return 0
  }
  let cancelled = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(imageJobsDir(), name)
    let record: JobRecord
    try {
      const parsed = JobRecordSchema.safeParse(await Bun.file(path).json())
      if (!parsed.success) {
        await rm(path, { force: true })
        continue
      }
      record = parsed.data
    } catch {
      await rm(path, { force: true }).catch(() => {})
      continue
    }
    if (isAlive(record.ownerPid)) continue
    if (isAlive(record.enginePid)) {
      await new SdClient(`http://127.0.0.1:${record.port}`).cancel(record.jobId)
      cancelled++
      log?.(`cancelled image job ${record.jobId} left behind by pid ${record.ownerPid}`)
    }
    await rm(path, { force: true }).catch(() => {})
  }
  return cancelled
}
