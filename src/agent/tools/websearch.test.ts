import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { searchWeb, unwrapUrl, webSearchTool } from './websearch'

const PAGE = `<html><body><div id="links">
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Example <b>A</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First   snippet
  text.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://direct.example.org/b">Direct B</a></h2>
  <div class="result__snippet">Second snippet.</div>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fc">Third</a></h2>
</div>
</div></body></html>`

describe('WebSearch', () => {
  let server: ReturnType<typeof Bun.serve>
  const queries: string[] = []
  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== '/html/') return new Response('nf', { status: 404 })
        queries.push(url.searchParams.get('q') ?? '')
        if (url.searchParams.get('q') === 'boom') return new Response('down', { status: 503 })
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
      },
    })
    process.env.OBREW_SEARCH_URL = `http://127.0.0.1:${server.port}`
  })
  afterAll(() => {
    server.stop(true)
    delete process.env.OBREW_SEARCH_URL
  })

  test('unwrapUrl decodes DuckDuckGo redirects and leaves direct links alone', () => {
    expect(unwrapUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x')).toBe('https://example.com/a')
    expect(unwrapUrl('https://direct.example.org/b')).toBe('https://direct.example.org/b')
  })

  test('parses titles, targets and snippets; honours maxResults', async () => {
    const results = await searchWeb('bun runtime', 2)
    expect(queries.at(-1)).toBe('bun runtime')
    expect(results).toEqual([
      { title: 'Example A', url: 'https://example.com/a', snippet: 'First snippet text.' },
      { title: 'Direct B', url: 'https://direct.example.org/b', snippet: 'Second snippet.' },
    ])
    expect(await searchWeb('x', 10)).toHaveLength(3)
  })

  test('the tool renders results and reports failures as error results', async () => {
    const ctx = { cwd: '.', signal: new AbortController().signal }
    const ok = await webSearchTool.execute({ query: 'anything', maxResults: 1 }, ctx)
    expect(ok.isError).toBeUndefined()
    expect(ok.content).toContain('1. Example A')
    expect(ok.content).toContain('https://example.com/a')
    const bad = await webSearchTool.execute({ query: 'boom' }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.content).toMatch(/HTTP 503/)
  })
})
