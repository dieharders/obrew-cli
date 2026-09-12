/**
 * The tool contract. The same shape motionbuff's `tool-types.ts` and MCP's `inputSchema`
 * use, so a built-in tool, an MCP tool and a host's registry all describe themselves the
 * same way and the loop never translates between them.
 */
export type JsonSchema = Record<string, unknown>

export interface ToolContext {
  /** The fence: the only directory the file tools may read. */
  cwd: string
  signal: AbortSignal
  /** Whether the loaded model can see images (it was loaded with a vision projector). */
  vision?: boolean
}

export interface ToolOutput {
  /** What the model sees, as text. */
  content: string
  /** A failed call: reported to the model as a result, not raised out of the loop. */
  isError?: boolean
  /**
   * Images for the model to look at. A tool result is text on the wire, so the loop follows
   * the result with a user message carrying these as image parts — the way a Read of a
   * rendered still reaches a vision model.
   */
  images?: ImagePart[]
}

export interface ImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export interface Tool {
  /** The name the model calls. `[A-Za-z0-9_-]{1,64}`: some chat templates reject more. */
  name: string
  description: string
  /** JSON Schema for the arguments, always an object schema. */
  inputSchema: JsonSchema
  /** Per-call cap for this tool, when the run's default is too short (remote tools). */
  timeoutMs?: number
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>
}

export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** OpenAI function-calling format, which is what llama-server's `tools` field takes. */
export function toolSchema(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }
}
