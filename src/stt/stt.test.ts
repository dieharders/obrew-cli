import { describe, expect, test } from 'bun:test'
import { parseAsrAnswer } from './client'

describe('parseAsrAnswer', () => {
  test('reads Qwen3-ASR’s language-tagged format', () => {
    expect(parseAsrAnswer('language English<asr_text>Hello there, I am your minion.')).toEqual({
      language: 'English',
      text: 'Hello there, I am your minion.',
    })
  })

  test('tolerates a closing tag, surrounding whitespace and a bare answer', () => {
    expect(parseAsrAnswer('  language Chinese<asr_text>你好</asr_text>\n')).toEqual({ language: 'Chinese', text: '你好' })
    expect(parseAsrAnswer('plain words only')).toEqual({ language: null, text: 'plain words only' })
    expect(parseAsrAnswer('')).toEqual({ language: null, text: '' })
  })
})
