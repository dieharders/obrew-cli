/**
 * `obrew sessions list|show|rm`
 */
import { textOf } from '../../agent/messages'
import { deleteSession, listSessions, loadSession } from '../../agent/session'
import { UsageError } from '../../shared/errors'
import { parse } from '../args'

const HELP = `obrew sessions list [--json]
obrew sessions show <id> [--json]
obrew sessions rm <id>`

export async function runSessions(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const [sub, id] = positionals
  switch (sub) {
    case 'list': {
      const sessions = await listSessions()
      if (values.json) console.log(JSON.stringify(sessions))
      else for (const s of sessions) console.log(`${s.id}  ${s.createdAt}  ${s.model}`)
      return 0
    }
    case 'show': {
      if (!id) throw new UsageError('show needs a session id')
      const session = await loadSession(id)
      if (values.json) {
        console.log(JSON.stringify(session))
        return 0
      }
      console.log(`${session.header.id}  ${session.header.createdAt}  ${session.header.model}`)
      for (const m of session.messages) {
        const calls = m.role === 'assistant' && m.tool_calls ? ` [tools: ${m.tool_calls.map((c) => c.function.name).join(', ')}]` : ''
        console.log(`\n[${m.role}]${calls}\n${textOf(m)}`)
      }
      return 0
    }
    case 'rm': {
      if (!id) throw new UsageError('rm needs a session id')
      await deleteSession(id)
      console.log(`removed ${id}`)
      return 0
    }
    default:
      throw new UsageError(`sessions: unknown subcommand "${sub ?? ''}"\n\n${HELP}`)
  }
}
