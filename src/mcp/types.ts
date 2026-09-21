/**
 * The slice of MCP obrew speaks as a CLIENT: JSON-RPC 2.0 over a transport, plus the three
 * tool methods (`initialize`, `tools/list`, `tools/call`) and the `notifications/initialized`
 * that follows the handshake. Resources, prompts and sampling are not consumed.
 */
import type { JsonSchema } from '../agent/tools/types'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: JsonSchema
  /** MCP tool annotations; only `readOnlyHint` is read (see `Tool.readOnly`). */
  annotations?: { readOnlyHint?: boolean }
}

export interface McpContent {
  type: string
  text?: string
  [key: string]: unknown
}

export interface McpCallResult {
  content?: McpContent[]
  structuredContent?: unknown
  isError?: boolean
}

export type McpServerSpec =
  | { name: string; transport: 'http'; url: string }
  | { name: string; transport: 'stdio'; command: string[] }

export interface Transport {
  send(msg: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>
  notify(msg: JsonRpcNotification): Promise<void>
  close(): Promise<void>
}

export class McpError extends Error {
  constructor(
    readonly server: string,
    message: string,
  ) {
    super(`MCP server "${server}": ${message}`)
    this.name = 'McpError'
  }
}

/** Find the reply to `id` in a JSON-RPC body that may be a single response or a batch. */
export function matchResponse(body: unknown, id: number): JsonRpcResponse | null {
  const candidates = Array.isArray(body) ? body : [body]
  for (const c of candidates) {
    if (c && typeof c === 'object' && 'jsonrpc' in c && (c as JsonRpcResponse).id === id) return c as JsonRpcResponse
  }
  return null
}
