/**
 * A small JSON Schema validator for tool arguments.
 *
 * Constrained decoding makes the model's JSON well-formed and schema-shaped for the parts
 * llama.cpp's grammar covers; this is the belt to that braces. It checks what tool schemas
 * actually use — types, required, properties, items, enum/const, numeric and length bounds,
 * anyOf/oneOf — and reports every problem in plain words the model can act on when the loop
 * asks it to repair a call. Not a full Draft 2020-12 implementation, on purpose.
 */
import type { JsonSchema } from './types'

export interface Violation {
  path: string
  message: string
}

const typeOf = (v: unknown): string => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

const matchesType = (actual: string, expected: string): boolean =>
  actual === expected || (expected === 'number' && actual === 'integer')

export function validate(value: unknown, schema: JsonSchema, path = '$'): Violation[] {
  const out: Violation[] = []
  const actual = typeOf(value)

  const declared = schema.type
  if (declared !== undefined) {
    const allowed = Array.isArray(declared) ? (declared as string[]) : [declared as string]
    if (!allowed.some((t) => matchesType(actual, t))) {
      out.push({ path, message: `expected ${allowed.join(' | ')}, got ${actual}` })
      return out
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    out.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` })
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    out.push({ path, message: `must equal ${JSON.stringify(schema.const)}` })
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.push({ path, message: `shorter than ${schema.minLength}` })
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.push({ path, message: `longer than ${schema.maxLength}` })
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) out.push({ path, message: `does not match /${schema.pattern}/` })
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push({ path, message: `below minimum ${schema.minimum}` })
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push({ path, message: `above maximum ${schema.maximum}` })
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) out.push({ path, message: `fewer than ${schema.minItems} items` })
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) out.push({ path, message: `more than ${schema.maxItems} items` })
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => out.push(...validate(item, schema.items as JsonSchema, `${path}[${i}]`)))
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) out.push({ path: `${path}.${key}`, message: 'is required' })
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) out.push(...validate(obj[key], sub, `${path}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) out.push({ path: `${path}.${key}`, message: 'is not an allowed property' })
      }
    }
  }

  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key]
    if (Array.isArray(options)) {
      const passing = options.filter((o) => validate(value, o as JsonSchema, path).length === 0).length
      if (passing === 0 || (key === 'oneOf' && passing > 1)) out.push({ path, message: `does not satisfy ${key}` })
    }
  }
  return out
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export const describeViolations = (v: Violation[]): string =>
  v.map((x) => `${x.path} ${x.message}`).join('; ')
