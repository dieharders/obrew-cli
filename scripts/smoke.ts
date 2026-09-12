/**
 * The manual end-to-end check, against the REAL engine and a small real model:
 *
 *   bun run smoke                # from source
 *   OBREW_BIN=./obrew.exe bun run smoke   # against a built binary
 *
 * Installs the engine if missing, pulls a ~400 MB model if missing, then runs `exec`, a
 * resume, a tool call and a structured answer, printing one line per step. Exit 1 on the
 * first failure. Network and disk are used; nothing outside the obrew data dir is touched.
 */
const MODEL = process.env.OBREW_SMOKE_MODEL ?? 'unsloth/Qwen3-0.6B-GGUF:Qwen3-0.6B-Q4_K_M.gguf'
const bin = process.env.OBREW_BIN
const argv0 = bin ? [bin] : [process.execPath, 'src/main.ts']

async function obrew(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...argv0, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, stdout, stderr }
}

function events(stdout: string): Array<Record<string, unknown>> {
  return stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
}

function step(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) process.exit(1)
}

const status = JSON.parse((await obrew(['auth', 'status', '--json'])).stdout) as { engine: { installed: boolean }; model: { installed: boolean } }
if (!status.engine.installed) {
  const r = await obrew(['engine', 'install'])
  step('engine install', r.code === 0, r.stderr.trim().split('\n').at(-1))
} else step('engine present', true)

const pulled = await obrew(['models', 'pull', MODEL])
step(`model ${MODEL}`, pulled.code === 0, pulled.stderr.trim().split('\n').at(-1))
await obrew(['models', 'use', MODEL])

const t0 = Date.now()
const first = await obrew(['exec', '--json', '--model', MODEL, 'Reply with exactly: smoke one'])
const ev1 = events(first.stdout)
const session = ev1.find((e) => e.type === 'session') as { sessionId: string } | undefined
const text1 = ev1.filter((e) => e.type === 'delta').map((e) => e.text).join('')
step('exec', first.code === 0 && !!session, `${Date.now() - t0} ms → ${JSON.stringify(text1)}`)

const t1 = Date.now()
const second = await obrew(['exec', 'resume', session!.sessionId, '--json', '--model', MODEL, 'Repeat your previous reply.'])
const done2 = events(second.stdout).at(-1) as { type: string; sessionId?: string }
step('exec resume (warm engine)', second.code === 0 && done2.sessionId === session!.sessionId, `${Date.now() - t1} ms`)

const third = await obrew(['exec', '--json', '--model', MODEL, '--cwd', '.', 'Use the Glob tool to list the .md files here, then say how many there are.'])
const ev3 = events(third.stdout)
step('tool loop', third.code === 0, `tools: ${ev3.filter((e) => e.type === 'tool.start').map((e) => e.name).join(', ') || '(model chose none)'}`)

const fourth = await obrew(['exec', '--json', '--model', MODEL, '--tools', 'none', '--output-schema', '{"type":"object","properties":{"answer":{"type":"integer"}},"required":["answer"]}', 'What is 6 times 7?'])
const done4 = events(fourth.stdout).at(-1) as { output?: unknown }
step('output schema', fourth.code === 0 && done4.output !== undefined, JSON.stringify(done4.output))

await obrew(['engine', 'stop'])
step('engine stop', true)
