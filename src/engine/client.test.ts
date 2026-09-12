import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { EngineClient, extractEmbedding } from './client'

describe('extractEmbedding', () => {
  test('object with vector', () => expect(extractEmbedding({ embedding: [1, 2] })).toEqual([1, 2]))
  test('array of objects', () => expect(extractEmbedding([{ embedding: [3] }])).toEqual([3]))
  test('bare vector', () => expect(extractEmbedding([4, 5])).toEqual([4, 5]))
  test('per-token rows are mean-pooled', () => {
    expect(extractEmbedding({ embedding: [[1, 3], [3, 5]] })).toEqual([2, 4])
  })
  test('garbage is null', () => expect(extractEmbedding({ nope: 1 })).toBeNull())
})

describe('EngineClient.chat', () => {
  let server: ReturnType<typeof Bun.serve>
  let lastBody: Record<string, unknown> = {}
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/health') return new Response('ok')
        if (url.pathname === '/v1/chat/completions') {
          lastBody = (await req.json()) as Record<string, unknown>
          const body =
            sse({ choices: [{ delta: { reasoning_content: 'hm' }, finish_reason: null }] }) +
            sse({ choices: [{ delta: { content: 'Hel' }, finish_reason: null }] }) +
            ': keepalive\n\n' +
            sse({ choices: [{ delta: { content: 'lo' }, finish_reason: null }] }) +
            sse({
              choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"p' } }] }, finish_reason: null }],
            }) +
            sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ath":1}' } }] }, finish_reason: null }] }) +
            sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }) +
            'data: [DONE]\n\n' +
            sse({ choices: [{ delta: { content: 'IGNORED' } }] })
          return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
        }
        if (url.pathname === '/boom') return new Response('bad', { status: 500 })
        return new Response('nf', { status: 404 })
      },
    })
  })
  afterAll(() => server.stop(true))

  test('normalises deltas, stops at [DONE], forces streaming on', async () => {
    const client = new EngineClient(`http://127.0.0.1:${server.port}`)
    const deltas = []
    for await (const d of client.chat({ messages: [], stream: false }, new AbortController().signal)) deltas.push(d)
    expect(lastBody.stream).toBe(true)
    expect(lastBody.stream_options).toEqual({ include_usage: true })
    expect(deltas[0]).toEqual({ reasoning: 'hm' })
    expect(deltas[1]).toEqual({ content: 'Hel' })
    expect(deltas[2]).toEqual({ content: 'lo' })
    expect(deltas[3]).toEqual({ toolCalls: [{ index: 0, id: 'c1', name: 'Read', arguments: '{"p' }] })
    expect(deltas[4]).toEqual({ toolCalls: [{ index: 0, arguments: 'ath":1}' }] })
    expect(deltas[5]).toEqual({ finishReason: 'tool_calls', usage: { promptTokens: 3, completionTokens: 4 } })
    expect(deltas).toHaveLength(6)
  })

  test('health reports ok', async () => {
    expect(await new EngineClient(`http://127.0.0.1:${server.port}`).health()).toBe('ok')
    expect(await new EngineClient('http://127.0.0.1:1').health()).toBe('down')
  })
})
