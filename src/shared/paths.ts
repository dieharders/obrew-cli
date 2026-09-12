/**
 * Where obrew keeps its state.
 *
 * One directory, per platform convention (the same rule motionbuff's `managedRoot()` uses),
 * overridable with `OBREW_HOME` so a dev checkout or a test can point it anywhere. Nothing is
 * ever written next to the executable: the binary may live in a read-only bundle or in
 * another app's managed directory.
 *
 *   engines/<tag>-<variant>/     llama-server binaries, downloaded on demand
 *   models/<org>--<repo>/        .gguf files, flat; models.json is the index
 *   sessions/<id>.jsonl          exec transcripts, for `exec resume`
 *   engine/running/<pid>.json    live llama-server records, for the orphan reaper
 *   logs/                        llama-server.log
 *   config.json  models.json
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_DIR = 'Obrew'

export function dataDir(): string {
  const override = process.env.OBREW_HOME
  if (override) return override
  const home = homedir()
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), APP_DIR)
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DIR)
  }
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_DIR.toLowerCase())
}

export const enginesDir = () => join(dataDir(), 'engines')
export const modelsDir = () => join(dataDir(), 'models')
export const sessionsDir = () => join(dataDir(), 'sessions')
export const runningDir = () => join(dataDir(), 'engine', 'running')
export const logsDir = () => join(dataDir(), 'logs')
export const tmpDir = () => join(dataDir(), 'tmp')
export const configPath = () => join(dataDir(), 'config.json')
export const registryPath = () => join(dataDir(), 'models.json')
