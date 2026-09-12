/**
 * Session transcripts, for `exec resume <id>`.
 *
 * `<data>/sessions/<id>.jsonl`: a header line, then one line per chat message, appended as
 * the run produces them. Append-only so a crash mid-turn loses at most the turn, and JSONL
 * so a partial last line is recoverable rather than a corrupt document.
 *
 * The system message is stored with the rest but REPLACED on resume by whatever the caller
 * passes this time: a host re-sends its rules every turn on purpose.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ObrewError } from '../shared/errors'
import { readLines } from '../shared/ndjson'
import { sessionsDir } from '../shared/paths'
import type { ChatMessage } from './messages'

export const SessionHeaderSchema = z.object({
  type: z.literal('header'),
  id: z.string(),
  createdAt: z.string(),
  model: z.string(),
  cwd: z.string(),
})
export type SessionHeader = z.infer<typeof SessionHeaderSchema>

export interface Session {
  header: SessionHeader
  messages: ChatMessage[]
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 12 base-36 characters (~62 bits). Opaque to callers. */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

const pathFor = (id: string) => {
  if (!/^[a-z0-9]{6,32}$/.test(id)) throw new ObrewError('bad_request', `"${id}" is not a session id`)
  return join(sessionsDir(), `${id}.jsonl`)
}

export async function createSession(header: Omit<SessionHeader, 'type'>): Promise<SessionHeader> {
  await mkdir(sessionsDir(), { recursive: true })
  const full: SessionHeader = { type: 'header', ...header }
  await Bun.write(pathFor(header.id), JSON.stringify(full) + '\n')
  return full
}

export async function appendMessages(id: string, messages: ChatMessage[]): Promise<void> {
  if (messages.length === 0) return
  const { appendFile } = await import('node:fs/promises')
  const lines = messages.map((m) => JSON.stringify({ type: 'message', message: m })).join('\n') + '\n'
  await appendFile(pathFor(id), lines)
}

export async function loadSession(id: string): Promise<Session> {
  const path = pathFor(id)
  const file = Bun.file(path)
  if (!(await file.exists())) throw new ObrewError('bad_request', `session ${id} not found`)
  let header: SessionHeader | null = null
  const messages: ChatMessage[] = []
  for await (const line of readLines(file.stream())) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // a torn last line from an interrupted write
    }
    const asHeader = SessionHeaderSchema.safeParse(parsed)
    if (asHeader.success) {
      header = asHeader.data
      continue
    }
    const record = parsed as { type?: string; message?: ChatMessage }
    if (record.type === 'message' && record.message) messages.push(record.message)
  }
  if (!header) throw new ObrewError('bad_request', `session ${id} has no header`)
  return { header, messages }
}

export async function listSessions(): Promise<SessionHeader[]> {
  let names: string[]
  try {
    names = await readdir(sessionsDir())
  } catch {
    return []
  }
  const out: SessionHeader[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const first = (await Bun.file(join(sessionsDir(), name)).text()).split('\n')[0] ?? ''
      const parsed = SessionHeaderSchema.safeParse(JSON.parse(first))
      if (parsed.success) out.push(parsed.data)
    } catch {
      // Skip unreadable.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function deleteSession(id: string): Promise<void> {
  await rm(pathFor(id), { force: true })
}
