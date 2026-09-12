import { describe, expect, test } from 'bun:test'
import { describeViolations, validate } from './validate'

const schema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    offset: { type: 'integer', minimum: 1 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    nested: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  },
  required: ['path'],
  additionalProperties: false,
}

describe('validate', () => {
  test('a valid object has no violations', () => {
    expect(validate({ path: 'a', offset: 2, mode: 'a', tags: ['x'], nested: { n: 1.5 } }, schema)).toEqual([])
  })

  test('reports every problem with its path', () => {
    const v = validate({ offset: 0.5, mode: 'c', tags: ['x', 'y', 'z'], nested: {}, extra: 1 }, schema)
    const text = describeViolations(v)
    expect(text).toContain('$.path is required')
    expect(text).toContain('$.offset expected integer, got number')
    expect(text).toContain('$.mode must be one of')
    expect(text).toContain('$.tags more than 2 items')
    expect(text).toContain('$.nested.n is required')
    expect(text).toContain('$.extra is not an allowed property')
  })

  test('integer satisfies number; wrong top-level type short-circuits', () => {
    expect(validate(3, { type: 'number' })).toEqual([])
    expect(validate('x', { type: 'object', required: ['a'] })).toHaveLength(1)
  })

  test('anyOf / oneOf', () => {
    const s = { anyOf: [{ type: 'string' }, { type: 'number' }] }
    expect(validate(1, s)).toEqual([])
    expect(validate(true, s)).toHaveLength(1)
    const one = { oneOf: [{ type: 'number' }, { type: 'integer' }] }
    expect(validate(1, one)).toHaveLength(1)
    expect(validate(1.5, one)).toEqual([])
  })
})
