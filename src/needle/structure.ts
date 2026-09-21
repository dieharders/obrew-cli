/**
 * Author, then structure: the baseline model WRITES, the tool model FILLS THE SCHEMA.
 *
 * Decoding a small model under a grammar makes it do two jobs in one pass — think of the
 * content and keep to the shape — with thinking forced off (effort.ts). It is worse at the
 * first job for it: Gemma 4 E2B wrote a schema hint into a caption, and ran a CHOOSE `reason`
 * to 8,192 tokens (universal.ts). So the jobs are split:
 *
 *   1. DRAFT      the baseline model answers in plain `field: value` lines. No grammar.
 *   2. STRUCTURE  Needle copies those values into the schema, in tens of milliseconds.
 *   3. VERIFY     deterministic: the result validates, and every value is the draft's own.
 *   4. otherwise  the old path — the baseline model under a grammar — with the draft in view.
 *
 * What Needle is, because it decides everything below: a 121M model that only emits function
 * calls, whose arguments are SPANS COPIED FROM ITS INPUT. It cannot invent a value, so it is
 * never asked to; and its confidence is no safety net (the published notebook: "handle it" →
 * `lock_door(door="handle")` at 1.000), so step 3 never trusts it.
 *
 * Measured on macOS arm64 with needle3, which is where the rules here come from:
 *   - `field: value` lines + a "copy verbatim to the end of the line" description per field:
 *     8 of 8 fields exact, deterministic, ~250 ms. The same schema WITHOUT those descriptions
 *     cut "warm, confident and a little playful" to "warm"; the same content as loose PROSE
 *     put the title in the tagline and the summary. Hence the draft format and `needleTool`.
 *   - A trailing full stop is dropped from a copied sentence. Hence `reconcile` prefers the
 *     draft's own text when the two differ only that way.
 *   - Tool choice from `tool: snapshot / slideId: slide-3 / atSec: 2.5`: right at 0.96, 43 ms.
 *     With no `none` tool offered, "tool: none" became `snapshot(slideId="")` at 0.82. Hence
 *     NONE_TOOL, and hence "none" is read from the draft, never taken from Needle alone.
 *   - Multi-line values (a file body) are cut at the first line. Hence `needleExtractable`
 *     keeps authored bodies with the baseline model.
 *
 * WHERE THIS STANDS. Tool calls — a tool name and a few short arguments — are what Needle was
 * trained on, and that path is on: first real run, Grep chosen and filled in 81 ms at 0.90.
 * Multi-field RECORDS are not there yet, so `structureAnswer` is opt-in (`-c tool_answers`):
 * over three 8-field drafts needle3 copied 60–67% of fields exactly, whether asked for all
 * eight at once or in groups of 1, 2 or 3; it cut values at a comma ("Steuern, endlich einfach"
 * → "Steuern"), crossed fields (`language: "bold"`), and returned non-ASCII text mangled
 * ("Steuererklu00e4rung"). `reconcile` caught every one of these, which is why a wrong value
 * never gets out — and also why, today, nearly every record falls back after paying for a
 * draft. Re-measure with scripts or a newer Needle before turning it on by default.
 */
import type { JsonSchema, Tool } from '../agent/tools/types'
import { describeViolations, validate } from '../agent/tools/validate'
import type { NeedleSession } from './session'
import type { NeedleTool } from './sidecar'

/** A schema with more fields than this is a document, not a record; leave it to the grammar. */
const MAX_FIELDS = 16
/** Needle's context is 8,192 tokens shared by the tool schemas and the input. */
const MAX_SCHEMA_CHARS = 4_000
const MAX_DRAFT_CHARS = 8_000
/**
 * Below this a tool call is not taken from Needle when the draft did not name the tool itself.
 * The runner's publisher suggests 0.7; formatted drafts score 0.95+, loose ones 0.45–0.7.
 */
export const DEFAULT_TOOL_CONFIDENCE = 0.7

const SCALARS = new Set(['string', 'number', 'integer', 'boolean'])
const UNSUPPORTED = ['const', 'oneOf', 'anyOf', 'allOf', 'not', '$ref', 'prefixItems', 'patternProperties']

type Props = Record<string, JsonSchema>

const propsOf = (schema: JsonSchema): Props =>
  schema.properties && typeof schema.properties === 'object' ? (schema.properties as Props) : {}
const requiredOf = (schema: JsonSchema): string[] => (Array.isArray(schema.required) ? schema.required.map(String) : [])

