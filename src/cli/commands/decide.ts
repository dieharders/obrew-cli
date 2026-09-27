/**
 * `obrew decide install|status|stop|classify|extract`
 *
 * Typed decisions from GLiNER2.5-Decide, in a warm sidecar (../../decide/sidecar.ts).
 * `classify` and `extract` read ONE JSON request on stdin and print ONE JSON line: the host
 * builds the request from its own enums, so nothing about them is on the command line.
 *
 *   classify  {"texts": ["…"], "tasks": {"theme": {"future": "desc", …}, "gender": ["male", "female"]}}
 *             → {"results": [{"theme": {"label": "future", "confidence": 0.71}, …}], "ms": 425, "started": false}
 *   extract   {"texts": ["…"], "structures": {"deck": ["title::str::the deck title", …]}}
 *             → {"results": [{"deck": [{"title": …}]}], "ms": 560, "started": false}
 *
 * `tasks` and `structures` are GLiNER2's own shapes, passed through. `started: true` means
 * this call paid the model load (4–8 s on CPU); the host should expect that once per session.
 */
import { track, untrack } from '../../shared/proc'
import { ObrewError, UsageError } from '../../shared/errors'
import { acquireSidecar, callSidecar, decideLogPath, installDecide, readInstalled, readSidecar, stopSidecar, type DecideOp } from '../../decide/sidecar'
import { isAlive } from '../../engine/running'
import { asInt, parse } from '../args'
import { createOutput } from '../output'

const HELP = `obrew decide install [--model <repo>] [--json]   build the Python venv and download the model (once)
obrew decide status [--json]                      what is installed and whether the sidecar is warm
obrew decide stop                                 stop the warm sidecar
obrew decide classify [--idle-ms N] < request.json   typed picks; see the header of decide.ts
obrew decide extract [--idle-ms N] < request.json    field values as spans

The sidecar starts on the first classify/extract and exits by itself after --idle-ms
(default 3600000) without a request. Its log is ${decideLogPath()}.`

export async function runDecide(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    model: { type: 'string' },
    'idle-ms': { type: 'string' },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }

  switch (positionals[0]) {
    case 'install': {
      const out = createOutput(values.json)
      const result = await installDecide({
        ...(values.model ? { model: values.model } : {}),
        onStep: (message) => out.event({ type: 'setup.log', message }),
      })
      out.event({ type: 'setup.done', ok: true, message: `${result.model} (python ${result.python})` })
      return 0
    }
    case 'status': {
      const installed = await readInstalled()
      const record = await readSidecar()
      const running = record && isAlive(record.pid) ? record : null
      if (values.json) console.log(JSON.stringify({ installed, running }))
      else {
        console.log(installed ? `installed: ${installed.model} (python ${installed.python})` : 'not installed — run `obrew decide install`')
        console.log(running ? `running: pid ${running.pid} on port ${running.port}` : 'not running')
      }
      return 0
    }
    case 'stop': {
      const stopped = await stopSidecar()
      console.log(stopped ? 'stopped the decision sidecar' : 'no decision sidecar was running')
      return 0
    }
    case 'classify':
    case 'extract':
      return await runRequest(positionals[0], values['idle-ms'] ? asInt(values['idle-ms'], '--idle-ms') : undefined, values.model)
    default:
      throw new UsageError(`decide needs a subcommand\n\n${HELP}`)
  }
}

async function runRequest(op: DecideOp, idleMs: number | undefined, model: string | undefined): Promise<number> {
  const raw = await Bun.stdin.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (err) {
    throw new UsageError(`decide ${op} reads one JSON request on stdin: ${(err as Error).message}`)
  }
  const controller = new AbortController()
  track(controller)
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  try {
    const sidecar = await acquireSidecar({ ...(model ? { model } : {}), ...(idleMs ? { idleMs } : {}), signal: controller.signal })
    const result = (await callSidecar(sidecar.port, op, body, controller.signal)) as Record<string, unknown>
    console.log(JSON.stringify({ ...result, started: sidecar.started }))
    return 0
  } catch (err) {
    // One JSON line either way, so a host parses stdout without guessing: the same code
    // vocabulary as `exec`'s turn.failed, and exit 1.
    if (err instanceof ObrewError) {
      console.log(JSON.stringify({ error: { code: err.code, message: err.message } }))
      return 1
    }
    throw err
  } finally {
    process.off('SIGINT', onSignal)
    untrack(controller)
  }
}
