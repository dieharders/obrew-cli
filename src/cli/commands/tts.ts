/**
 * `obrew tts "<text>"` — speak a line to a WAV file, or stream raw PCM to stdout.
 *
 * Prefers a running `obrew serve` (its engine is already warm) and otherwise starts a
 * tts-server of its own for the one request. `--pcm` writes s16le 24 kHz mono to stdout as it
 * is generated, for piping into a player or another process; nothing else ever touches
 * stdout in that mode.
 */
import { writeFile } from 'node:fs/promises'
import { ObrewError, UsageError } from '../../shared/errors'
import { track, untrack } from '../../shared/proc'
import { speech, SpeechRequestSchema } from '../../tts/client'
import { TtsEngine } from '../../tts/engine'
import { parse } from '../args'

const HELP = `obrew tts [--voice <name>] [--lang <language>] [--pack <id>] [--out speech.wav | --pcm] [--server <url>] "<text>"
  --voice    a speaker of the pack (ryan, vivian, serena, aiden, eric, dylan, uncle_fu, ono_anna, sohee) or a registered clone
  --lang     language name or code; default: the model decides
  --pack     a voice pack id; default: \`obrew voices use\`
  --out      write a WAV file (default speech.wav)
  --pcm      stream raw s16le 24 kHz mono PCM to stdout instead
  --server   an \`obrew serve\` to use (default http://127.0.0.1:8008 when it is running)
Text is the last argument, or stdin when omitted.`

async function readStdin(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(new TextDecoder().decode(chunk))
  return chunks.join('')
}

async function serveReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

export async function runTts(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    help: { type: 'boolean', short: 'h', default: false },
    voice: { type: 'string' },
    lang: { type: 'string' },
    pack: { type: 'string' },
    out: { type: 'string' },
    pcm: { type: 'boolean', default: false },
    server: { type: 'string' },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const text = (positionals.join(' ') || (await readStdin())).trim()
  if (!text) throw new UsageError('tts needs text to speak\n\n' + HELP)
  if (values.pcm && values.out) throw new UsageError('--pcm and --out are exclusive')

  const req = SpeechRequestSchema.parse({
    input: text,
    model: values.pack,
    voice: values.voice,
    language: values.lang,
    response_format: values.pcm ? 'pcm' : 'wav',
  })

  const controller = new AbortController()
  track(controller)
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)

  const serveUrl = (values.server ?? 'http://127.0.0.1:8008').replace(/\/$/, '')
  let engine: TtsEngine | null = null
  try {
    let baseUrl: string
    if (await serveReachable(serveUrl)) {
      console.error(`[tts] using obrew serve at ${serveUrl}`)
      baseUrl = serveUrl
    } else {
      if (values.server) throw new ObrewError('engine_failed', `no obrew serve answers at ${serveUrl}`)
      engine = new TtsEngine({ log: (m) => console.error(`[tts] ${m}`) })
      const { server } = await engine.ensure(values.pack, controller.signal)
      baseUrl = server.baseUrl
    }

    const started = Date.now()
    const res = await speech(baseUrl, req, controller.signal)
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      throw new ObrewError('engine_failed', `speech failed: HTTP ${res.status} ${body.slice(0, 300)}`)
    }

    if (values.pcm) {
      let bytes = 0
      let first: number | null = null
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        first ??= Date.now()
        bytes += chunk.byteLength
        process.stdout.write(chunk)
      }
      console.error(`[tts] ${bytes} bytes, first audio after ${first ? first - started : 0} ms, ${Date.now() - started} ms total`)
      return 0
    }

    const wav = new Uint8Array(await res.arrayBuffer())
    const out = values.out ?? 'speech.wav'
    await writeFile(out, wav)
    console.error(`[tts] wrote ${out} (${wav.byteLength} bytes) in ${Date.now() - started} ms`)
    console.log(out)
    return 0
  } finally {
    process.off('SIGINT', onSignal)
    untrack(controller)
    await engine?.stop()
  }
}
