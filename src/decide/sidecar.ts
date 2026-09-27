/**
 * The decision sidecar: GLiNER2.5-Decide in a warm Python process, for hosts that want typed
 * picks (a theme, a voice, a transition) without spending an LLM turn on them.
 *
 * Python, not llama.cpp, because the model is an encoder that only ships as PyTorch weights.
 * So `obrew decide install` builds a private venv (Python >= 3.12, CPU torch, gliner2) under
 * `<data>/decide/`, writes the embedded server.py beside it, and downloads the model once.
 *
 *   decide/venv/          the private interpreter; SHORT on purpose — pip's nested paths
 *                         break Windows' 260-character limit under a deep parent directory
 *   decide/server.py      ./server.py, as embedded in this binary
 *   decide/installed.json what install produced (model, python)
 *   decide/sidecar.json   the running server: pid, port, model
 *
 * Like the shared engine it is started DETACHED (spawnDetached) so it outlives the obrew
 * that started it; unlike the engine it reaps ITSELF, exiting after `idleMs` without a
 * request, so there is no orphan to hunt for. A load is 4–8 s on CPU, which is why a host
 * must never pay it per call.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { spawnDetached } from '../engine/detach'
import { freePort } from '../engine/ports'
import { isAlive } from '../engine/running'
import { hfToken, loadConfig } from '../shared/config'
import { ObrewError } from '../shared/errors'
import { dataDir, logsDir } from '../shared/paths'
import serverSource from './server.py' with { type: 'text' }

export const DEFAULT_DECIDE_MODEL = 'fastino/GLiNER2.5-Decide'
/** Matches the host's engine keep-warm: a job's decisions are spread across its phases. */
export const DEFAULT_DECIDE_IDLE_MS = 60 * 60_000
const MIN_PYTHON: [number, number] = [3, 12]
/** Past obrew-engine's 8082–8095, so the sidecar never takes the port a llama-server prefers. */
const PORT_RANGE: [number, number] = [8096, 8110]
const READY_TIMEOUT_MS = 180_000
const POLL_MS = 250

export const decideDir = () => join(dataDir(), 'decide')
export const venvPython = () =>
  process.platform === 'win32' ? join(decideDir(), 'venv', 'Scripts', 'python.exe') : join(decideDir(), 'venv', 'bin', 'python')
const serverPath = () => join(decideDir(), 'server.py')
const installedPath = () => join(decideDir(), 'installed.json')
const recordPath = () => join(decideDir(), 'sidecar.json')
export const decideLogPath = () => join(logsDir(), 'decide.log')

const InstalledSchema = z.object({ model: z.string(), python: z.string(), installedAt: z.string() })
const RecordSchema = z.object({ pid: z.number(), port: z.number(), model: z.string(), startedAt: z.string() })
export type SidecarRecord = z.infer<typeof RecordSchema>

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    const parsed = schema.safeParse(await file.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const readInstalled = () => readJson(installedPath(), InstalledSchema)
export const readSidecar = () => readJson(recordPath(), RecordSchema)

/** `3.12.4` → true against MIN_PYTHON. EXPORTED FOR TESTS. */
export function pythonVersionOk(version: string): boolean {
  const [major, minor] = version.trim().split('.').map(Number)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false
  return major! > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor! >= MIN_PYTHON[1])
}

/** Interpreters to try, best first. `OBREW_PYTHON` wins outright. EXPORTED FOR TESTS. */
export function pythonCandidates(platform = process.platform, env = process.env): string[][] {
  if (env.OBREW_PYTHON) return [[env.OBREW_PYTHON]]
  const versioned = ['3.13', '3.12']
  if (platform === 'win32') return [...versioned.map((v) => ['py', `-${v}`]), ['python']]
  return [...versioned.map((v) => [`python${v}`]), ['python3'], ['python']]
}

async function run(argv: string[], opts: { quiet?: boolean; env?: Record<string, string | undefined> } = {}): Promise<{ code: number; out: string; err: string }> {
  let proc
  try {
    proc = Bun.spawn(argv, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      env: { ...process.env, ...(opts.env ?? {}) },
    })
  } catch (err) {
    return { code: -1, out: '', err: (err as Error).message }
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (!opts.quiet && code !== 0) console.error(err.trim().split('\n').slice(-15).join('\n'))
  return { code, out, err }
}

