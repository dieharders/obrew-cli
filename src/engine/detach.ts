/**
 * Start a process that OUTLIVES this one.
 *
 * `Bun.spawn` cannot: on Windows a child is tied to the parent's job object and dies with it
 * even when unref'd (measured, Bun 1.4.0), and there is no `detached` option on any platform.
 * So the warm shared engine is created by something that is not our child:
 *
 *   Windows  `Invoke-CimMethod Win32_Process Create` — the WMI provider host creates the
 *            process, returns its pid, and it belongs to no job of ours.
 *   POSIX    `sh -c 'nohup "$@" … & echo $!'` — backgrounded from a shell that then exits,
 *            so the engine is reparented to init; `$!` is its pid.
 *
 * Neither path inherits our stdio, so the engine writes its log to a FILE (`--log-file`, a
 * llama-server flag) rather than to a pipe we would have to keep open. Readiness is judged
 * by `/health` plus a pid-liveness check; a crash reports the tail of that file.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ObrewError } from '../shared/errors'
import type { EngineClient } from './client'
import { logTail } from './llama-server'
import { isAlive } from './running'

const READY_TIMEOUT_MS = 120_000
const POLL_MS = 500

/** Quote for a Windows CommandLine: wrap in double quotes, escape inner double quotes. */
const winQuote = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"`

export interface DetachOptions {
  cwd: string
  env?: Record<string, string | undefined>
}

export async function spawnDetached(argv: string[], opts: DetachOptions): Promise<number> {
  if (process.platform === 'win32') {
    const commandLine = argv.map(winQuote).join(' ')
    const script =
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
      `CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${opts.cwd.replace(/'/g, "''")}' }; ` +
      `if ($r.ReturnValue -ne 0) { Write-Error ("Win32_Process.Create failed: " + $r.ReturnValue); exit 1 }; Write-Output $r.ProcessId`
    const proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      env: { ...process.env, ...(opts.env ?? {}) },
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const pid = Number(out.trim())
    if (code !== 0 || !Number.isInteger(pid) || pid <= 0) {
      throw new ObrewError('engine_failed', `could not start a detached engine: ${err.trim() || out.trim() || `exit ${code}`}`)
    }
    return pid
  }

  const sh = Bun.which('sh') ?? '/bin/sh'
  const proc = Bun.spawn([sh, '-c', 'nohup "$@" </dev/null >/dev/null 2>&1 & echo $!', 'obrew-detach', ...argv], {
    cwd: opts.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const pid = Number(out.trim())
  if (code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new ObrewError('engine_failed', `could not start a detached engine: ${err.trim() || `exit ${code}`}`)
  }
  return pid
}

export interface WaitOptions {
  pid: number
  client: EngineClient
  logPath: string | null
  signal?: AbortSignal
  timeoutMs?: number
  onStatus?: (state: 'loading' | 'ready') => void
  /** Called on abort or timeout, before the error is thrown. */
  onGiveUp?: () => Promise<void>
}

/** Poll `/health` until ready; a dead pid or a timeout is `engine_failed` with the log tail. */
export async function waitReady(opts: WaitOptions): Promise<void> {
  if (opts.logPath) await mkdir(dirname(opts.logPath), { recursive: true })
  const deadline = Date.now() + (opts.timeoutMs ?? READY_TIMEOUT_MS)
  let sawLoading = false
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      await opts.onGiveUp?.()
      throw new ObrewError('aborted', 'engine start aborted')
    }
    const health = await opts.client.health()
    if (health === 'ok') {
      opts.onStatus?.('ready')
      return
    }
    if (health === 'loading' && !sawLoading) {
      sawLoading = true
      opts.onStatus?.('loading')
    }
    if (!isAlive(opts.pid)) {
      throw new ObrewError('engine_failed', `llama-server (pid ${opts.pid}) exited during startup:\n${opts.logPath ? await logTail(opts.logPath) : ''}`)
    }
    await Bun.sleep(POLL_MS)
  }
  await opts.onGiveUp?.()
  throw new ObrewError('engine_failed', `llama-server not ready after ${(opts.timeoutMs ?? READY_TIMEOUT_MS) / 1000} s:\n${opts.logPath ? await logTail(opts.logPath) : ''}`)
}
