/**
 * Effort → generation settings, per request.
 *
 * llama-server's thinking budget is a launch flag, so effort cannot vary it without a
 * restart; what it CAN vary per request is whether the template thinks at all
 * (`chat_template_kwargs.enable_thinking`, plus `reasoning_effort: "none"`) and how long
 * the answer may run. Any CONSTRAINED request — a tool-argument fill, `--output-schema`,
 * `--grammar` — forces thinking off for that request: grammar and thinking conflict in
 * llama.cpp (obrew-engine's llama_server.py:263-274 records the symptom).
 */
import { UsageError } from '../shared/errors'

export const EFFORTS = ['low', 'medium', 'high'] as const
export type Effort = (typeof EFFORTS)[number]

export interface GenerationSettings {
  thinking: boolean
  maxTokens: number
  temperature: number
  /**
   * Temperature for a TOOL-CALL request: universal choose + fill, and the one argument repair.
   * Near-greedy by default, whatever the effort: choosing a tool and filling its arguments is
   * a lookup against the transcript, not authorship, and at the effort temperature a small
   * model picked a plausible wrong tool or re-filled arguments it had just seen fail.
   * `-c tool_temperature=` overrides; never raised above `temperature`. A NATIVE tool call is
   * part of the free turn and cannot be sampled apart from it, so this does not reach it.
   */
  toolTemperature: number
  topP?: number
  topK?: number
  minP?: number
  seed?: number
  stop?: string[]
  repeatPenalty?: number
}

export const TOOL_TEMPERATURE = 0.1

const TABLE: Record<Effort, Pick<GenerationSettings, 'thinking' | 'maxTokens' | 'temperature' | 'toolTemperature'>> = {
  low: { thinking: false, maxTokens: 4096, temperature: 0.2, toolTemperature: TOOL_TEMPERATURE },
  medium: { thinking: true, maxTokens: 8192, temperature: 0.3, toolTemperature: TOOL_TEMPERATURE },
  high: { thinking: true, maxTokens: 16384, temperature: 0.3, toolTemperature: TOOL_TEMPERATURE },
}

const num = (v: unknown, key: string): number => {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new UsageError(`-c ${key} expects a number, got "${String(v)}"`)
  return n
}

/** Apply the effort row, then any `-c` overrides. */
export function generationFor(effort: Effort, pairs: Record<string, unknown> = {}): GenerationSettings {
  const out: GenerationSettings = { ...TABLE[effort] }
  for (const [key, value] of Object.entries(pairs)) {
    switch (key) {
      case 'thinking':
        if (value === 'on' || value === true) out.thinking = true
        else if (value === 'off' || value === false) out.thinking = false
        else if (value !== 'default') throw new UsageError(`-c thinking expects on|off|default, got "${String(value)}"`)
        break
      case 'max_tokens':
        out.maxTokens = Math.trunc(num(value, key))
        break
      case 'temperature':
        out.temperature = num(value, key)
        break
      case 'tool_temperature':
        out.toolTemperature = num(value, key)
        break
      case 'top_p':
        out.topP = num(value, key)
        break
      case 'top_k':
        out.topK = Math.trunc(num(value, key))
        break
      case 'min_p':
        out.minP = num(value, key)
        break
      case 'seed':
        out.seed = Math.trunc(num(value, key))
        break
      case 'repeat_penalty':
        out.repeatPenalty = num(value, key)
        break
      case 'stop':
        out.stop = Array.isArray(value) ? value.map(String) : [String(value)]
        break
      default:
        break
    }
  }
  return out
}

/** The request-body fields for one `/v1/chat/completions` call. */
export function requestParams(
  gen: GenerationSettings,
  opts: { constrained?: boolean; toolCall?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    max_tokens: gen.maxTokens,
    temperature: opts.toolCall ? Math.min(gen.temperature, gen.toolTemperature) : gen.temperature,
  }
  if (gen.topP !== undefined) body.top_p = gen.topP
  if (gen.topK !== undefined) body.top_k = gen.topK
  if (gen.minP !== undefined) body.min_p = gen.minP
  if (gen.seed !== undefined) body.seed = gen.seed
  if (gen.stop) body.stop = gen.stop
  if (gen.repeatPenalty !== undefined) body.repeat_penalty = gen.repeatPenalty
  if (!gen.thinking || opts.constrained) {
    body.chat_template_kwargs = { enable_thinking: false }
    body.reasoning_effort = 'none'
  }
  return body
}

export function parseEffort(value: unknown): Effort {
  if (typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)) return value as Effort
  throw new UsageError(`--effort must be one of ${EFFORTS.join('|')}, got "${String(value)}"`)
}
