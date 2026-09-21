/**
 * `obrew login [--model <repo[:file]>] [--variant …] [--json]`
 *
 * Idempotent setup: install the engine if it is missing, then make sure the default model (or
 * the one named) is on disk and make it the default. The default is whichever model the user or
 * a host chose, and the built-in one on a fresh install, so a choice survives the next login
 * rather than being replaced by the built-in model. It is downloaded when missing or not the
 * same file; that one model is all login downloads — beside the 36 MB tool model (needle/),
 * whose failure to install is reported and is never a failed login: a run without it still
 * runs. This is what a host's "Sign in" button runs, in a real terminal so the progress is
 * visible.
 */
import { pullModel } from '../../models/pull'
import { defaultModelId, loadRegistry } from '../../models/registry'
import { findEngine, installEngine } from '../../engine/install'
import { installNeedle } from '../../needle/install'
import { resolveToolModel } from '../../needle/resolve'
import { hfToken, loadConfig, VARIANTS } from '../../shared/config'
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

    // The model is fetched whenever this machine does not have it on disk as downloaded, and
    // pullModel fetches nothing when it does. No other model is looked at. `makeDefault` is
    // applied in the same registry write as the install, so a pull running against `obrew
    // serve` at that moment cannot be lost between the two.
    const entry = await pullModel({
      spec: values.model ?? defaultModelId(await loadRegistry()),
      mmproj: values.mmproj,
      makeDefault: true,
      token: hfToken(config),
      signal: controller.signal,
      onLog: log,
      onProgress: (file, received, total) => out.event({ type: 'download.progress', file, received, total }),
    })
    log(`default model: ${entry.id}`)

    if ((await resolveToolModel(undefined, config)).id !== 'none') {
      try {
        await installNeedle({
          token: hfToken(config),
          signal: controller.signal,
          onLog: log,
          onProgress: (file, received, total) => out.event({ type: 'download.progress', file, received, total }),
        })
      } catch (err) {
        if (controller.signal.aborted) throw err
        log(`tool model not installed (${err instanceof Error ? err.message : String(err)}); runs will use the default model alone`)
      }
    }

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
