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

  test('a tool call is sampled near-greedy at every effort; a free turn keeps the effort temperature', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const gen = generationFor(effort)
      expect(requestParams(gen, { constrained: true, toolCall: true }).temperature).toBe(0.1)
      expect(requestParams(gen).temperature).toBe(gen.temperature)
      // A structured ANSWER (--output-schema) is constrained but not a tool call.
      expect(requestParams(gen, { constrained: true }).temperature).toBe(gen.temperature)
    }
  })

  test('-c tool_temperature overrides, and never exceeds the turn temperature', () => {
    expect(requestParams(generationFor('medium', { tool_temperature: 0 }), { toolCall: true }).temperature).toBe(0)
    expect(requestParams(generationFor('medium', { tool_temperature: 0.9 }), { toolCall: true }).temperature).toBe(0.3)
    expect(requestParams(generationFor('low', { temperature: 0.05 }), { toolCall: true }).temperature).toBe(0.05)
  })

  test('bad values are usage errors', () => {
    expect(() => generationFor('low', { thinking: 'maybe' })).toThrow(/on\|off\|default/)
    expect(() => generationFor('low', { temperature: 'hot' })).toThrow(/number/)
  })
})
