/** The fake MCP server over stdio: NDJSON in on stdin, NDJSON out on stdout. */
import { readLines } from '../../src/shared/ndjson'
import { dispatch, type Rpc } from './fake-mcp'

process.stderr.write('fake mcp stdio: up\n')
for await (const line of readLines(Bun.stdin.stream())) {
  let msg: Rpc | Rpc[]
  try {
    msg = JSON.parse(line)
  } catch {
    continue
  }
  const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map(dispatch))).filter((r) => r !== null)
  for (const r of replies) process.stdout.write(JSON.stringify(r) + '\n')
}
