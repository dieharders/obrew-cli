/**
 * `obrew transcribe <audio file>` — speech to text with the installed ASR model.
 */
import { ObrewError, UsageError } from '../../shared/errors'
import { track, untrack } from '../../shared/proc'
import { transcribeWav } from '../../stt/client'
import { AsrEngine } from '../../stt/engine'
import { parse } from '../args'

const HELP = `obrew transcribe [--lang <language>] [--json] <file.wav|mp3|flac>
  Prints the transcript. --json prints {"text","language"}.`

export async function runTranscribe(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    help: { type: 'boolean', short: 'h', default: false },
    json: { type: 'boolean', default: false },
    lang: { type: 'string' },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const path = positionals[0]
  if (!path) throw new UsageError('transcribe needs an audio file\n\n' + HELP)
  const file = Bun.file(path)
  if (!(await file.exists())) throw new ObrewError('bad_request', `file not found: ${path}`)

  const controller = new AbortController()
  track(controller)
  const engine = new AsrEngine((m) => console.error(`[asr] ${m}`))
  try {
    const { server } = await engine.ensure(controller.signal)
    const started = Date.now()
    const result = await transcribeWav(server.baseUrl, new Uint8Array(await file.arrayBuffer()), { language: values.lang, signal: controller.signal })
    console.error(`[asr] ${Date.now() - started} ms`)
    console.log(values.json ? JSON.stringify(result) : result.text)
    return 0
  } finally {
    untrack(controller)
    await engine.stop()
  }
}
