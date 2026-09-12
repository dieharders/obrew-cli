/**
 * `obrew serve [--host 127.0.0.1] [--port 8008] [--model <id>] [--idle-ttl <seconds>]`
 */
import { DEFAULT_IDLE_TTL_MS } from '../../engine/shared'
import { ObrewServer } from '../../serve/server'
import { track, untrack } from '../../shared/proc'
import { asInt, parse } from '../args'

export async function runServe(argv: string[]): Promise<number> {
  const { values } = parse(argv, {
    help: { type: 'boolean', short: 'h', default: false },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8008' },
    model: { type: 'string' },
    'idle-ttl': { type: 'string' },
  } as const)
  if (values.help) {
    console.log('obrew serve [--host 127.0.0.1] [--port 8008] [--model <id>] [--idle-ttl <seconds>]')
    return 0
  }
  const server = new ObrewServer({
    host: values.host,
    port: asInt(values.port, '--port'),
    model: values.model,
    idleTtlMs: values['idle-ttl'] ? asInt(values['idle-ttl'], '--idle-ttl') * 1000 : DEFAULT_IDLE_TTL_MS,
    log: (m) => console.error(`[serve] ${m}`),
  })
  const controller = new AbortController()
  track(controller)
  await server.start()
  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    controller.signal.addEventListener('abort', stop, { once: true })
  })
  await server.stop()
  untrack(controller)
  console.error('[serve] stopped (the shared engine stays warm; `obrew engine stop` ends it)')
  return 0
}
