/**
 * Records of live llama-server processes, and the reaper that cleans up after a hard kill.
 *
 * A host stops `obrew` with `proc.kill()`. On Windows that is TerminateProcess: no signal
 * handler runs, `process.on('exit')` never fires, and a llama-server we spawned keeps the GPU
 * until someone notices. So every spawn writes `<data>/engine/running/<pid>.json` naming
 * itself and its owner, and every obrew invocation starts by reaping records whose owner is
 * dead (unless the record is marked `shared`, which is the warm engine of a later phase).
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { runningDir } from '../shared/paths'

export const RunningRecordSchema = z.object({
  pid: z.number(),
  port: z.number(),
  ownerPid: z.number(),
  model: z.string(),
  startedAt: z.string(),
  shared: z.boolean(),
})
export type RunningRecord = z.infer<typeof RunningRecordSchema>

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but is not ours; ESRCH means gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function recordRunning(record: RunningRecord): Promise<void> {
  await mkdir(runningDir(), { recursive: true })
  await Bun.write(join(runningDir(), `${record.pid}.json`), JSON.stringify(record))
}

export async function removeRunning(pid: number): Promise<void> {
  await rm(join(runningDir(), `${pid}.json`), { force: true }).catch(() => {})
}

export async function listRunning(): Promise<RunningRecord[]> {
  let names: string[]
  try {
    names = await readdir(runningDir())
  } catch {
    return []
  }
  const out: RunningRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = RunningRecordSchema.safeParse(await Bun.file(join(runningDir(), name)).json())
      if (parsed.success) out.push(parsed.data)
    } catch {
      // Unreadable record; the reaper drops it below.
    }
  }
  return out
}

/** Kill engines whose owning obrew is gone; drop records of engines that are gone. */
export async function reapOrphans(log?: (m: string) => void): Promise<number> {
  let reaped = 0
  for (const record of await listRunning()) {
    if (!isAlive(record.pid)) {
      await removeRunning(record.pid)
      continue
    }
    if (record.shared || isAlive(record.ownerPid)) continue
    try {
      process.kill(record.pid)
      reaped++
      log?.(`reaped orphaned llama-server pid ${record.pid} (port ${record.port})`)
    } catch {
      // Already gone between the check and the kill.
    }
    await removeRunning(record.pid)
  }
  return reaped
}
