import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_SERVER, tempHome } from '../../test/fixtures/home'
import { saveRegistry } from '../models/registry'
import { saveConfig } from '../shared/config'
import { chunkText, sentences } from './chunk'
import { EmbeddingEngine } from './engine'
import { EmbeddingIndex, cosine, normalise } from './index'

describe('EmbeddingIndex', () => {
  test('ranks by cosine similarity, best first', () => {
    const index = new EmbeddingIndex<string>()
    index.add('a', [1, 0, 0], 'x axis')
    index.add('b', [0, 1, 0], 'y axis')
    index.add('c', [0.9, 0.1, 0], 'near x')
    const hits = index.search([1, 0.05, 0], 2)
    expect(hits.map((h) => h.id)).toEqual(['a', 'c'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
    expect(hits[0]!.meta).toBe('x axis')
    expect(index.remove('a')).toBe(true)
    expect(index.search([1, 0, 0], 1)[0]!.id).toBe('c')
    expect(() => index.add('bad', [1, 2])).toThrow(/dimension/)
  })

  test('normalise and cosine', () => {
    const v = normalise([3, 4])
    expect(cosine(v, v)).toBeCloseTo(1)
    expect(cosine(normalise([1, 0]), normalise([0, 1]))).toBeCloseTo(0)
  })
})

describe('chunkText', () => {
  test('short text is one chunk; long text splits on sentences within the limit', () => {
    expect(chunkText('Hello there.', 100)).toEqual([{ text: 'Hello there.', start: 0 }])
    const text = 'One sentence here. Another sentence follows. A third one ends it. Then a fourth.'
    const chunks = chunkText(text, 45)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(45)
    expect(chunks.map((c) => c.text).join('')).toBe(text)
    expect(text.slice(chunks[1]!.start, chunks[1]!.start + 5)).toBe(chunks[1]!.text.slice(0, 5))
  })

  test('paragraphs are kept apart; an oversized sentence is split hard', () => {
    const chunks = chunkText('Para one.\n\nPara two.', 12)
    expect(chunks.map((c) => c.text)).toEqual(['Para one.', 'Para two.'])
    const long = chunkText('x'.repeat(30) + ' ' + 'y'.repeat(30), 10)
    expect(long.every((c) => c.text.length <= 10)).toBe(true)
    expect(sentences('A. B.').length).toBe(2)
  })
})

describe('EmbeddingEngine', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
    process.env.OBREW_LLAMA_SERVER = FAKE_SERVER
    const dir = join(home.dir, 'models', 'o--e')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'e.gguf'), 'GGUF')
    await writeFile(join(dir, 'mmproj.gguf'), 'GGUF')
    await writeFile(join(home.dir, 'pic.png'), Buffer.from([1, 2, 3]))
    await saveRegistry({
      version: 1,
      default: null,
      models: [
        { id: 'o/e:e.gguf', repoId: 'o/e', file: 'e.gguf', path: join(dir, 'e.gguf'), mmprojPath: null, sizeBytes: 4, addedAt: '' },
        { id: 'o/e:v.gguf', repoId: 'o/e', file: 'v.gguf', path: join(dir, 'e.gguf'), mmprojPath: join(dir, 'mmproj.gguf'), sizeBytes: 4, addedAt: '' },
      ],
    })
  })
  afterEach(async () => {
    delete process.env.OBREW_LLAMA_SERVER
    await home.cleanup()
  })

  test('uses config.embedModel, starts the server lazily, embeds, closes', async () => {
    await saveConfig({ embedModel: 'o/e:e.gguf' })
    const engine = await EmbeddingEngine.open(undefined)
    expect(engine.model.id).toBe('o/e:e.gguf')
    // The fake answers [length, 1, 0].
    expect(await engine.embed('hello')).toEqual([5, 1, 0])
    expect(await engine.embedMany(['a', 'bbb'])).toEqual([[1, 1, 0], [3, 1, 0]])
    await expect(engine.embedImage(join(home.dir, 'pic.png'))).rejects.toMatchObject({ code: 'bad_request' })
    await engine.close()
  })

  test('no embedding model configured is model_missing; a vision model embeds images', async () => {
    await expect(EmbeddingEngine.open(undefined)).rejects.toMatchObject({ code: 'model_missing' })
    const engine = await EmbeddingEngine.open('o/e:v.gguf')
    const vec = await engine.embedImage(join(home.dir, 'pic.png'), 'describe')
    expect(vec).toHaveLength(3)
    await engine.close()
  })
})
