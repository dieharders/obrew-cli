/**
 * Two output modes, one interface.
 *
 * `--json`: every event is one line of JSON on STDOUT and nothing else ever touches stdout.
 * Human mode: assistant text streams to stdout as it arrives; status goes to stderr.
 * In both modes diagnostics go to stderr, so a host reading stdout sees only the contract.
 */
import type { ExecEvent } from '../shared/events'
import { humanBytes } from '../shared/download'

export interface Output {
  readonly json: boolean
  /** Emit a wire event (json mode) or its human rendering (text mode). */
  event(event: ExecEvent): void
  /** Diagnostic line, always stderr. */
  log(message: string): void
}

export function createOutput(json: boolean): Output {
  let lastProgressAt = 0
  const err = (s: string) => process.stderr.write(s)

  const human = (event: ExecEvent): void => {
    switch (event.type) {
      case 'delta':
        process.stdout.write(event.text)
        return
      case 'reasoning.start':
        err('[thinking]\n')
        return
      case 'reasoning.delta':
        return
      case 'engine.status':
        err(`[engine] ${event.state}${event.detail ? `: ${event.detail}` : ''}\n`)
        return
      case 'session':
        err(`[session] ${event.sessionId} (${event.model})\n`)
        return
      case 'tool.start':
        err(`[tool] ${event.name}\n`)
        return
      case 'tool.result':
        err(`[tool] ${event.name} ${event.ok ? 'ok' : 'FAILED'} in ${event.durationMs} ms\n`)
        return
      case 'turn.completed':
        process.stdout.write('\n')
        if (event.output !== undefined) process.stdout.write(JSON.stringify(event.output) + '\n')
        err(`[done] ${event.durationMs} ms, session ${event.sessionId}\n`)
        return
      case 'turn.failed':
        err(`error (${event.code}): ${event.message}\n`)
        return
      case 'download.progress': {
        const now = Date.now()
        if (now - lastProgressAt < 250 && event.received < event.total) return
        lastProgressAt = now
        const pct = event.total > 0 ? Math.floor((event.received / event.total) * 100) : 0
        err(`\r${event.file}: ${humanBytes(event.received)} / ${humanBytes(event.total)} (${pct}%)`)
        if (event.received >= event.total && event.total > 0) err('\n')
        return
      }
      case 'download.done':
        err(`saved ${event.file} → ${event.path}\n`)
        return
      case 'setup.log':
        err(`${event.message}\n`)
        return
      case 'setup.done':
        err(`${event.ok ? 'ok' : 'failed'}: ${event.message}\n`)
        return
      case 'download.plan': {
        const fetch = event.files.filter((f) => !f.cached)
        err(`${fetch.length} file${fetch.length === 1 ? '' : 's'} to download (${humanBytes(event.totalBytes)}), ${event.files.length - fetch.length} already here\n`)
        return
      }
      case 'image.started': {
        const what = event.mode === 'upscale' ? 'upscaling' : `${event.count} image${event.count === 1 ? '' : 's'}, ${event.width}×${event.height}`
        err(`[image] ${what}${event.model ? ` with ${event.model}` : ''}${event.seed !== null ? ` (seed ${event.seed})` : ''}\n`)
        return
      }
      case 'image.progress': {
        // Throttled like downloads: a host wants every event, a terminal does not.
        const now = Date.now()
        if (now - lastProgressAt < 250 && event.step !== event.steps) return
        lastProgressAt = now
        const detail =
          event.phase === 'sampling' && event.step !== undefined
            ? `step ${event.step}/${event.steps}`
            : event.phase === 'queued' && event.position
              ? `queued (position ${event.position})`
              : event.phase
        err(`\r[image ${event.index + 1}] ${detail}   `)
        return
      }
      case 'image.preview':
        return
      case 'image.saved':
        // The one thing a script wants from human mode: the path, alone on stdout.
        err('\n')
        if (event.path) process.stdout.write(`${event.path}\n`)
        err(`[image] ${event.width}×${event.height} in ${(event.durationMs / 1000).toFixed(1)} s${event.seed !== null ? `, seed ${event.seed}` : ''}\n`)
        return
      case 'image.completed':
        err(`[done] ${event.images.length} image${event.images.length === 1 ? '' : 's'} in ${(event.durationMs / 1000).toFixed(1)} s\n`)
        return
      case 'image.failed':
        err(`\nerror (${event.code}): ${event.message}\n`)
        return
    }
  }

  return {
    json,
    event: json ? (e) => process.stdout.write(JSON.stringify(e) + '\n') : human,
    log: (m) => err(`${m}\n`),
  }
}
