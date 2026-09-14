/**
 * `obrew login [--model <repo[:file]>] [--variant …] [--json]`
 *
 * Idempotent setup: install the engine if it is missing, then make sure the built-in default
 * model (or the one named) is on disk and make it the default. It is downloaded when missing
 * or not the same file, whatever other models are installed or chosen; that one model is all
 * login downloads. This is what a host's "Sign in" button runs, in a real terminal so the
 * progress is visible.
 */
import { pullModel } from '../../models/pull'
import { setDefault } from '../../models/registry'
import { findEngine, installEngine } from '../../engine/install'
import { DEFAULT_LOGIN_MODEL, hfToken, loadConfig, VARIANTS } from '../../shared/config'
import { track, untrack } from '../../shared/proc'
import { oneOf, parse } from '../args'
import { createOutput } from '../output'

export async function runLogin(argv: string[]): Promise<number> {
  const { values } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    model: { type: 'string' },
    variant: { type: 'string' },
    mmproj: { type: 'boolean', default: false },
  } as const)
  if (values.help) {
    console.log('obrew login [--model <repo[:file]>] [--mmproj] [--variant cuda|cpu|vulkan|metal] [--json]')
    return 0
  }
  const out = createOutput(values.json)
  const controller = new AbortController()
  track(controller)
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const log = (message: string) => out.event({ type: 'setup.log', message })

  try {
    const config = await loadConfig()
    const variant = values.variant ? oneOf(values.variant, VARIANTS, '--variant') : undefined

    let engine = await findEngine(config)
    if (!engine || (variant && engine.variant !== variant)) {
      engine = await installEngine({
        variant,
        signal: controller.signal,
        onLog: log,
        onProgress: (file, received, total) => out.event({ type: 'download.progress', file, received, total }),
      })
    } else {
      log(`engine ready (${engine.tag}, ${engine.variant})`)
    }

    // No condition on what else is installed or chosen: the model is fetched whenever this
    // machine does not have it on disk as downloaded, and pullModel fetches nothing when it does.
    const entry = await pullModel({
      spec: values.model ?? DEFAULT_LOGIN_MODEL,
      mmproj: values.mmproj,
      token: hfToken(config),
      signal: controller.signal,
      onLog: log,
      onProgress: (file, received, total) => out.event({ type: 'download.progress', file, received, total }),
    })
    await setDefault(entry.id)
    log(`default model: ${entry.id}`)

    out.event({ type: 'setup.done', ok: true, message: 'obrew is ready' })
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    out.event({ type: 'setup.done', ok: false, message })
    return 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    untrack(controller)
  }
}