function fieldKind(field: JsonSchema): 'scalar' | 'list' | null {
  if (UNSUPPORTED.some((k) => k in field)) return null
  if (typeof field.type !== 'string') return null
  if (SCALARS.has(field.type)) return 'scalar'
  if (field.type !== 'array') return null
  const items = field.items as JsonSchema | undefined
  if (!items || typeof items !== 'object' || typeof items.type !== 'string') return null
  return SCALARS.has(items.type) && !UNSUPPORTED.some((k) => k in items) ? 'list' : null
}

/**
 * Whether Needle can fill this schema from a draft: a flat record of scalars and lists of
 * scalars. Nested objects, unions and tuple schemas stay with the grammar — nothing measured
 * says Needle holds their shape, and a deck spec's 42 KB schema would not fit its context.
 */
export function needleExtractable(schema: JsonSchema): boolean {
  if (schema.type !== 'object' || UNSUPPORTED.some((k) => k in schema)) return false
  const props = Object.entries(propsOf(schema))
  if (props.length === 0 || props.length > MAX_FIELDS) return false
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) return false
  return props.every(([, field]) => fieldKind(field) !== null)
}

function allowed(field: JsonSchema): string {
  if (Array.isArray(field.enum)) return `one of: ${field.enum.map(String).join(' | ')}`
  if (field.type === 'boolean') return 'true or false'
  if (field.type === 'number' || field.type === 'integer') return 'a number, in digits'
  return typeof field.maxLength === 'number' ? `text on ONE line, at most ${field.maxLength} characters` : 'text on ONE line'
}

/**
 * The placeholder a value replaces. The field's description goes INSIDE it: written after it
 * (`language: <text> — two-letter language code`) Gemma 4 E2B took the dash for part of the
 * layout and answered `language: English — en`.
 */
function placeholder(field: JsonSchema): string {
  const about = typeof field.description === 'string' ? `${field.description}; ` : ''
  return `<${about}${allowed(field)}>`
}

/** What the baseline model is told to write. Every allowed word is spelled out, so the span exists. */
export function draftFormat(schema: JsonSchema): string {
  const required = new Set(requiredOf(schema))
  const lines = Object.entries(propsOf(schema)).map(([name, field]) => {
    if (fieldKind(field) === 'list') {
      const about = typeof field.description === 'string' ? `${field.description}; ` : ''
      return `${name}:\n- <${about}one item per line, each starting with "- "; ${allowed(field.items as JsonSchema)}>`
    }
    return `${name}: ${placeholder(field)}`
  })
  const optional = Object.keys(propsOf(schema)).filter((n) => !required.has(n))
  return (
    'Write the answer as plain text in exactly this layout: one `name: value` per line, the names ' +
    'spelled as below, each <...> replaced by the value alone. No JSON, no code fence, no commentary.' +
    (optional.length > 0 ? ` Leave out the line for ${optional.join(', ')} when it does not apply.` : '') +
    '\n\n' +
    lines.join('\n')
  )
}

/** The tool Needle is given for a schema: each field told to copy its line, whole. */
export function needleTool(name: string, description: string, schema: JsonSchema): NeedleTool {
  const properties: Props = {}
  for (const [field, spec] of Object.entries(propsOf(schema))) {
    const about = typeof spec.description === 'string' ? `${spec.description}. ` : ''
    const copy =
      fieldKind(spec) === 'list'
        ? `Each "- " line under '${field}:' is one item, copied verbatim.`
        : Array.isArray(spec.enum) || spec.type !== 'string'
          ? `The value after '${field}:'.`
          : `The complete text after '${field}:' copied verbatim to the end of the line.`
    properties[field] = { ...spec, description: about + copy }
  }
  return { name, description, parameters: { type: 'object', properties, required: requiredOf(schema) } }
}

