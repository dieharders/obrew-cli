/**
 * A stand-in for `llama-server`, speaking just enough of its HTTP API for the tests.
 *
 *   bun test/fixtures/fake-llama-server.ts -m <model> --port <n> [...ignored flags]
 *
 * Behaviour is steered by environment variables so a test can script it:
 *   FAKE_LOAD_MS=<n>       answer /health with 503 for the first n ms (model "loading")
 *   FAKE_EXIT_CODE=<n>     print a fatal line to stderr and exit n before listening
 *   FAKE_REPLY=<text>      the assistant text, streamed in 3-character chunks
 *   FAKE_REASONING=<text>  reasoning_content streamed before the reply
 *   FAKE_SLOW_MS=<n>       delay between chunks (for stall tests)
 *   FAKE_ECHO_LAST=1       reply with the text of the last message instead of FAKE_REPLY
 *   FAKE_TEMPLATE=<text>   what GET /props reports as chat_template
 *   FAKE_SCRIPT=<json>     an array of scripted replies, one per chat request in order (the
 *                          last repeats). Each: { text?, reasoning?, toolCalls?: [{name,
 *                          arguments}], finish? }. Overrides FAKE_REPLY / FAKE_REASONING.
 *   FAKE_LOG_REQUESTS=<p>  append every chat request body as a JSON line to this file
 *   FAKE_LINGER_MS=<n>     on SIGTERM close the listener but stay alive for n ms, leaving any
 *                          open keep-alive connection up and answering nothing on it — how
 *                          llama-server behaves while it tears down GPU buffers
 */
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const portIdx = argv.indexOf('--port')
const port = Number(argv[portIdx + 1] ?? 0)
const model = argv[argv.indexOf('-m') + 1] ?? 'fake'

const env = process.env
const exitCode = Number(env.FAKE_EXIT_CODE ?? '')
if (Number.isFinite(exitCode) && env.FAKE_EXIT_CODE) {
  process.stderr.write('fake: srv load_model: failed to load model\n')
  process.stderr.write('fake: error: unable to load model\n')
  process.exit(exitCode)
}

interface Scripted {
  text?: string
  reasoning?: string
  toolCalls?: Array<{ name: string; arguments: unknown }>
  finish?: string
}

const startedAt = Date.now()
const loadMs = Number(env.FAKE_LOAD_MS ?? 0)
const slowMs = Number(env.FAKE_SLOW_MS ?? 0)
const script: Scripted[] | null = env.FAKE_SCRIPT ? (JSON.parse(env.FAKE_SCRIPT) as Scripted[]) : null
let chatCalls = 0

process.stderr.write(`fake llama-server listening on ${port} model=${model}\n`)

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
  sse({ choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })

function* pieces(text: string, size = 3): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

interface ChatBody {
  messages?: Array<{ role: string; content: unknown }>
  response_format?: unknown
  json_schema?: unknown
  grammar?: unknown
  tools?: unknown[]
}

function replyFor(body: ChatBody): Scripted {
  if (script) return script[Math.min(chatCalls - 1, script.length - 1)]!
  const constrained = body.response_format !== undefined || body.json_schema !== undefined || body.grammar !== undefined
  let text = env.FAKE_REPLY ?? 'Hello from the fake engine.'
  if (env.FAKE_ECHO_LAST === '1') {
    const last = body.messages?.at(-1)
    text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  }
  return { text, reasoning: constrained ? undefined : env.FAKE_REASONING }
}

async function streamChat(body: ChatBody): Promise<Response> {
  chatCalls++
  if (env.FAKE_LOG_REQUESTS) appendFileSync(env.FAKE_LOG_REQUESTS, JSON.stringify(body) + '\n')
  const scripted = replyFor(body)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s))
      if (scripted.reasoning) {
        for (const p of pieces(scripted.reasoning)) {
          send(chunk({ reasoning_content: p }))
          if (slowMs) await Bun.sleep(slowMs)
        }
      }
      if (scripted.toolCalls?.length) {
        scripted.toolCalls.forEach((c, index) => {
          const args = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments)
          send(chunk({ tool_calls: [{ index, id: `call_${chatCalls}_${index}`, type: 'function', function: { name: c.name, arguments: '' } }] }))
          for (const p of pieces(args, 8)) send(chunk({ tool_calls: [{ index, function: { arguments: p } }] }))
        })
        send(chunk({}, scripted.finish ?? 'tool_calls', { prompt_tokens: 10, completion_tokens: 5 }))
      } else {
        const text = scripted.text ?? ''
        for (const p of pieces(text)) {
          send(chunk({ content: p }))
          if (slowMs) await Bun.sleep(slowMs)
        }
        send(chunk({}, scripted.finish ?? 'stop', { prompt_tokens: 10, completion_tokens: text.length }))
      }
      send('data: [DONE]\n\n')
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

const lingerMs = Number(env.FAKE_LINGER_MS ?? 0)
let stopping = false

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 60,
  async fetch(req) {
    // A request that arrives on a kept-alive connection after the listener closed: accepted,
    // never answered (llama-server's task queue is already stopped by then).
    if (stopping) return new Promise<Response>(() => {})
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      if (Date.now() - startedAt < loadMs) return new Response('{"error":{"message":"Loading model"}}', { status: 503 })
      return new Response('{"status":"ok"}')
    }
    if (url.pathname === '/props') {
      return Response.json({
        model_path: model,
        chat_template:
          env.FAKE_TEMPLATE ?? '{% for message in messages %}{{ message.content }}{% endfor %}{% if tools %}{{ tools }}{% endif %}',
        default_generation_settings: { n_ctx: 4096 },
      })
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return streamChat((await req.json()) as ChatBody)
    }
    if (url.pathname.startsWith('/slots/') && req.method === 'POST') {
      process.stderr.write('fake: slot erased\n')
      return Response.json({ ok: true })
    }
    if (url.pathname === '/embeddings' && req.method === 'POST') {
      const body = (await req.json()) as { content?: string }
      const n = (body.content ?? '').length
      return Response.json({ embedding: [n, 1, 0] })
    }
    return new Response('not found', { status: 404 })
  },
})

if (lingerMs > 0) {
  process.on('SIGTERM', () => {
    stopping = true
    server.stop() // the listener only; open connections stay open
    setTimeout(() => process.exit(0), lingerMs)
  })
}
