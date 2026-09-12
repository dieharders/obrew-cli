/**
 * A tools-only MCP server for tests, in the shape of motionbuff's `server/mcp.ts`: JSON-RPC
 * 2.0, `initialize` / `tools/list` / `tools/call`, 202 for notifications, batches. Serves
 * over HTTP (in-process, `startFakeMcp`) or stdio (`fake-mcp-stdio.ts` imports `dispatch`).
 *
 * Tools: `echo {text}` → the text; `fail {}` → isError; `slow {ms}` → sleeps; `add {a,b}`.
 */
export interface Rpc {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: unknown
}

export const PROTOCOL = '2024-11-05'

export const TOOLS = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Sleeps', inputSchema: { type: 'object', properties: { ms: { type: 'integer' } }, required: ['ms'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
]

export const calls: Array<{ name: string; args: unknown }> = []

export async function dispatch(msg: Rpc): Promise<object | null> {
  const { id, method } = msg
  if (id === undefined) return null
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fake', version: '1' } })
    case 'tools/list':
      return ok({ tools: TOOLS })
    case 'tools/call': {
      const { name, arguments: args } = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
      calls.push({ name: name ?? '', args })
      switch (name) {
        case 'echo':
          return ok({ content: [{ type: 'text', text: String(args?.text ?? '') }], isError: false })
        case 'fail':
          return ok({ content: [{ type: 'text', text: 'DENIED: nope' }], isError: true })
        case 'slow':
          await Bun.sleep(Number(args?.ms ?? 0))
          return ok({ content: [{ type: 'text', text: 'done' }] })
        case 'add':
          return ok({ content: [{ type: 'text', text: String(Number(args?.a) + Number(args?.b)) }] })
        default:
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } }
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

export interface FakeMcp {
  url: string
  stop(): void
}

/** In-process HTTP server. `sse: true` answers every request as an SSE stream instead of JSON. */
export function startFakeMcp(opts: { sse?: boolean; sessionId?: string } = {}): FakeMcp {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/mcp') return new Response('not found', { status: 404 })
      if (req.method === 'DELETE') return new Response(null, { status: 204 })
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const body = (await req.json()) as Rpc | Rpc[]
      const headers: Record<string, string> = opts.sessionId ? { 'mcp-session-id': opts.sessionId } : {}
      const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map(dispatch))).filter((r): r is object => r !== null)
      if (replies.length === 0) return new Response(null, { status: 202, headers })
      const payload = Array.isArray(body) ? replies : replies[0]
      if (opts.sse) {
        const text = `: hello\n\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\ndata: ${JSON.stringify(payload)}\n\n`
        return new Response(text, { headers: { ...headers, 'content-type': 'text/event-stream' } })
      }
      return Response.json(payload, { headers })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) }
}
