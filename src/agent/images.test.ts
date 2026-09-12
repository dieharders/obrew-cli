import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imagePart, transcriptContent, userContent } from './images'

describe('images', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'obrew-img-'))
    await writeFile(join(dir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(dir, 'x.txt'), 'nope')
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  test('a png becomes a base64 data URL part', async () => {
    const part = await imagePart(join(dir, 'a.png'))
    expect(part.type).toBe('image_url')
    expect(part.image_url.url).toBe('data:image/png;base64,iVBORw==')
  })

  test('missing files and unsupported types are bad_request', async () => {
    await expect(imagePart(join(dir, 'none.png'))).rejects.toMatchObject({ code: 'bad_request' })
    await expect(imagePart(join(dir, 'x.txt'))).rejects.toMatchObject({ code: 'bad_request' })
  })

  test('content puts images before the text; the transcript keeps markers', async () => {
    const part = await imagePart(join(dir, 'a.png'))
    expect(userContent('what is this', [])).toBe('what is this')
    expect(userContent('what is this', [part])).toEqual([part, { type: 'text', text: 'what is this' }])
    expect(transcriptContent('what is this', ['/p/a.png'])).toBe('[image: /p/a.png]\nwhat is this')
  })
})
