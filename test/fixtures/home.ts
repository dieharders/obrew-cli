/**
 * A throwaway `OBREW_HOME` per test, so registry / config / session writes never touch the
 * real data directory. Modules read `OBREW_HOME` at call time, so setting it here is enough.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function tempHome(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'obrew-test-'))
  const previous = process.env.OBREW_HOME
  process.env.OBREW_HOME = dir
  return {
    dir,
    cleanup: async () => {
      if (previous === undefined) delete process.env.OBREW_HOME
      else process.env.OBREW_HOME = previous
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export const FAKE_SERVER = join(import.meta.dir, 'fake-llama-server.ts')
