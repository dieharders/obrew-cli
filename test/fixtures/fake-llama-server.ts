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
 *   FAKE_TOOL_CALLS=<json> a JSON array of {name, arguments} emitted as tool_calls on the
 *                          FIRST chat request; later requests get FAKE_REPLY
 *   FAKE_SLOW_MS=<n>       delay between chunks (for stall tests)
 *   FAKE_ECHO_LAST=1       reply with the text of the last message instead of FAKE_REPLY
 *   FAKE_JSON_REPLY=<json> when the request carries response_format / json_schema, stream this
 */
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

const startedAt = Date.now()
const loadMs = Number(env.FAKE_LOAD_MS ?? 0)
const slowMs = Number(env.FAKE_SLOW_MS ?? 0)
let chatCalls = 0

process.stderr.write(`fake llama-server listening on ${port} model=${model}\n`)

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
  sse({
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })

function* pieces(text: string, size = 3): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

async function streamChat(body: {
  messages?: Array<{ role: string; content: unknown }>
  response_format?: unknown
  json_schema?: unknown
  grammar?: unknown
  tools?: unknown[]
}): Promise<Response> {
  chatCalls++
  const constrained = body.response_format !== undefined || body.json_schema !== undefined || body.grammar !== undefined
  const toolScript = env.FAKE_TOOL_CALLS && chatCalls === 1 && Array.isArray(body.tools) ? JSON.parse(env.FAKE_TOOL_CALLS) : null

  let reply = env.FAKE_REPLY ?? 'Hello from the fake engine.'
  if (constrained && env.FAKE_JSON_REPLY) reply = env.FAKE_JSON_REPLY
  if (env.FAKE_ECHO_LAST === '1') {
    const last = body.messages?.at(-1)
    reply = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s))
      if (env.FAKE_REASONING && !constrained) {
        for (const p of pieces(env.FAKE_REASONING)) {
          send(chunk({ reasoning_content: p }))
          if (slowMs) await Bun.sleep(slowMs)
        }
      }
      if (toolScript) {
        const calls = toolScript as Array<{ name: string; arguments: unknown }>
        calls.forEach((c, index) => {
          const args = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments)
          send(chunk({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: c.name, arguments: '' } }] }))
          for (const p of pieces(args, 8)) send(chunk({ tool_calls: [{ index, function: { arguments: p } }] }))
        })
        send(chunk({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5 }))
      } else {
        for (const p of pieces(reply)) {
          send(chunk({ content: p }))
          if (slowMs) await Bun.sleep(slowMs)
        }
        send(chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: reply.length }))
      }
      send('data: [DONE]\n\n')
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      if (Date.now() - startedAt < loadMs) return new Response('{"error":{"message":"Loading model"}}', { status: 503 })
      return new Response('{"status":"ok"}')
    }
    if (url.pathname === '/props') {
      return Response.json({
        model_path: model,
        chat_template: env.FAKE_TEMPLATE ?? '{% for message in messages %}{{ message.content }}{% endfor %}{% if tools %}{{ tools }}{% endif %}',
        default_generation_settings: { n_ctx: 4096 },
      })
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return streamChat((await req.json()) as Parameters<typeof streamChat>[0])
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
