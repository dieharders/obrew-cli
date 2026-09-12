/**
 * `--mcp-server name=<url>` or `--mcp-server name=stdio:<command …>`.
 *
 * One flag per server, per invocation, nothing written to any global config: the host
 * hands obrew a loopback URL for one job and it is gone when the process is.
 */
import { UsageError } from '../shared/errors'
import type { McpServerSpec } from './types'

const NAME = /^[A-Za-z0-9_-]{1,32}$/

export function parseMcpServerSpec(input: string): McpServerSpec {
  const eq = input.indexOf('=')
  if (eq <= 0) throw new UsageError(`--mcp-server expects name=<url> or name=stdio:<command>, got "${input}"`)
  const name = input.slice(0, eq).trim()
  const value = input.slice(eq + 1).trim()
  if (!NAME.test(name)) throw new UsageError(`--mcp-server name "${name}" must be [A-Za-z0-9_-]{1,32}`)

  if (/^https?:\/\//i.test(value)) return { name, transport: 'http', url: value }
  if (value.startsWith('stdio:')) {
    const command = value.slice('stdio:'.length).trim().split(/\s+/).filter(Boolean)
    if (command.length === 0) throw new UsageError(`--mcp-server ${name}: stdio: needs a command`)
    return { name, transport: 'stdio', command }
  }
  throw new UsageError(`--mcp-server ${name}: expected an http(s) URL or stdio:<command>, got "${value}"`)
}
