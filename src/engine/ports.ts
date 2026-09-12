/**
 * Pick a loopback port for a llama-server.
 *
 * obrew-engine reserved 8082–8095; the same range is tried first so log lines and firewall
 * rules written for it keep making sense, then the OS is asked for any free port. A port is
 * proven free by binding it, which is the only test that cannot lie.
 */
import { createServer } from 'node:net'

const PREFERRED_RANGE: [number, number] = [8082, 8095]

function tryBind(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(null))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : null
      server.close(() => resolve(bound))
    })
  })
}

export async function freePort(range: [number, number] = PREFERRED_RANGE): Promise<number> {
  for (let port = range[0]; port <= range[1]; port++) {
    const bound = await tryBind(port)
    if (bound !== null) return bound
  }
  const any = await tryBind(0)
  if (any === null) throw new Error('no free loopback port')
  return any
}
