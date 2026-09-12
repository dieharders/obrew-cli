/**
 * WebSearch — DuckDuckGo's HTML endpoint, parsed with HTMLRewriter. Port of the fetch and
 * rate-limit parts of obrew-engine's `search/providers/web.py` (which used the `ddgs`
 * package); the agentic harness around it was not kept.
 *
 * Not in the default tool set: a host that wants it passes `--tools Read,Grep,Glob,WebSearch`.
 * `OBREW_SEARCH_URL` points at another DuckDuckGo-HTML-compatible endpoint (a mirror, or a
 * test server).
 */
import type { Tool } from './types'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const MIN_GAP_MS = 500
const UA = 'Mozilla/5.0 (compatible; obrew/0.1; +https://openbrew.ai)'
let lastCall = 0

const searchBase = () => (process.env.OBREW_SEARCH_URL ?? 'https://html.duckduckgo.com').replace(/\/$/, '')

/** DuckDuckGo wraps result links as `//duckduckgo.com/l/?uddg=<encoded target>`. */
export function unwrapUrl(href: string): string {
  try {
    const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com')
    const target = u.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : u.toString()
  } catch {
    return href
  }
}

export async function searchWeb(query: string, maxResults = 5, signal?: AbortSignal): Promise<SearchResult[]> {
  const wait = lastCall + MIN_GAP_MS - Date.now()
  if (wait > 0) await Bun.sleep(wait)
  lastCall = Date.now()

  const res = await fetch(`${searchBase()}/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal,
  })
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`)

  const results: SearchResult[] = []
  let current: SearchResult | null = null
  const rewriter = new HTMLRewriter()
    .on('a.result__a', {
      element(el) {
        current = { title: '', url: unwrapUrl(el.getAttribute('href') ?? ''), snippet: '' }
        results.push(current)
      },
      text(chunk) {
        if (current) current.title += chunk.text
      },
    })
    .on('a.result__snippet, div.result__snippet', {
      text(chunk) {
        const last = results.at(-1)
        if (last) last.snippet += chunk.text
      },
    })
  await rewriter.transform(res).text()

  return results
    .map((r) => ({ title: r.title.trim(), url: r.url, snippet: r.snippet.replace(/\s+/g, ' ').trim() }))
    .filter((r) => r.title && r.url)
    .slice(0, maxResults)
}

export const webSearchTool: Tool = {
  name: 'WebSearch',
  description: 'Search the web. Returns titles, URLs and snippets for the top results.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms' },
      maxResults: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  async execute(args, ctx) {
    try {
      const results = await searchWeb(String(args.query), typeof args.maxResults === 'number' ? args.maxResults : 5, ctx.signal)
      if (results.length === 0) return { content: 'No results.' }
      return { content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n') }
    } catch (err) {
      return { content: `search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
