/**
 * `obrew auth status [--json]`
 *
 * There is no account: "signed in" means the engine is installed and a default model is
 * present. A host maps `ready:false` to its signed-out state, whose fix is `obrew login`.
 * Exit code is 0 either way; the answer is the status, not the exit.
 */
import { engineStatus } from '../../engine/install'
import { defaultModel, findModel, loadRegistry, projectorPath } from '../../models/registry'
import { loadConfig } from '../../shared/config'
import { UsageError } from '../../shared/errors'
import { dataDir } from '../../shared/paths'
import { parse } from '../args'

export interface AuthStatus {
  ready: boolean
  engine: { installed: boolean; tag: string; variant: string }
  /**
   * `default` is the model an `exec` would run and is never null, so it is NOT the signed-out
   * signal: read `ready` for that, or `installed` for the model alone. `chosen` is null until
   * `obrew models use` or `obrew login` picks one, which is what `default` used to mean.
   * `vision` is whether that model's projector is on disk, i.e. whether `exec --image` will
   * attach anything; `visionPublished` is whether its repo offered one at the last pull, null
   * when that was never checked. Neither is part of `ready`.
   */
  model: { default: string; chosen: string | null; installed: boolean; vision: boolean; visionPublished: boolean | null }
  dataDir: string
}

export async function authStatus(): Promise<AuthStatus> {
  const config = await loadConfig()
  const engine = await engineStatus(config)
  const registry = await loadRegistry()
  const model = await defaultModel(registry)
  const entry = findModel(registry, model.id)
  return {
    ready: engine.installed && model.installed,
    engine: { installed: engine.installed, tag: engine.tag, variant: engine.variant },
    model: {
      default: model.id,
      chosen: model.chosen,
      installed: model.installed,
      vision: !!entry && (await projectorPath(entry)) !== null,
      visionPublished: entry?.mmprojPublished ?? null,
    },
    dataDir: dataDir(),
  }
}

export async function runAuth(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } as const)
  if (values.help || positionals[0] !== 'status') {
    if (values.help) {
      console.log('obrew auth status [--json]')
      return 0
    }
    throw new UsageError('auth: expected `status`')
  }
  const status = await authStatus()
  if (values.json) {
    console.log(JSON.stringify(status))
  } else {
    console.log(status.ready ? 'ready' : 'not ready')
    console.log(`engine: ${status.engine.installed ? `installed (${status.engine.tag}, ${status.engine.variant})` : 'missing'}`)
    console.log(`model:  ${status.model.default}${status.model.installed ? '' : ' (not installed)'}`)
    console.log(`vision: ${status.model.vision ? 'yes' : status.model.visionPublished === false ? 'no (text-only model)' : 'no'}`)
    console.log(`data:   ${status.dataDir}`)
    if (!status.ready) console.log('run `obrew login` to install what is missing')
  }
  return 0
}
