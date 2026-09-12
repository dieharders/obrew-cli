/**
 * An MCP client that turns a server's tools into obrew `Tool`s.
 *
 * Tools are registered as `mcp__<server>__<tool>` — the same prefix scheme the Claude and
 * Codex CLIs use, which is what lets a host pre-approve `mcp__motionbuff__*` for all three.
 * A call that the server reports as `isError: true` becomes an error RESULT for the model to
 * read and adjust to; only a transport failure or a JSON-RPC error is thrown.
 */
import pkg from '../../package.json' with { type: 'json' }
import type { JsonSchema, Tool } from '../agent/tools/types'
import { HttpTransport } from './http'
import { StdioTransport } from './stdio'
import {
  McpError,
  type JsonRpcResponse,
  type McpCallResult,
  type McpContent,
  type McpServerSpec,
  type McpToolInfo,
  type Transport,
} from './types'

/** The newest revision obrew understands; a server may answer with an older one. */
export const CLIENT_PROTOCOL_VERSION = '2025-03-26'
const REQUEST_TIMEOUT_MS = 30_000
/** Tools on a host app can drive a renderer or synthesise audio; give them room. */
export const MCP_TOOL_TIMEOUT_MS = 300_000

export interface ConnectOptions {
  signal?: AbortSignal
  cwd?: string
  log?: (message: string) => void
}

/** Text the model sees for a tool result: text parts joined, anything else as JSON. */
export function contentToText(result: McpCallResult): string {
  const parts = result.content ?? []
  const text = parts
    .map((p: McpContent) => (p.type === 'text' && typeof p.text === 'string' ? p.text : JSON.stringify(p)))
    .join('\n')
  if (text) return text
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return ''
}

export class McpClient {
  private nextId = 1
  serverInfo: { name?: string; version?: string } = {}
  protocolVersion = CLIENT_PROTOCOL_VERSION

  private constructor(
    readonly name: string,
    private readonly transport: Transport,
  ) {}

  static async connect(spec: McpServerSpec, opts: ConnectOptions = {}): Promise<McpClient> {
    const transport =
      spec.transport === 'http'
        ? new HttpTransport(spec.name, spec.url)
        : StdioTransport.spawn(spec.name, spec.command, { cwd: opts.cwd })
    const client = new McpClient(spec.name, transport)
    try {
      const init = (await client.request(
        'initialize',
        {
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'obrew', version: pkg.version },
        },
        opts.signal,
      )) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } }
      if (typeof init?.protocolVersion === 'string') client.protocolVersion = init.protocolVersion
      if (transport instanceof HttpTransport) transport.protocolVersion = client.protocolVersion
      client.serverInfo = init?.serverInfo ?? {}
      await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      opts.log?.(`mcp ${spec.name}: connected (${client.serverInfo.name ?? 'unnamed'} ${client.serverInfo.version ?? ''}, protocol ${client.protocolVersion})`)
      return client
    } catch (err) {
      await transport.close().catch(() => {})
      throw err
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let reply: JsonRpcResponse
    try {
      reply = await this.transport.send({ jsonrpc: '2.0', id, method, params }, combined)
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) throw new McpError(this.name, `${method} timed out after ${timeoutMs} ms`)
      throw err
    }
    if (reply.error) throw new McpError(this.name, `${method} failed: ${reply.error.message} (${reply.error.code})`)
    return reply.result
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const page = (await this.request('tools/list', cursor ? { cursor } : {}, signal)) as {
        tools?: McpToolInfo[]
        nextCursor?: string
      }
      out.push(...(page?.tools ?? []))
      cursor = page?.nextCursor
    } while (cursor)
    return out
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return (await this.request('tools/call', { name, arguments: args }, signal, MCP_TOOL_TIMEOUT_MS)) as McpCallResult
  }

  /** The server's tools as obrew tools, namespaced. */
  async tools(signal?: AbortSignal): Promise<Tool[]> {
    const infos = await this.listTools(signal)
    return infos.map((info) => {
      const schema: JsonSchema =
        info.inputSchema && typeof info.inputSchema === 'object' ? info.inputSchema : { type: 'object', properties: {} }
      return {
        name: `mcp__${this.name}__${info.name}`,
        description: info.description ?? `${info.name} on ${this.name}`,
        inputSchema: schema,
        timeoutMs: MCP_TOOL_TIMEOUT_MS,
        execute: async (callArgs, ctx) => {
          const result = await this.callTool(info.name, callArgs, ctx.signal)
          return { content: contentToText(result), isError: result.isError === true }
        },
      }
    })
  }

  async close(): Promise<void> {
    await this.transport.close()
  }
}
