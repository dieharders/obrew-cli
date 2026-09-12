import { describe, expect, test } from 'bun:test'
import { generationFor, requestParams } from './effort'

describe('effort', () => {
  test('low turns thinking off per request; high leaves it to the template', () => {
    const low = requestParams(generationFor('low'))
    expect(low.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(low.reasoning_effort).toBe('none')
    expect(low.max_tokens).toBe(4096)
    const high = requestParams(generationFor('high'))
    expect(high.chat_template_kwargs).toBeUndefined()
    expect(high.max_tokens).toBe(16384)
  })

  test('-c overrides win, and a constrained request always disables thinking', () => {
    const gen = generationFor('medium', { thinking: 'on', max_tokens: '512', temperature: 0, stop: ['</s>'] })
    expect(gen).toMatchObject({ thinking: true, maxTokens: 512, temperature: 0, stop: ['</s>'] })
    expect(requestParams(gen).chat_template_kwargs).toBeUndefined()
    expect(requestParams(gen, { constrained: true }).chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  test('bad values are usage errors', () => {
    expect(() => generationFor('low', { thinking: 'maybe' })).toThrow(/on\|off\|default/)
    expect(() => generationFor('low', { temperature: 'hot' })).toThrow(/number/)
  })
})