async function findPython(): Promise<{ argv: string[]; version: string }> {
  const tried: string[] = []
  for (const argv of pythonCandidates()) {
    const { code, out } = await run([...argv, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { quiet: true })
    tried.push(argv.join(' '))
    if (code === 0 && pythonVersionOk(out)) return { argv, version: out.trim() }
  }
  throw new ObrewError(
    'engine_missing',
    `the decision model needs Python ${MIN_PYTHON.join('.')}+; none found (tried: ${tried.join(', ')}). Install it, or point OBREW_PYTHON at one.`,
  )
}

/**
 * Build the venv, install the libraries, write server.py and download the model. Re-running
 * it repairs a broken install. `onStep` narrates, because the torch download takes minutes.
 */
export async function installDecide(opts: { model?: string; onStep?: (step: string) => void } = {}): Promise<{ model: string; python: string }> {
  const model = opts.model ?? DEFAULT_DECIDE_MODEL
  const step = opts.onStep ?? (() => {})
  await stopSidecar()
  await mkdir(decideDir(), { recursive: true })

  const python = await findPython()
  step(`python ${python.version} (${python.argv.join(' ')})`)
  if (!(await Bun.file(venvPython()).exists())) {
    step('creating venv')
    const venv = await run([...python.argv, '-m', 'venv', join(decideDir(), 'venv')])
    if (venv.code !== 0) throw new ObrewError('engine_failed', 'could not create the decision venv')
  }
  const pip = (args: string[]) => run([venvPython(), '-m', 'pip', 'install', '--disable-pip-version-check', '-q', ...args])
  step('installing torch (CPU build; a few minutes the first time)')
  // PyPI stays the primary index: the CPU index alone lacks the build deps other packages need.
  if ((await pip(['torch', '--extra-index-url', 'https://download.pytorch.org/whl/cpu'])).code !== 0) {
    throw new ObrewError('engine_failed', 'pip could not install torch')
  }
  step('installing gliner2')
  // peft is imported unconditionally by gliner2 2.0's runtime but not declared by it.
  if ((await pip(['gliner2>=2.0,<3', 'peft'])).code !== 0) throw new ObrewError('engine_failed', 'pip could not install gliner2')
  await Bun.write(serverPath(), serverSource)

  step(`downloading ${model}`)
  const config = await loadConfig()
  const token = hfToken(config)
  const fetched = await run([venvPython(), serverPath(), '--model', model, '--prefetch'], { env: { ...(token ? { HF_TOKEN: token } : {}), PYTHONIOENCODING: 'utf-8' } })
  if (fetched.code !== 0) throw new ObrewError('model_missing', `could not download ${model}`)

  await Bun.write(installedPath(), JSON.stringify({ model, python: python.version, installedAt: new Date().toISOString() }))
  step('installed')
  return { model, python: python.version }
}

async function health(port: number): Promise<'ok' | 'loading' | 'down'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    if (res.status === 200) return 'ok'
    if (res.status === 503) return 'loading'
    return 'down'
  } catch {
    return 'down'
  }
}

async function logTail(lines = 20): Promise<string> {
  const file = Bun.file(decideLogPath())
  if (!(await file.exists())) return ''
  return (await file.text()).trimEnd().split('\n').slice(-lines).join('\n')
}

/** The running sidecar when it is alive, healthy and serving `model`; otherwise null. */
async function findRunning(model: string): Promise<SidecarRecord | null> {
  const record = await readSidecar()
  if (!record) return null
  if (record.model === model && isAlive(record.pid) && (await health(record.port)) === 'ok') return record
  return null
}

export interface SidecarHandle {
  port: number
  pid: number
  /** Whether this call started it (and so paid the model load). */
  started: boolean
}

/** The warm sidecar, started detached when none is running. */
export async function acquireSidecar(opts: { model?: string; idleMs?: number; signal?: AbortSignal } = {}): Promise<SidecarHandle> {
  const installed = await readInstalled()
  if (!installed || !(await Bun.file(venvPython()).exists())) {
    throw new ObrewError('engine_missing', 'the decision model is not installed; run `obrew decide install`')
  }
  const model = opts.model ?? installed.model
  const running = await findRunning(model)
  if (running) return { port: running.port, pid: running.pid, started: false }
  await stopSidecar()

  // server.py is rewritten on every start, so a newer obrew never runs an older server.
  await Bun.write(serverPath(), serverSource)
  await mkdir(logsDir(), { recursive: true })
  const port = await freePort(PORT_RANGE)
  const config = await loadConfig()
  const token = hfToken(config)
  const device = config.variant === 'cuda' ? 'cuda' : 'cpu'
  const argv = [venvPython(), serverPath(), '--model', model, '--port', String(port), '--idle-ms', String(opts.idleMs ?? DEFAULT_DECIDE_IDLE_MS), '--device', device, '--log-file', decideLogPath()]
  const pid = await spawnDetached(argv, {
    cwd: decideDir(),
    env: { PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_PROGRESS_BARS: '1', ...(token ? { HF_TOKEN: token } : {}) },
  })
  await Bun.write(recordPath(), JSON.stringify({ pid, port, model, startedAt: new Date().toISOString() }))

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      await stopSidecar()
      throw new ObrewError('aborted', 'decision sidecar start aborted')
    }
    if ((await health(port)) === 'ok') return { port, pid, started: true }
    if (!isAlive(pid)) {
      await rm(recordPath(), { force: true }).catch(() => {})
      throw new ObrewError('engine_failed', `the decision sidecar (pid ${pid}) exited during startup:\n${await logTail()}`)
    }
    await Bun.sleep(POLL_MS)
  }
  await stopSidecar()
  throw new ObrewError('engine_failed', `the decision sidecar was not ready after ${READY_TIMEOUT_MS / 1000} s:\n${await logTail()}`)
}

/** Stop the recorded sidecar if it is running and drop the record. Returns whether one was stopped. */
export async function stopSidecar(): Promise<boolean> {
  const record = await readSidecar()
  await rm(recordPath(), { force: true }).catch(() => {})
  if (!record || !isAlive(record.pid)) return false
  await fetch(`http://127.0.0.1:${record.port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => null)
  const deadline = Date.now() + 5000
  while (isAlive(record.pid) && Date.now() < deadline) await Bun.sleep(100)
  if (isAlive(record.pid)) {
    try {
      process.kill(record.pid, 'SIGKILL')
    } catch {
      // Gone between the check and the kill.
    }
  }
  return true
}

export type DecideOp = 'classify' | 'extract'

/** One request to the sidecar. `body` is the server's own shape (see server.py). */
export async function callSidecar(port: number, op: DecideOp, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  } catch (err) {
    if (signal?.aborted) throw new ObrewError('aborted', `decide ${op} aborted`)
    throw new ObrewError('engine_failed', `decision sidecar unreachable: ${(err as Error).message}`)
  }
  const payload = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status === 400) throw new ObrewError('bad_request', payload.error ?? `decide ${op}: bad request`)
  if (!res.ok) throw new ObrewError('engine_failed', payload.error ?? `decide ${op}: HTTP ${res.status}`)
  return payload
}
