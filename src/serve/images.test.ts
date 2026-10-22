/**
 * `obrew serve`'s `POST /v1/images/generations` against the fake sd-server: the OpenAI-shaped
 * answer, the streamed `image.*` events, request validation, and failure codes as HTTP statuses.
 * The warm engine here is detached, so nothing below relies on FAKE_* variables (a process WMI
 * creates on Windows does not inherit them): the fake's defaults are enough.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FAKE_SD_SERVER, tempHome } from '../../test/fixtures/home'
import { seedImageModels } from '../../test/fixtures/image-home'
import { stopAllImageEngines } from '../image/engine/shared'
import { decodePng } from '../image/png'
import { ObrewServer } from './server'

describe('obrew serve: /v1/images/generations', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ObrewServer
  let base: string

  beforeEach(async () => {
    home = await tempHome()
    process.env.OBREW_SD_SERVER = FAKE_SD_SERVER
    process.env.OBREW_GPU_BUDGET_GIB = '24'
    server = new ObrewServer({ host: '127.0.0.1', port: 0, idleTtlMs: 60_000 })
    await server.start()
    base = `http://127.0.0.1:${server.port}`
  })
  afterEach(async () => {
    await server.stop()
    await stopAllImageEngines()
    delete process.env.OBREW_SD_SERVER
    delete process.env.OBREW_GPU_BUDGET_GIB
    await home.cleanup()
  })

  const post = (body: unknown) =>
    fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('no image model installed → 404 model_missing; a bad body → 400', async () => {
    const missing = await post({ prompt: 'a cat' })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { type: string } }).error.type).toBe('model_missing')
    expect((await post({})).status).toBe(400)
    expect((await post({ prompt: 'x', n: 9 })).status).toBe(400)
    expect((await post({ prompt: 'x', size: 'huge' })).status).toBe(400)
    expect((await post({ prompt: 'x', response_format: 'url' })).status).toBe(400)
  })

  test('returns data[].b64_json at the size asked for, n images with seeds', async () => {
    await seedImageModels()
    const res = await post({ prompt: 'a lighthouse', size: '512x512', n: 2, seed: 9 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ b64_json: string; seed: number; width: number; height: number }> }
    expect(body.data.map((d) => d.seed)).toEqual([9, 10])
    const img = decodePng(new Uint8Array(Buffer.from(body.data[0]!.b64_json, 'base64')))
    expect(`${img.width}x${img.height}`).toBe('512x512')
  })

  test('stream: true answers with image.* events over SSE', async () => {
    await seedImageModels()
    const res = await post({ prompt: 'a lighthouse', aspect: '16:9', stream: true })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const types = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => (JSON.parse(f.slice(6)) as { type: string }).type)
    expect(types).toContain('image.started')
    expect(types).toContain('image.saved')
    expect(types.at(-1)).toBe('image.completed')
  })

  test('/obrew/status reports image readiness', async () => {
    await seedImageModels()
    const status = (await (await fetch(`${base}/obrew/status`)).json()) as { image: { ready: boolean } }
    expect(status.image.ready).toBe(true)
  })
})
