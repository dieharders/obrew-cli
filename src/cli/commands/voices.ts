/**
 * `obrew voices list|pull|use|rm` — the voice packs `obrew tts` and `serve` speak with.
 */
import { hfToken, loadConfig } from '../../shared/config'
import { UsageError } from '../../shared/errors'
import { track, untrack } from '../../shared/proc'
import { DEFAULT_PACK, VOICE_PACKS, activePack, isPackInstalled, pullPack, removePack, usePack } from '../../tts/packs'
import { parse } from '../args'
import { createOutput } from '../output'

const HELP = `obrew voices list [--json]
obrew voices pull <pack-id> [--json]     download a voice pack (the default: ${DEFAULT_PACK})
obrew voices use <pack-id>               make it the pack \`tts\` and \`serve\` speak with
obrew voices rm <pack-id>`

export async function runVoices(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const [sub, arg] = positionals

  switch (sub) {
    case 'list': {
      const config = await loadConfig()
      const active = await activePack(config).catch(() => null)
      const rows = []
      for (const pack of VOICE_PACKS) {
        rows.push({ ...pack, installed: await isPackInstalled(pack), active: active?.id === pack.id })
      }
      if (values.json) {
        console.log(JSON.stringify({ packs: rows, active: active?.id ?? null, chosen: config.ttsPack ?? null }))
        return 0
      }
      for (const r of rows) {
        const mark = r.active ? '*' : ' '
        console.log(`${mark} ${r.id.padEnd(30)} ${r.installed ? 'installed' : '         '}  ${r.label}`)
        console.log(`  ${' '.repeat(30)} ${r.description}${r.speakers.length ? `  voices: ${r.speakers.join(', ')}` : ''}`)
      }
      if (!active) console.log(`\nno pack installed — run \`obrew voices pull ${DEFAULT_PACK}\``)
      return 0
    }
    case 'pull': {
      if (!arg) throw new UsageError(`pull needs a pack id (try ${DEFAULT_PACK})`)
      const out = createOutput(values.json)
      const controller = new AbortController()
      track(controller)
      const onSignal = () => controller.abort()
      process.once('SIGINT', onSignal)
      try {
        const config = await loadConfig()
        const pack = await pullPack(arg, {
          token: hfToken(config),
          signal: controller.signal,
          onLog: (message) => out.event({ type: 'setup.log', message }),
          onProgress: (file, received, total) => out.event({ type: 'download.progress', file, received, total }),
        })
        out.event({ type: 'setup.done', ok: true, message: pack.id })
        return 0
      } finally {
        process.off('SIGINT', onSignal)
        untrack(controller)
      }
    }
    case 'use': {
      if (!arg) throw new UsageError('use needs a pack id')
      const pack = await usePack(arg)
      console.log(`voice pack: ${pack.id}`)
      return 0
    }
    case 'rm': {
      if (!arg) throw new UsageError('rm needs a pack id')
      const pack = await removePack(arg)
      console.log(`removed ${pack.id}`)
      return 0
    }
    default:
      throw new UsageError(`voices: unknown subcommand "${sub ?? ''}"\n\n${HELP}`)
  }
}
