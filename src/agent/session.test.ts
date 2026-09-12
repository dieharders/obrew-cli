import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempHome } from '../../test/fixtures/home'
import { sessionsDir } from '../shared/paths'
import { appendMessages, createSession, deleteSession, listSessions, loadSession, newSessionId } from './session'

describe('sessions', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
  })
  afterEach(() => home.cleanup())

  test('ids are 12 base-36 chars and distinct', () => {
    const a = newSessionId()
    expect(a).toMatch(/^[a-z0-9]{12}$/)
    expect(newSessionId()).not.toBe(a)
  })

  test('round-trips header and messages; tolerates a torn last line', async () => {
    const id = newSessionId()
    await createSession({ id, createdAt: 't', model: 'm', cwd: '/x' })
    await appendMessages(id, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'out' },
    ])
    await appendFile(join(sessionsDir(), `${id}.jsonl`), '{"type":"message","mess')
    const session = await loadSession(id)
    expect(session.header).toMatchObject({ id, model: 'm', cwd: '/x' })
    expect(session.messages).toHaveLength(4)
    expect(session.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c' }] })

    expect((await listSessions()).map((s) => s.id)).toEqual([id])
    await deleteSession(id)
    await expect(loadSession(id)).rejects.toMatchObject({ code: 'bad_request' })
  })

  test('rejects an id that is not an id', async () => {
    await expect(loadSession('../etc/passwd')).rejects.toMatchObject({ code: 'bad_request' })
  })
})