/** `name: value` lines and `- item` lists, read the way `draftFormat` asked for them. */
export function parseDraft(draft: string, names: string[]): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>()
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]))
  let list: string[] | null = null
  for (const raw of draft.split('\n')) {
    const line = raw.replace(/^[\s>*_`]+/, '').trimEnd()
    const item = /^[-•]\s+(.*)$/.exec(raw.trim())
    if (item && list) {
      list.push(item[1]!.trim())
      continue
    }
    const pair = /^([A-Za-z_][\w-]*)[*_`]*\s*:\s*(.*)$/.exec(line)
    const name = pair ? byLower.get(pair[1]!.toLowerCase()) : undefined
    if (!pair || !name) {
      if (line.trim() !== '') list = null
      continue
    }
    // `**theme:** bold` closes its emphasis AFTER the colon, and a name is often in backticks.
    const value = pair[2]!.replace(/^[\s*_`]+/, '').replace(/[\s*_`]+$/, '')
    if (value === '') {
      list = []
      out.set(name, list)
    } else {
      list = null
      out.set(name, value)
    }
  }
  return out
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/["'`*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:!?]+$/, '')
    .trim()

/**
 * One value, checked against the draft. Returns the value to keep — the draft's own text when
 * Needle's copy differs only in case, quotes or a trailing full stop — or undefined when the
 * value is not the draft's, which fails the whole structuring.
 */
function reconcileScalar(value: unknown, field: JsonSchema, line: string | undefined, draft: string): unknown {
  if (typeof value === 'string') {
    if (line !== undefined) {
      if (norm(line) !== norm(value)) return undefined
      return Array.isArray(field.enum) ? value : line
    }
    // The draft strayed from the layout. A value is still only ever a span of it.
    return norm(value) !== '' && norm(draft).includes(norm(value)) ? value : undefined
  }
  if (typeof value === 'number') {
    if (line !== undefined) return Number(line.replace(/[^\d.eE+-]/g, '')) === value ? value : undefined
    return draft.includes(String(value)) ? value : undefined
  }
  if (typeof value === 'boolean') {
    if (line === undefined) return value
    const said = /^(true|yes)\b/i.test(line) ? true : /^(false|no)\b/i.test(line) ? false : null
    return said === value ? value : undefined
  }
  return undefined
}

export type Reconciled = { ok: true; value: Record<string, unknown> } | { ok: false; why: string }

/** Check Needle's arguments against the schema and the draft; `why` names the first thing wrong. */
export function reconcile(args: Record<string, unknown>, schema: JsonSchema, draft: string): Reconciled {
  const no = (why: string): Reconciled => ({ ok: false, why })
  const show = (v: unknown) => JSON.stringify(v)?.slice(0, 80)
  const props = propsOf(schema)
  const parsed = parseDraft(draft, Object.keys(props))
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(args)) {
    const field = props[name]
    if (!field) return no(`unknown field ${name}`)
    const line = parsed.get(name)
    if (fieldKind(field) === 'list') {
      if (!Array.isArray(value)) return no(`${name} is not a list`)
      const lines = Array.isArray(line) ? line : undefined
      // A list the draft wrote out is the draft's list: same length, item for item.
      if (lines && lines.length !== value.length) return no(`${name} has ${value.length} items, the draft ${lines.length}`)
      const items = value.map((v, i) => reconcileScalar(v, field.items as JsonSchema, lines?.[i], draft))
      if (items.some((v) => v === undefined)) return no(`${name} ${show(value)} is not the draft's ${show(lines)}`)
      out[name] = items
    } else {
      const kept = reconcileScalar(value, field, typeof line === 'string' ? line : undefined, draft)
      if (kept === undefined) return no(`${name} ${show(value)} is not the draft's ${show(line)}`)
      out[name] = kept
    }
  }
  // A field the draft wrote and Needle dropped is a lost value, not an optional one.
  for (const name of parsed.keys()) if (!(name in out)) return no(`${name} was in the draft and not in the answer`)
  const violations = validate(out, schema)
  return violations.length === 0 ? { ok: true, value: out } : no(describeViolations(violations))
}

export type StructureResult = { ok: true; value: Record<string, unknown>; ms: number } | { ok: false; why: string }

const ANSWER_TOOL = 'answer'

/** Whether a side-car for this schema is worth warming before the draft is written. */
export const answerTools = (schema: JsonSchema): NeedleTool[] => [
  needleTool(ANSWER_TOOL, 'Record the answer exactly as the text states it.', schema),
]

/** Steps 2 and 3 for a schema'd answer. */
export async function structureAnswer(session: NeedleSession, schema: JsonSchema, draft: string): Promise<StructureResult> {
  if (draft.length > MAX_DRAFT_CHARS) return { ok: false, why: 'draft too long for the tool model' }
  const startedAt = Date.now()
  const reply = await session.complete(answerTools(schema), true, draft)
  if (!reply) return { ok: false, why: 'tool model unavailable' }
  if (reply.error) return { ok: false, why: reply.error }
  const call = reply.calls.find((c) => c.name === ANSWER_TOOL)
  if (!call) return { ok: false, why: 'no answer returned' }
  const checked = reconcile(call.arguments, schema, draft)
  return checked.ok ? { ok: true, value: checked.value, ms: Date.now() - startedAt } : checked
}

/** Offered beside the real tools so "no tool" has somewhere to go. See the header. */
const NONE_TOOL: NeedleTool = {
  name: 'none',
  description: 'No tool is needed; the assistant answers directly.',
  parameters: { type: 'object', properties: {}, required: [] },
}

/**
 * The run's tools as Needle sees them. A tool whose arguments it cannot fill (an authored file
 * body, a nested spec) is offered by name alone: Needle picks it, the baseline model fills it.
 */
export function callTools(tools: Tool[]): NeedleTool[] {
  return [
    ...tools.map((t) =>
      needleExtractable(t.inputSchema) || Object.keys(propsOf(t.inputSchema)).length === 0
        ? needleTool(t.name, t.description, t.inputSchema)
        : { name: t.name, description: t.description, parameters: { type: 'object', properties: {}, required: [] } },
    ),
    NONE_TOOL,
  ]
}

/** Tool cards for the baseline model: what each tool is for and what to state, never a schema. */
export function toolCards(tools: Tool[]): string {
  return tools
    .map((t) => {
      const props = propsOf(t.inputSchema)
      const names = Object.keys(props)
      const fillable = needleExtractable(t.inputSchema)
      const args =
        names.length === 0
          ? 'no arguments'
          : fillable
            ? names.map((n) => `${n} (${allowed(props[n]!)})`).join('; ')
            : 'arguments are asked for in a following step — name the tool only'
      return `### ${t.name}\n${t.description}\nArguments: ${args}`
    })
    .join('\n\n')
}

export type ToolChoice =
  | { kind: 'none' }
  /** `args` is null when the baseline model must fill them under the tool's schema. */
  | { kind: 'call'; tool: Tool; args: Record<string, unknown> | null; why?: string; confidence: number | null; ms: number }
  | { kind: 'unsure'; why: string }

/** The `tool:` line of a draft, when it wrote one. */
export function namedTool(draft: string): string | null {
  const value = parseDraft(draft, ['tool']).get('tool')
  return typeof value === 'string' ? value.replace(/[^\w-].*$/, '') : null
}

/** Steps 2 and 3 for a tool call: which tool the draft means, and its arguments if Needle can fill them. */
export async function structureToolCall(
  session: NeedleSession,
  tools: Tool[],
  draft: string,
  minConfidence = DEFAULT_TOOL_CONFIDENCE,
): Promise<ToolChoice> {
  const said = namedTool(draft)
  // "none" ends the loop, so it is the author's word that counts, not the tool model's.
  if (said?.toLowerCase() === 'none') return { kind: 'none' }
  if (draft.length > MAX_DRAFT_CHARS) return { kind: 'unsure', why: 'draft too long for the tool model' }

  const startedAt = Date.now()
  const reply = await session.complete(callTools(tools), false, draft)
  if (!reply) return { kind: 'unsure', why: 'tool model unavailable' }
  if (reply.error) return { kind: 'unsure', why: reply.error }
  const call = reply.calls[0]
  if (!call) return { kind: 'unsure', why: 'no call returned' }
  const tool = tools.find((t) => t.name === call.name)
  if (!tool) return { kind: 'unsure', why: call.name === 'none' ? 'tool model chose none but the draft did not' : `unknown tool "${call.name}"` }

  // Two witnesses: the draft names the tool, or Needle is confident. One of them must hold,
  // and when the draft names a tool they must agree.
  if (said && said !== tool.name) return { kind: 'unsure', why: `draft says ${said}, tool model says ${tool.name}` }
  if (!said && (reply.confidence ?? 0) < minConfidence) return { kind: 'unsure', why: `confidence ${reply.confidence ?? 'unknown'}` }

  const ms = Date.now() - startedAt
  const fillable = needleExtractable(tool.inputSchema) || Object.keys(propsOf(tool.inputSchema)).length === 0
  const checked = fillable ? reconcile(call.arguments, tool.inputSchema, draft.replace(/^.*\btool\s*:.*$/im, '')) : null
  return {
    kind: 'call',
    tool,
    args: checked?.ok ? checked.value : null,
    ...(checked && !checked.ok ? { why: checked.why } : {}),
    confidence: reply.confidence,
    ms,
  }
}
