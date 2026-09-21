/**
 * `obrew auth status [--json]`
 *
 * There is no account: "signed in" means the engine is installed and a default model is
 * present. A host maps `ready:false` to its signed-out state, whose fix is `obrew login`.
 * Exit code is 0 either way; the answer is the status, not the exit.
 */
import { engineStatus } from '../../engine/install'
import { defaultModel, loadRegistry } from '../../models/registry'
import { toolModelStatus, type ToolModelStatus } from '../../needle/resolve'
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
   */
  /**
   * `tool` is the model that structures what `default` writes (needle/structure.ts). It is never
   * part of `ready`: a run without it is a whole run, decoded under a grammar as before.
   */
  model: { default: string; chosen: string | null; installed: boolean; tool: ToolModelStatus }
  dataDir: string
}

export async function authStatus(): Promise<AuthStatus> {
  const config = await loadConfig()
  const engine = await engineStatus(config)
  const model = await defaultModel(await loadRegistry())
  const tool = await toolModelStatus(config)
  return {
    ready: engine.installed && model.installed,
    engine: { installed: engine.installed, tag: engine.tag, variant: engine.variant },
    model: { default: model.id, chosen: model.chosen, installed: model.installed, tool },
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
    const tool = status.model.tool
    console.log(`tools:  ${tool.id}${tool.id === 'none' || tool.installed ? '' : ' (not installed)'}`)
    console.log(`data:   ${status.dataDir}`)
    if (!status.ready) console.log('run `obrew login` to install what is missing')
  }
  return 0
}
