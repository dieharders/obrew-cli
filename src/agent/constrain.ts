/**
 * Request-body fragments for constrained decoding.
 *
 * Three ways to pin the model's output, never combined in one request (llama-server rejects
 * a custom grammar alongside `tools`):
 *
 *   native tools   `tools` + `tool_choice` — llama.cpp builds a lazy grammar from the chat
 *                  template and the tool schemas, so a tool call is well-formed JSON for that
 *                  tool's parameters, triggered by the template's own tool-call marker.
 *   json schema    `response_format: { type: 'json_schema', json_schema: { schema } }` — the
 *                  whole answer is decoded under the schema.
 *   grammar        a GBNF string, for anything a schema cannot say.
 */
import type { JsonSchema } from './tools/types'

export const nativeToolsBody = (schemas: Record<string, unknown>[], required = false): Record<string, unknown> =>
  schemas.length === 0 ? {} : { tools: schemas, tool_choice: required ? 'required' : 'auto', parallel_tool_calls: false }

export const jsonSchemaBody = (schema: JsonSchema, name = 'answer'): Record<string, unknown> => ({
  response_format: { type: 'json_schema', json_schema: { name, schema } },
})

export const grammarBody = (grammar: string): Record<string, unknown> => ({ grammar })

/** `--output-schema '{...}'` or `--output-schema @file.json`. */
export async function loadOutputSchema(spec: string): Promise<JsonSchema> {
  const text = spec.startsWith('@') ? await Bun.file(spec.slice(1)).text() : spec
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--output-schema must be a JSON Schema object')
  return parsed as JsonSchema
}

/** `--grammar @file.gbnf` or an inline grammar. */
export async function loadGrammar(spec: string): Promise<string> {
  return spec.startsWith('@') ? await Bun.file(spec.slice(1)).text() : spec
}

/** Whether a chat template knows about tools (llama-server exposes it on GET /props). */
export function templateSupportsTools(props: Record<string, unknown>): boolean {
  const template = props.chat_template
  return typeof template === 'string' && /\btools\b/.test(template)
}
