/**
 * `obrew engine install|status|start|stop|log`
 */
import { join } from 'node:path'
import { launchArgs, loadOptionsFrom } from '../../engine/flags'
import { engineStatus, installEngine, requireEngine } from '../../engine/install'
import { isAlive, listRunning, removeRunning } from '../../engine/running'
import { acquireEngine, readShared, stopShared } from '../../engine/shared'
import { LLAMACPP_TAG } from '../../engine/version'
import { resolveModel } from '../../models/registry'
import { DEFAULT_CTX_SIZE, loadConfig, VARIANTS } from '../../shared/config'
import { UsageError } from '../../shared/errors'
import { logsDir } from '../../shared/paths'
import { track, untrack } from '../../shared/proc'
import { oneOf, parse, parseConfigPairs } from '../args'
import { createOutput } from '../output'
import { engineCommand } from './exec'

const HELP = `obrew engine install [--variant cuda|cpu|vulkan|metal] [--tag bNNNN] [--json]
obrew engine status [--json]
obrew engine start [--model <id>] [-c key=value ...]   start (or reuse) the warm shared engine
obrew engine stop            stop the shared engine and every llama-server obrew started
obrew engine log             print the llama-server log path and its tail`

export async function runEngine(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    variant: { type: 'string' },
    tag: { type: 'string' },
    model: { type: 'string' },
    config: { type: 'string', multiple: true, short: 'c' },
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
      const shared = await readShared()
      const sharedLive = shared && isAlive(shared.pid) ? shared : null
      if (values.json) {
        console.log(JSON.stringify({ ...status, pinnedTag: LLAMACPP_TAG, running, shared: sharedLive }))
        return 0
      }
      console.log(status.installed ? `installed: ${status.tag} (${status.variant})\n  ${status.binary}` : `not installed (pinned tag ${LLAMACPP_TAG})`)
      if (sharedLive) {
        const idle = Math.round((Date.now() - sharedLive.lastUsed) / 1000)
        console.log(`shared: pid ${sharedLive.pid} port ${sharedLive.port} ${sharedLive.model} (idle ${idle} s)`)
      }
      for (const r of running) if (!sharedLive || r.pid !== sharedLive.pid) console.log(`running: pid ${r.pid} port ${r.port} ${r.model}`)
      return 0
    }
    case 'start': {
      const config = await loadConfig()
      const model = await resolveModel(values.model)
      const engine = await requireEngine(config)
      const pairs = parseConfigPairs(values.config)
      const loadOpts = loadOptionsFrom(pairs, {
        ctxSize: config.ctxSize ?? DEFAULT_CTX_SIZE,
        ...(model.mmprojPath ? { mmprojPath: model.mmprojPath } : {}),
      })
      const handle = await acquireEngine({
        mode: 'shared',
        command: engineCommand(engine.binary),
        args: launchArgs(model.path, null, loadOpts),
        model: model.id,
        log: (m) => console.error(m),
        onStatus: (state) => console.error(`[engine] ${state}`),
      })
      console.log(`${handle.started ? 'started' : 'reused'} shared engine on port ${handle.port} (${model.id})`)
      return 0
    }
    case 'stop': {
      let stopped = 0
      if (await stopShared()) stopped++
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
