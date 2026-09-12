/**
 * `obrew engine install|status|stop|log`
 */
import { join } from 'node:path'
import { engineStatus, installEngine } from '../../engine/install'
import { isAlive, listRunning, removeRunning } from '../../engine/running'
import { LLAMACPP_TAG } from '../../engine/version'
import { VARIANTS } from '../../shared/config'
import { UsageError } from '../../shared/errors'
import { logsDir } from '../../shared/paths'
import { track, untrack } from '../../shared/proc'
import { oneOf, parse } from '../args'
import { createOutput } from '../output'

const HELP = `obrew engine install [--variant cuda|cpu|vulkan|metal] [--tag bNNNN] [--json]
obrew engine status [--json]
obrew engine stop            stop every llama-server obrew started
obrew engine log             print the llama-server log path and its tail`

export async function runEngine(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    variant: { type: 'string' },
    tag: { type: 'string' },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }

  switch (positionals[0]) {
    case 'install': {
      const out = createOutput(values.json)
      const controller = new AbortController()
      track(controller)
      const onSignal = () => controller.abort()
      process.once('SIGINT', onSignal)
      try {
        const record = await installEngine({
          tag: values.tag,
          variant: values.variant ? oneOf(values.variant, VARIANTS, '--variant') : undefined,
          signal: controller.signal,
          onLog: (message) => out.event({ type: 'setup.log', message }),
          onProgress: (file, received, total) => out.event({ type: 'download.progress', file, received, total }),
        })
        out.event({ type: 'setup.done', ok: true, message: `${record.tag} ${record.variant} → ${record.binary}` })
        return 0
      } finally {
        process.off('SIGINT', onSignal)
        untrack(controller)
      }
    }
    case 'status': {
      const status = await engineStatus()
      const running = (await listRunning()).filter((r) => isAlive(r.pid))
      if (values.json) {
        console.log(JSON.stringify({ ...status, pinnedTag: LLAMACPP_TAG, running }))
        return 0
      }
      console.log(status.installed ? `installed: ${status.tag} (${status.variant})\n  ${status.binary}` : `not installed (pinned tag ${LLAMACPP_TAG})`)
      for (const r of running) console.log(`running: pid ${r.pid} port ${r.port} ${r.model}${r.shared ? ' (shared)' : ''}`)
      return 0
    }
    case 'stop': {
      let stopped = 0
      for (const r of await listRunning()) {
        if (isAlive(r.pid)) {
          try {
            process.kill(r.pid)
            stopped++
          } catch {
            // Already gone.
          }
        }
        await removeRunning(r.pid)
      }
      console.log(`stopped ${stopped} engine${stopped === 1 ? '' : 's'}`)
      return 0
    }
    case 'log': {
      const path = join(logsDir(), 'llama-server.log')
      const file = Bun.file(path)
      console.log(path)
      if (await file.exists()) {
        const lines = (await file.text()).trimEnd().split('\n')
        console.log(lines.slice(-40).join('\n'))
      }
      return 0
    }
    default:
      throw new UsageError(`engine: unknown subcommand "${positionals[0] ?? ''}"\n\n${HELP}`)
  }
}
