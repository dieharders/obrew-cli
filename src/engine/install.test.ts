import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempHome } from '../../test/fixtures/home'
import { tarBinary } from '../shared/download'
import { engineStatus, findEngine, installEngine } from './install'
import { assetNames, detectVariant, hostArch, hostPlatform } from './variant'
import { LLAMACPP_TAG } from './version'

/**
 * A fake GitHub release: the asset the host needs is a real archive (built with the system
 * tar) that contains a `llama-server` file nested the way the vendor's tarballs are.
 */
async function buildArchive(name: string): Promise<{ path: string; sha256: string; size: number }> {
  const work = join(tmpdir(), `obrew-rel-${Date.now()}`)
  const bin = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  await mkdir(join(work, 'src', 'build', 'bin'), { recursive: true })
  await writeFile(join(work, 'src', 'build', 'bin', bin), '#!/bin/sh\necho fake\n')
  await writeFile(join(work, 'src', 'build', 'bin', 'libggml.so'), 'lib')
  const archive = join(work, name)
  const flags = name.endsWith('.zip') ? ['-a', '-cf'] : ['-czf']
  const proc = Bun.spawn([tarBinary()!, ...flags, archive, '-C', join(work, 'src'), 'build'], { stdout: 'ignore', stderr: 'pipe' })
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text())
  const bytes = await Bun.file(archive).arrayBuffer()
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  return { path: archive, sha256, size: bytes.byteLength }
}

describe('installEngine', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  let server: ReturnType<typeof Bun.serve>
  const variant = 'cpu'
  const names = assetNames(LLAMACPP_TAG, variant, hostPlatform(), hostArch())!
  const archives = new Map<string, Awaited<ReturnType<typeof buildArchive>>>()

  beforeAll(async () => {
    for (const name of names) archives.set(name, await buildArchive(name))
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith(`/releases/tags/${LLAMACPP_TAG}`)) {
          return Response.json({
            assets: [...archives.entries()].map(([name, a]) => ({
              name,
              browser_download_url: `http://127.0.0.1:${server.port}/dl/${name}`,
              size: a.size,
              digest: `sha256:${a.sha256}`,
            })),
          })
        }
        if (url.pathname.startsWith('/dl/')) {
          const a = archives.get(url.pathname.slice(4))
          return a ? new Response(Bun.file(a.path)) : new Response('nf', { status: 404 })
        }
        return new Response('nf', { status: 404 })
      },
    })
    process.env.OBREW_RELEASE_API = `http://127.0.0.1:${server.port}`
  })
  afterAll(() => {
    server.stop(true)
    delete process.env.OBREW_RELEASE_API
  })
  beforeEach(async () => {
    home = await tempHome()
  })
  afterEach(() => home.cleanup())

  test('downloads, verifies, unpacks, finds the nested binary and records it', async () => {
    const logs: string[] = []
    const record = await installEngine({ variant, signal: new AbortController().signal, onLog: (m) => logs.push(m) })
    expect(record.tag).toBe(LLAMACPP_TAG)
    expect(record.variant).toBe(variant)
    expect(record.binary).toContain(join('build', 'bin'))
    expect(await Bun.file(record.binary).exists()).toBe(true)
    expect(logs.some((l) => l.startsWith('downloading'))).toBe(true)

    const found = await findEngine({ variant })
    expect(found?.binary).toBe(record.binary)
    const status = await engineStatus({ variant })
    expect(status.installed).toBe(true)
  })

  test('nothing installed → status says so with the detected variant', async () => {
    const status = await engineStatus({})
    expect(status.installed).toBe(false)
    expect(status.variant).toBe(detectVariant())
    expect(status.tag).toBe(LLAMACPP_TAG)
  })

  test('a wrong OBREW_LLAMA_SERVER is a hard failure', async () => {
    process.env.OBREW_LLAMA_SERVER = join(home.dir, 'nope')
    try {
      await expect(findEngine({})).rejects.toMatchObject({ code: 'engine_missing' })
    } finally {
      delete process.env.OBREW_LLAMA_SERVER
    }
  })
})
