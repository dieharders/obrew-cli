/**
 * Argument parsing on top of `node:util`'s `parseArgs` (built into Bun; no dependency).
 *
 * Every knob that affects a run is also expressible as `-c key=value`, the way `codex exec`
 * does it, so `exec` and `exec resume` accept the identical flag set and a host never has to
 * special-case the second turn.
 */
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { UsageError } from '../shared/errors'

type Options = NonNullable<ParseArgsConfig['options']>

export interface Parsed<O extends Options> {
  values: ReturnType<typeof parseArgs<{ options: O; allowPositionals: true; strict: true }>>['values']
  positionals: string[]
}

export function parse<O extends Options>(argv: string[], options: O): Parsed<O> {
  try {
    const out = parseArgs({ args: argv, options, allowPositionals: true, strict: true })
    return { values: out.values, positionals: out.positionals }
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * `-c key=value` pairs → an object. The value is parsed as JSON when it is valid JSON
 * (numbers, booleans, quoted strings, arrays) and kept as a raw string otherwise, so
 * `-c temperature=0.2`, `-c thinking=off` and `-c stop=["</s>"]` all read naturally.
 */
export function parseConfigPairs(pairs: readonly string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new UsageError(`-c expects key=value, got "${pair}"`)
    const key = pair.slice(0, eq).trim()
    const raw = pair.slice(eq + 1)
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {
      // Raw string.
    }
    out[key] = value
  }
  return out
}

/** `name=value` for repeatable flags such as `--mcp-server`. */
export function parseNamedPair(input: string, flag: string): { name: string; value: string } {
  const eq = input.indexOf('=')
  if (eq <= 0) throw new UsageError(`${flag} expects name=value, got "${input}"`)
  return { name: input.slice(0, eq).trim(), value: input.slice(eq + 1) }
}

export const asInt = (v: unknown, flag: string): number => {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new UsageError(`${flag} expects a number, got "${String(v)}"`)
  return Math.trunc(n)
}

export const asNumber = (v: unknown, flag: string): number => {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new UsageError(`${flag} expects a number, got "${String(v)}"`)
  return n
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], flag: string): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
  throw new UsageError(`${flag} must be one of ${allowed.join('|')}, got "${String(v)}"`)
}
