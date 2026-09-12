import { describe, expect, test } from 'bun:test'
import { readLines } from './ndjson'

/** A stream that hands out exactly the chunks given, so boundaries can be placed on purpose. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

const enc = (s: string) => new TextEncoder().encode(s)

async function collect(chunks: Uint8Array[]): Promise<string[]> {
  const out: string[] = []
  for await (const line of readLines(streamOf(chunks))) out.push(line)
  return out
}

describe('readLines', () => {
  test('splits complete lines', async () => {
    expect(await collect([enc('a\nb\nc\n')])).toEqual(['a', 'b', 'c'])
  })

  test('reassembles a line split across three chunks', async () => {
    expect(await collect([enc('{"ty'), enc('pe":"de'), enc('lta"}\n')])).toEqual([
      '{"type":"delta"}',
    ])
  })

  test('yields a final line with no trailing newline', async () => {
    expect(await collect([enc('a\nb')])).toEqual(['a', 'b'])
  })

  test('handles CRLF', async () => {
    expect(await collect([enc('a\r\nb\r\n')])).toEqual(['a', 'b'])
  })

  test('does not corrupt a multi-byte character split across a chunk boundary', async () => {
    const bytes = enc('{"text":"🌊"}\n')
    const cut = 10
    const lines = await collect([bytes.slice(0, cut), bytes.slice(cut)])

    expect(lines).toEqual(['{"text":"🌊"}'])
    expect(lines[0]).not.toContain('�')
  })

  test('skips blank lines and tolerates empty chunks', async () => {
    expect(await collect([enc('a\n\n\n'), enc(''), enc('b\n')])).toEqual(['a', 'b'])
  })

  test('an empty stream yields nothing', async () => {
    expect(await collect([])).toEqual([])
  })
})
