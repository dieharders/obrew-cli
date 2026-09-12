#!/usr/bin/env bun
/**
 * `obrew` — local AI models as a headless agent CLI.
 *
 * Dispatches on the first positional. Every command owns its own flags; this file owns the
 * exit codes: 0 success, 1 failure, 2 usage. `exec` reports failures as a `turn.failed`
 * event (json) or an `error:` line (text) and STILL exits 1, so a host can rely on either.
 */
import pkg from '../package.json' with { type: 'json' }
import { ObrewError, UsageError } from './shared/errors'
import { hookShutdown } from './shared/proc'
import { runAuth } from './cli/commands/auth'
import { runEmbed } from './cli/commands/embed'
import { runEngine } from './cli/commands/engine'
import { runExec } from './cli/commands/exec'
import { runLogin } from './cli/commands/login'
import { runModels } from './cli/commands/models'
import { runServe } from './cli/commands/serve'
import { runSessions } from './cli/commands/sessions'

const HELP = `obrew ${pkg.version} — local AI models as a headless agent CLI

Usage:
  obrew exec [resume <sessionId>] [--json] [options] "<prompt>"
  obrew auth status [--json]
  obrew login [--model <repo[:file]>] [--json]
  obrew models list|pull|rm|use [...]
  obrew engine install|status|start|stop [...]
  obrew serve [--host] [--port] [--model]
  obrew embed [--model <id>] [--query <text>] [--image <path>] <text …>
  obrew sessions list|show|rm [...]
  obrew --version

Run \`obrew <command> --help\` for the flags of one command.`

export async function main(argv: string[]): Promise<number> {
  hookShutdown()
  const [command, ...rest] = argv

  try {
    switch (command) {
      case undefined:
      case '--help':
      case '-h':
      case 'help':
        console.log(HELP)
        return 0
      case '--version':
      case '-v':
      case 'version':
        console.log(pkg.version)
        return 0
      case 'exec':
        return await runExec(rest)
      case 'auth':
        return await runAuth(rest)
      case 'login':
        return await runLogin(rest)
      case 'models':
        return await runModels(rest)
      case 'engine':
        return await runEngine(rest)
      case 'sessions':
        return await runSessions(rest)
      case 'serve':
        return await runServe(rest)
      case 'embed':
        return await runEmbed(rest)
      default:
        throw new UsageError(`unknown command "${command}"\n\n${HELP}`)
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`usage: ${err.message}`)
      return 2
    }
    if (err instanceof ObrewError) {
      console.error(`error (${err.code}): ${err.message}`)
      return 1
    }
    console.error(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    return 1
  }
}

// Unconditional, NOT `if (import.meta.main)`. In an executable produced by the `Bun.build`
// JS API with `compile` (Bun 1.4.0) `import.meta.main` is false — only the CLI form sets it —
// so a guarded entry point compiled fine, ran, printed nothing and exited 0. Nothing imports
// this module as a library; the commands live in ./cli/commands for that.
process.exitCode = await main(process.argv.slice(2))
