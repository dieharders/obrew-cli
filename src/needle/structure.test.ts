import { describe, expect, test } from 'bun:test'
import type { Tool } from '../agent/tools/types'
import type { NeedleSession } from './session'
import type { NeedleReply } from './sidecar'
import { callTools, draftFormat, namedTool, needleExtractable, parseDraft, reconcile, structureAnswer, structureToolCall, toolCards } from './structure'

const FRAMING = {
  type: 'object',
  properties: {
    theme: { type: 'string', enum: ['minimal', 'bold'] },
    language: { type: 'string', description: 'two-letter language code' },
    title: { type: 'string' },
    seconds: { type: 'number' },
    fixes: { type: 'array', items: { type: 'string' } },
  },
  required: ['theme', 'title'],
}
const DRAFT = 'theme: bold\nlanguage: en\ntitle: Solar That Pays For Itself.\nseconds: 60\nfixes:\n- Shortened the headline\n- Raised contrast'

/** A session that answers with a scripted reply and records what it was asked. */
function session(reply: NeedleReply | null) {
  const seen: Array<{ tools: string[]; forced: boolean; input: string }> = []
  const fake = {
    complete: async (tools: Array<{ name: string }>, forced: boolean, input: string) => {
      seen.push({ tools: tools.map((t) => t.name), forced, input })
      return reply
    },
  } as unknown as NeedleSession
  return { fake, seen }
}
const calls = (name: string, args: Record<string, unknown>, confidence = 0.95): NeedleReply => ({ calls: [{ name, arguments: args }], confidence, error: null })

const tool = (name: string, inputSchema: Record<string, unknown>): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema,
  execute: async () => ({ content: '' }),
})
const SNAPSHOT = tool('snapshot', { type: 'object', properties: { slideId: { type: 'string' }, atSec: { type: 'number' } }, required: ['slideId'] })
const WRITE = tool('write_file', { type: 'object', properties: { path: { type: 'string' }, spec: { type: 'object', properties: {} } }, required: ['path'] })

describe('needleExtractable', () => {
  test('a flat record of scalars and scalar lists is; nesting, unions and tuples are not', () => {
    expect(needleExtractable(FRAMING)).toBe(true)
    expect(needleExtractable(WRITE.inputSchema)).toBe(false)
    expect(needleExtractable({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } } })).toBe(false)
    expect(needleExtractable({ type: 'object', properties: { a: { type: 'array', prefixItems: [], items: { type: 'string' } } } })).toBe(false)
    expect(needleExtractable({ type: 'object', properties: {} })).toBe(false)
  })
})

describe('draftFormat', () => {
  test('spells out every allowed word, with the description inside the placeholder', () => {
    const text = draftFormat(FRAMING)
    expect(text).toContain('theme: <one of: minimal | bold>')
    expect(text).toContain('language: <two-letter language code; text on ONE line>')
    expect(text).toContain('Leave out the line for language, seconds, fixes')
  })
})

describe('parseDraft', () => {
  test('reads name: value lines and "- " lists, through markdown dressing', () => {
    const parsed = parseDraft(`**Theme:** bold\n${DRAFT.split('\n').slice(1).join('\n')}`, Object.keys(FRAMING.properties))
    expect(parsed.get('theme')).toBe('bold')
    expect(parsed.get('title')).toBe('Solar That Pays For Itself.')
    expect(parsed.get('fixes')).toEqual(['Shortened the headline', 'Raised contrast'])
  })
})

describe('reconcile', () => {
  const good = { theme: 'bold', language: 'en', title: 'Solar That Pays For Itself', seconds: 60, fixes: ['shortened the headline', 'Raised contrast'] }

  test("keeps the draft's own text where the copy differs only in case or a full stop", () => {
    const result = reconcile(good, FRAMING, DRAFT)
    expect(result).toEqual({
      ok: true,
      value: { theme: 'bold', language: 'en', title: 'Solar That Pays For Itself.', seconds: 60, fixes: ['Shortened the headline', 'Raised contrast'] },
    })
  })

  test.each([
    ['a crossed field', { ...good, language: 'bold' }],
    ['a value cut short', { ...good, title: 'Solar' }],
    ['a dropped field', { theme: 'bold', title: 'Solar That Pays For Itself', seconds: 60, fixes: good.fixes }],
    ['a wrong number', { ...good, seconds: 6 }],
    ['a list of the wrong length', { ...good, fixes: ['Raised contrast'] }],
    ['a field the schema does not have', { ...good, extra: 'x' }],
  ])('rejects %s', (_, args) => {
    expect(reconcile(args, FRAMING, DRAFT).ok).toBe(false)
  })

  test('with no layout to check against, a value must still be a span of the draft', () => {
    const prose = 'I would go bold here, and call it Solar That Pays For Itself.'
    expect(reconcile({ theme: 'bold', title: 'Solar That Pays For Itself' }, FRAMING, prose).ok).toBe(true)
    expect(reconcile({ theme: 'bold', title: 'Wind That Pays' }, FRAMING, prose).ok).toBe(false)
  })
})

