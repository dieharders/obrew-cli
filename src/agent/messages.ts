/**
 * OpenAI-shaped chat messages — the format llama-server's `/v1/chat/completions` takes and
 * the format the session transcript stores, so nothing is translated on the way in or out.
 */
export interface TextPart {
  type: 'text'
  text: string
}
export interface ImagePart {
  type: 'image_url'
  image_url: { url: string }
}
export type ContentPart = TextPart | ImagePart

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export const textOf = (m: ChatMessage): string => {
  if (m.role === 'assistant') return m.content ?? ''
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
