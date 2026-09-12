/**
 * Streamable HTTP transport: every message is a POST to one URL.
 *
 * A server may answer a request with `application/json` (one response, or a batch) or with
 * `text/event-stream` (the response arrives as an SSE `data:` line, possibly after other
 * messages); both are handled. Notifications get 202 and no body. A server that assigns an
 * `mcp-session-id` on initialize gets it back on every later request, and the negotiated
 * protocol version rides in `mcp-protocol-version` as the newer revisions ask.
 */
import { parseSseJson } from '../engine/sse-parse'
import { matchResponse, McpError, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse, type Transport } from './types'

export class HttpTransport implements Transport {
  private sessionId: string | null = null
  protocolVersion: string | null = null

  constructor(
    private readonly server: string,
    private readonly url: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    }
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response
    try {
      res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal })
    } catch (err) {
      throw new McpError(this.server, `cannot reach ${this.url}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    return res
  }

  async send(msg: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const res = await this.post(msg, signal)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new McpError(this.server, `HTTP ${res.status} on ${msg.method}${text ? `: ${text.slice(0, 300)}` : ''}`)
    }
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) {
      if (!res.body) throw new McpError(this.server, `empty stream on ${msg.method}`)
      for await (const item of parseSseJson<unknown>(res.body)) {
        const reply = matchResponse(item, msg.id)
        if (reply) return reply
      }
      throw new McpError(this.server, `stream ended without a reply to ${msg.method}`)
    }
    const body = (await res.json().catch(() => null)) as unknown
    const reply = matchResponse(body, msg.id)
    if (!reply) throw new McpError(this.server, `no reply to ${msg.method} (id ${msg.id})`)
    return reply
  }

  async notify(msg: JsonRpcNotification): Promise<void> {
    const res = await this.post(msg)
    await res.body?.cancel().catch(() => {})
    if (!res.ok && res.status !== 202) throw new McpError(this.server, `HTTP ${res.status} on ${msg.method}`)
  }

  async close(): Promise<void> {
    if (!this.sessionId) return
    // Newer servers accept DELETE to end the session; older ones 404/405 it. Either is fine.
    await fetch(this.url, { method: 'DELETE', headers: this.headers() }).then((r) => r.body?.cancel()).catch(() => {})
  }
}
