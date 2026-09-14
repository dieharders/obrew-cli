/**
 * `obrew models list|pull|rm|use`
 */
import { pullModel } from '../../models/pull'
import { findModel, loadRegistry, removeModel, setDefault } from '../../models/registry'
import { DEFAULT_LOGIN_MODEL, hfToken, loadConfig, saveConfig } from '../../shared/config'
import { humanBytes } from '../../shared/download'
import { ObrewError, UsageError } from '../../shared/errors'
import { track, untrack } from '../../shared/proc'
import { parse } from '../args'
import { createOutput } from '../output'

const HELP = `obrew models list [--json]
obrew models pull <org/repo[:file.gguf]> [--mmproj] [--mmproj-file <name>] [--json]
obrew models rm <id>
obrew models use <id>            make it the default chat model
obrew models use --embed <id>    make it the embedding model`

export async function runModels(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    mmproj: { type: 'boolean', default: false },
    'mmproj-file': { type: 'string' },
    embed: { type: 'boolean', default: false },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const [sub, arg] = positionals

  switch (sub) {
    case 'list': {
      const registry = await loadRegistry()
      if (values.json) {
        console.log(JSON.stringify(registry))
        return 0
      }
      if (registry.models.length === 0) {
        console.log(`no models installed; try \`obrew models pull ${DEFAULT_LOGIN_MODEL}\``)
        return 0
      }
      for (const m of registry.models) {
        const mark = m.id === registry.default ? '*' : ' '
        console.log(`${mark} ${m.id}  ${humanBytes(m.sizeBytes)}${m.mmprojPath ? '  +mmproj' : ''}`)
      }
      return 0
    }
    case 'pull': {
      if (!arg) throw new UsageError('pull needs org/repo[:file]')
      const out = createOutput(values.json)
      const controller = new AbortController()
      track(controller)
      const onSignal = () => controller.abort()
      process.once('SIGINT', onSignal)
      try {
        const config = await loadConfig()
        const entry = await pullModel({
          spec: arg,
          mmproj: values['mmproj-file'] ?? values.mmproj,
          token: hfToken(config),
          signal: controller.signal,
          onLog: (message) => out.event({ type: 'setup.log', message }),
          onProgress: (file, received, total) => out.event({ type: 'download.progress', file, received, total }),
        })
        out.event({ type: 'download.done', file: entry.file, path: entry.path })
        return 0
      } finally {
        process.off('SIGINT', onSignal)
        untrack(controller)
      }
    }
    case 'rm': {
      if (!arg) throw new UsageError('rm needs a model id')
      const entry = await removeModel(arg)
      console.log(`removed ${entry.id}`)
      return 0
    }
    case 'use': {
      if (!arg) throw new UsageError('use needs a model id')
      if (values.embed) {
        const registry = await loadRegistry()
        const entry = findModel(registry, arg)
        if (!entry) throw new ObrewError('model_missing', `no installed model matches "${arg}"`)
        await saveConfig({ ...(await loadConfig()), embedModel: entry.id })
        console.log(`embedding model: ${entry.id}`)
        return 0
      }
      const entry = await setDefault(arg)
      console.log(`default model: ${entry.id}`)
      return 0
    }
    default:
      throw new UsageError(`models: unknown subcommand "${sub ?? ''}"\n\n${HELP}`)
  }
}
