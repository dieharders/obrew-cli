import { describe, expect, test } from 'bun:test'
import { parse, parseConfigPairs, parseNamedPair } from './args'

describe('parseConfigPairs', () => {
  test('JSON values where valid, raw strings otherwise', () => {
    expect(parseConfigPairs(['temperature=0.2', 'thinking=off', 'mlock=true', 'stop=["a","b"]', 'name=Q4_K_M'])).toEqual({
      temperature: 0.2,
      thinking: 'off',
      mlock: true,
      stop: ['a', 'b'],
      name: 'Q4_K_M',
    })
  })
  test('a value may contain "="', () => {
    expect(parseConfigPairs(['grammar=root ::= "a=b"'])).toEqual({ grammar: 'root ::= "a=b"' })
  })
  test('missing "=" is a usage error', () => {
    expect(() => parseConfigPairs(['nope'])).toThrow(/key=value/)
  })
})

describe('parse', () => {
  test('repeatable short flag and positionals', () => {
    const out = parse(['-c', 'a=1', '-c', 'b=2', 'exec', 'hello world'], {
      config: { type: 'string', multiple: true, short: 'c' },
    } as const)
    expect(out.values.config).toEqual(['a=1', 'b=2'])
    expect(out.positionals).toEqual(['exec', 'hello world'])
  })
  test('unknown flags are usage errors, not crashes', () => {
    expect(() => parse(['--bogus'], {})).toThrow(/bogus/)
  })
})

test('parseNamedPair', () => {
  expect(parseNamedPair('mb=http://x/y?z=1', '--mcp-server')).toEqual({ name: 'mb', value: 'http://x/y?z=1' })
  expect(() => parseNamedPair('=x', '--mcp-server')).toThrow(/name=value/)
})
