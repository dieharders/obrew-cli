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
 *
 * On Windows the engine is also created with NO CONSOLE (`DETACHED_PROCESS`). The WMI
 * provider host has no console to share, so without the flag Windows gives llama-server a
 * new console window of its own: a window on the user's desktop scrolling the engine's log
 * (with Windows Terminal as the default terminal, a whole terminal window), in front of
 * whatever app started the turn, and closing it kills the engine. The log file already has
 * everything that window showed; `obrew engine log` prints its tail. The window is still
 * available on request (`console`, from `-c engine_console=true`) for watching the engine
 * work; POSIX has no equivalent and ignores it.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ObrewError } from '../shared/errors'
import type { EngineClient } from './client'
import { logTail } from './llama-server'
import { isAlive } from './running'

const READY_TIMEOUT_MS = 120_000
const POLL_MS = 500
/** Win32 `DETACHED_PROCESS`: the new process gets no console at all. See the header. */
const DETACHED_PROCESS = 0x8
/** Win32 `CREATE_NEW_CONSOLE`: a console window of its own, when one is asked for. */
const CREATE_NEW_CONSOLE = 0x10

/** Quote for a Windows CommandLine: wrap in double quotes, escape inner double quotes. */
const winQuote = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"`

export interface DetachOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Windows: a visible console window instead of none. See the header. */
  console?: boolean
  /**
   * Append the process's stdout and stderr to this file. For an engine with no log-file flag of
   * its own — sd-server has none, where llama-server has `--log-file` and needs none of this.
   * POSIX redirects in the backgrounding shell. Windows wraps the engine in
   * `cmd /d /s /c "… >> log 2>&1"`, which makes cmd.exe the process WMI created, so the pid
   * returned is that of cmd's child, found by its parent pid and executable name: the pid the
   * caller records, polls and kills is the engine's, and cmd exits with it.
   */
  stdioLog?: string
}

const exeName = (path: string) => path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)

export async function spawnDetached(argv: string[], opts: DetachOptions): Promise<number> {
  // Both shells' `>>` fail on a missing directory.
  if (opts.stdioLog) await mkdir(dirname(opts.stdioLog), { recursive: true })
  if (process.platform === 'win32') {
    const engineLine = argv.map(winQuote).join(' ')
    const commandLine = opts.stdioLog
      ? `cmd.exe /d /s /c "${engineLine} >> ${winQuote(opts.stdioLog)} 2>&1"`
      : engineLine
    const createFlags = opts.console ? CREATE_NEW_CONSOLE : DETACHED_PROCESS
    // With a wrapper, wait (bounded) for cmd.exe to start the engine and report the ENGINE's pid.
    const child = opts.stdioLog
      ? `$name = '${exeName(argv[0] ?? '').replace(/'/g, "''")}'; ` +
        `for ($i = 0; $i -lt 100; $i++) { ` +
        `$c = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($r.ProcessId)" | Where-Object { $_.Name -ieq $name } | Select-Object -First 1; ` +
        `if ($c) { Write-Output $c.ProcessId; exit 0 }; Start-Sleep -Milliseconds 100 }; ` +
        `Write-Error ("the engine did not start under cmd.exe pid " + $r.ProcessId); exit 1`
      : `Write-Output $r.ProcessId`
    const script =
      `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ CreateFlags = [uint32]${createFlags} }; ` +
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
      `CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${opts.cwd.replace(/'/g, "''")}'; ProcessStartupInformation = $si }; ` +
      `if ($r.ReturnValue -ne 0) { Write-Error ("Win32_Process.Create failed: " + $r.ReturnValue); exit 1 }; ${child}`
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
  // `$1` is the log (or /dev/null), shifted off so `"$@"` is exactly the engine's argv.
  const script = 'log="$1"; shift; nohup "$@" </dev/null >>"$log" 2>&1 & echo $!'
  const proc = Bun.spawn([sh, '-c', script, 'obrew-detach', opts.stdioLog ?? '/dev/null', ...argv], {
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