describe('structureAnswer', () => {
  test('asks for the one answer tool, forced, and returns the verified value', async () => {
    const { fake, seen } = session(calls('answer', { theme: 'bold', language: 'en', title: 'Solar That Pays For Itself', seconds: 60, fixes: ['Shortened the headline', 'Raised contrast'] }))
    const result = await structureAnswer(fake, FRAMING, DRAFT)
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{ tools: ['answer'], forced: true, input: DRAFT }])
  })

  test.each([
    ['the tool model is unavailable', null],
    ['the runner failed', { calls: [], confidence: 0.1, error: 'truncated' } as NeedleReply],
    ['nothing came back', { calls: [], confidence: 0.9, error: null } as NeedleReply],
    ['the copy is wrong', calls('answer', { theme: 'bold', title: 'Solar' })],
  ])('falls back when %s', async (_, reply) => {
    expect((await structureAnswer(session(reply).fake, FRAMING, DRAFT)).ok).toBe(false)
  })
})

describe('structureToolCall', () => {
  const tools = [SNAPSHOT, WRITE]

  test('"tool: none" is the author\'s word: the tool model is not even asked', async () => {
    const { fake, seen } = session(calls('snapshot', { slideId: '' }, 0.99))
    expect(await structureToolCall(fake, tools, 'tool: none')).toEqual({ kind: 'none' })
    expect(seen).toEqual([])
  })

  test('a named tool with arguments the draft states is a complete call', async () => {
    const { fake, seen } = session(calls('snapshot', { slideId: 'slide-3', atSec: 2.5 }))
    const choice = await structureToolCall(fake, tools, 'tool: snapshot\nslideId: slide-3\natSec: 2.5')
    expect(choice).toMatchObject({ kind: 'call', args: { slideId: 'slide-3', atSec: 2.5 } })
    expect(seen[0]!.tools).toEqual(['snapshot', 'write_file', 'none'])
    expect(seen[0]!.forced).toBe(false)
  })

  test('arguments that are not the draft\'s go back to the baseline model, the choice stands', async () => {
    const choice = await structureToolCall(session(calls('snapshot', { slideId: 'slide-9' })).fake, tools, 'tool: snapshot\nslideId: slide-3')
    expect(choice).toMatchObject({ kind: 'call', args: null })
  })

  test('a tool with an authored body is chosen by name only', async () => {
    const choice = await structureToolCall(session(calls('write_file', {})).fake, tools, 'tool: write_file')
    expect(choice).toMatchObject({ kind: 'call', args: null })
    expect(callTools(tools)[1]!.parameters).toEqual({ type: 'object', properties: {}, required: [] })
    expect(toolCards(tools)).toContain('name the tool only')
  })

  test.each([
    ['the draft and the tool model disagree', 'tool: write_file', calls('snapshot', { slideId: 'a' })],
    ['the draft names no tool and confidence is low', 'I should look at slide-3', calls('snapshot', { slideId: 'slide-3' }, 0.45)],
    ['the tool model says none but the draft did not', 'tool: snapshot', calls('none', {})],
    ['the tool is not one of the run\'s', 'tool: snapshot', calls('lock_door', {})],
    ['the tool model is unavailable', 'tool: snapshot', null],
  ])('is unsure when %s', async (_, draft, reply) => {
    expect((await structureToolCall(session(reply).fake, tools, draft)).kind).toBe('unsure')
  })

  test('an unnamed tool is taken at high confidence', async () => {
    const choice = await structureToolCall(session(calls('snapshot', { slideId: 'slide-3' }, 0.93)).fake, tools, 'I should look at slide-3')
    expect(choice.kind).toBe('call')
  })

  test('namedTool reads the tool line', () => {
    expect(namedTool('tool: snapshot\nslideId: a')).toBe('snapshot')
    expect(namedTool('**tool:** `Grep`')).toBe('Grep')
    expect(namedTool('no such line')).toBe(null)
  })
})
