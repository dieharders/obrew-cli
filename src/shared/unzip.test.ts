/**
 * extractZip against archives from test/fixtures/zip.ts. Writer and reader were written
 * together and could share a misreading of the format, so where the host has the tools both
 * are also graded by outsiders: the fixture's archives must pass the system `unzip -t` and
 * bsdtar, and archives that bsdtar (data descriptors: zero sizes in local headers) and Info-ZIP
 * `zip` write must come out of extractZip intact.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeZip, type ZipEntry, type ZipOptions } from '../../test/fixtures/zip'
import { extractArchive, tarBinary } from './download'
import { extractZip } from './unzip'

const posix = process.platform !== 'win32'
const text = (s: string) => new TextEncoder().encode(s)
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

/** A `tar` that reads zip, which means bsdtar: GNU tar, the Linux `tar`, cannot. */
function findBsdtar(): string | null {
  for (const tar of [Bun.which('bsdtar'), tarBinary()]) {
    if (tar && `${Bun.spawnSync([tar, '--version']).stdout}`.includes('bsdtar')) return tar
  }
  return null
}
const UNZIP = Bun.which('unzip')
const ZIP = Bun.which('zip')
const BSDTAR = findBsdtar()

/** Deterministic bytes with both literals and repeats in them, so deflate does real work. */
function sample(size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = 0x9e3779b9
  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    // Every other 64-byte run repeats bytes from 1000 back; the rest are random letters.
    out[i] = (i >> 6) & 1 && i >= 1000 ? out[i - 1000]! : 97 + ((x >>> 8) % 26)
  }
  return out
}

let dir: string
beforeEach(async () => {
  // Real path, as in fixtures/home.ts: `tmpdir()` is a symlink on macOS.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'obrew-unzip-')))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write `entries` with the fixture writer and unpack them into a fresh `out` directory. */
async function roundTrip(entries: ZipEntry[], opts?: ZipOptions): Promise<string> {
  const archive = join(dir, 'test.zip')
  await writeZip(archive, entries, opts)
  const out = join(dir, 'out')
  await extractZip(archive, out)
  return out
}

/** Overwrite a 16-bit field of a one-entry archive in its local and its central header. */
async function patchField(archive: string, localAt: number, centralAt: number, value: number) {
  const bytes = await readFile(archive)
  bytes.writeUInt16LE(value, localAt)
  bytes.writeUInt16LE(value, bytes.indexOf('PK\x01\x02') + centralAt)
  await writeFile(archive, bytes)
}

/** A release-like tree: nested directories, an executable, a library and its link, an empty file. */
async function makeTree(root: string): Promise<void> {
  const bin = join(root, 'build', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'sd-server'), '#!/bin/sh\necho sd\n')
  await writeFile(join(bin, 'libsd.so.1'), sample(300_000))
  await writeFile(join(root, 'build', 'empty'), '')
  if (posix) {
    await chmod(join(bin, 'sd-server'), 0o755)
    await symlink('libsd.so.1', join(bin, 'libsd.so'))
  }
}

async function expectTree(root: string): Promise<void> {
  const bin = join(root, 'build', 'bin')
  expect(await readFile(join(bin, 'sd-server'), 'utf8')).toBe('#!/bin/sh\necho sd\n')
  expect(Buffer.compare(await readFile(join(bin, 'libsd.so.1')), sample(300_000))).toBe(0)
  expect((await stat(join(root, 'build', 'empty'))).size).toBe(0)
  if (posix) {
    expect((await stat(join(bin, 'sd-server'))).mode & 0o777).toBe(0o755)
    expect(await readlink(join(bin, 'libsd.so'))).toBe('libsd.so.1')
  }
}

describe('extractZip', () => {
  test('unpacks stored and deflated entries', async () => {
    const out = await roundTrip([
      { name: 'stored.txt', data: text('kept as is'), method: 0 },
      { name: 'deflated.txt', data: text('squeezed '.repeat(200)), method: 8 },
    ])
    expect(await readFile(join(out, 'stored.txt'), 'utf8')).toBe('kept as is')
    expect(await readFile(join(out, 'deflated.txt'), 'utf8')).toBe('squeezed '.repeat(200))
  })

  test('creates nested directories, with or without entries of their own', async () => {
    const out = await roundTrip([
      { name: 'build/' },
      { name: 'build/bin/' },
      { name: 'build/bin/sd-server', data: text('bin') },
      { name: 'implicit/parents/file.txt', data: text('deep') },
      { name: 'empty-dir/' },
      { name: './dot/./double//slash.txt', data: text('dots') },
      { name: 'windows\\style\\name.txt', data: text('backslashes') },
    ])
    expect(await readFile(join(out, 'build', 'bin', 'sd-server'), 'utf8')).toBe('bin')
    expect(await readFile(join(out, 'implicit', 'parents', 'file.txt'), 'utf8')).toBe('deep')
    expect((await stat(join(out, 'empty-dir'))).isDirectory()).toBe(true)
    expect(await readFile(join(out, 'dot', 'double', 'slash.txt'), 'utf8')).toBe('dots')
    expect(await readFile(join(out, 'windows', 'style', 'name.txt'), 'utf8')).toBe('backslashes')
  })

  test.skipIf(!posix)('applies Unix modes, so the exec bit survives', async () => {
    const out = await roundTrip([
      { name: 'bin/', mode: 0o750 },
      { name: 'bin/sd-server', data: text('#!/bin/sh\n'), mode: 0o755 },
      { name: 'bin/notes.txt', data: text('n'), mode: 0o644 },
      { name: 'bin/private', data: text('p'), mode: 0o600 },
    ])
    const mode = async (name: string) => (await stat(join(out, 'bin', name))).mode & 0o777
    expect(await mode('sd-server')).toBe(0o755)
    expect(await mode('notes.txt')).toBe(0o644)
    expect(await mode('private')).toBe(0o600)
    expect((await stat(join(out, 'bin'))).mode & 0o777).toBe(0o750)
  })

  test.skipIf(!posix)('creates symlinks, and refuses targets outside the destination', async () => {
    const out = await roundTrip([
      { name: 'lib/libsd.so.1', data: text('library') },
      { name: 'lib/libsd.so', symlink: 'libsd.so.1' },
      { name: 'lib/via-parent', symlink: '../lib/libsd.so.1', method: 0 },
    ])
    expect((await lstat(join(out, 'lib', 'libsd.so'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(out, 'lib', 'libsd.so'))).toBe('libsd.so.1')
    expect(await readFile(join(out, 'lib', 'libsd.so'), 'utf8')).toBe('library')
    expect(await readFile(join(out, 'lib', 'via-parent'), 'utf8')).toBe('library')

    const archive = join(dir, 'escape.zip')
    for (const target of ['../../outside', '/etc/passwd']) {
      await writeZip(archive, [{ name: 'lib/evil', symlink: target }])
      await expect(extractZip(archive, join(dir, 'escape'))).rejects.toThrow('refusing symlink')
      expect(await exists(join(dir, 'escape', 'lib', 'evil'))).toBe(false)
    }
  })

  test.skipIf(!posix)('replaces a symlink in the way instead of writing through it', async () => {
    const out = join(dir, 'out')
    const elsewhere = join(dir, 'elsewhere')
    await mkdir(out)
    await mkdir(elsewhere)
    // As if an earlier archive unpacked into the same directory had left these behind.
    await symlink(join(elsewhere, 'victim'), join(out, 'linked-file'))
    await symlink(elsewhere, join(out, 'linked-dir'))
    const archive = join(dir, 'over.zip')

    await writeZip(archive, [{ name: 'linked-file', data: text('new') }])
    await extractZip(archive, out)
    expect((await lstat(join(out, 'linked-file'))).isFile()).toBe(true)
    expect(await readFile(join(out, 'linked-file'), 'utf8')).toBe('new')

    await writeZip(archive, [{ name: 'linked-dir/planted.txt', data: text('x') }])
    await expect(extractZip(archive, out)).rejects.toThrow('not a directory')
    expect(await readdir(elsewhere)).toEqual([])
  })

  test('refuses zip-slip names before writing anything', async () => {
    const names = [
      '../evil.txt',
      'a/../../evil.txt',
      './../evil.txt',
      '/tmp/evil.txt',
      'C:/evil.txt',
      'C:evil.txt',
      '..\\evil.txt',
      'a\\..\\..\\evil.txt',
      '\\\\server\\share\\evil.txt',
    ]
    const archive = join(dir, 'slip.zip')
    const out = join(dir, 'nested', 'out')
    for (const name of names) {
      await writeZip(archive, [
        { name: 'ok.txt', data: text('ok') },
        { name, data: text('evil') },
      ])
      await expect(extractZip(archive, out)).rejects.toThrow('refusing zip entry')
    }
    // Names are checked up front, so not even the harmless first entry was written.
    expect(await exists(out)).toBe(false)
    expect((await readdir(dir, { recursive: true })).filter((p) => p.includes('evil'))).toEqual([])
  })

  test('round-trips a ~5 MB deflated entry byte for byte', async () => {
    const data = sample(5 * 1024 * 1024 + 7)
    const out = await roundTrip([{ name: 'model.bin', data, method: 8 }])
    const back = await readFile(join(out, 'model.bin'))
    expect(back.byteLength).toBe(data.byteLength)
    expect(Buffer.compare(back, data)).toBe(0)
  })

  test('unpacks empty files, stored or deflated', async () => {
    const out = await roundTrip([
      { name: 'stored', data: new Uint8Array(0), method: 0 },
      { name: 'deflated', data: new Uint8Array(0), method: 8 },
      { name: 'no-data' },
    ])
    for (const name of ['stored', 'deflated', 'no-data']) {
      const st = await stat(join(out, name))
      expect(st.isFile() && st.size).toBe(0)
    }
  })

  test('refuses an unsupported compression method, or an encrypted entry', async () => {
    const archive = join(dir, 'odd.zip')
    const out = join(dir, 'out')
    await writeZip(archive, [{ name: 'a.txt', data: text('a'), method: 0 }])
    await patchField(archive, 8, 10, 12) // method: bzip2
    await expect(extractZip(archive, out)).rejects.toThrow('compression method 12 (bzip2)')

    await writeZip(archive, [{ name: 'a.txt', data: text('a'), method: 0 }])
    await patchField(archive, 6, 8, 0x0801) // flags: UTF-8 name, encrypted
    await expect(extractZip(archive, out)).rejects.toThrow('encrypted')
    expect(await exists(join(out, 'a.txt'))).toBe(false)
  })

  test('reads ZIP64 end records and extra fields', async () => {
    const data = sample(100_000)
    const out = await roundTrip(
      [
        { name: 'z/' },
        { name: 'z/stored.txt', data: text('stored'), method: 0 },
        { name: 'z/deflated.bin', data },
        { name: 'z/empty', data: new Uint8Array(0) },
      ],
      { zip64: true },
    )
    expect(await readFile(join(out, 'z', 'stored.txt'), 'utf8')).toBe('stored')
    expect(Buffer.compare(await readFile(join(out, 'z', 'deflated.bin')), data)).toBe(0)
    expect((await stat(join(out, 'z', 'empty'))).size).toBe(0)
  })

  test.skipIf(!UNZIP && !BSDTAR)('fixture archives pass unzip -t and bsdtar', async () => {
    const entries: ZipEntry[] = [
      { name: 'build/' },
      { name: 'build/stored.txt', data: text('stored'), method: 0 },
      { name: 'build/deflated.bin', data: sample(200_000) },
      { name: 'build/empty', data: new Uint8Array(0) },
      { name: 'build/sd-server', data: text('#!/bin/sh\n'), mode: 0o755 },
      { name: 'build/libsd.so', symlink: 'deflated.bin' },
    ]
    // `unzip -t` also checks every CRC; `tar -tf` proves bsdtar can walk the structure.
    const readers = [UNZIP ? [UNZIP, '-t'] : null, BSDTAR ? [BSDTAR, '-tf'] : null]
    for (const zip64 of [false, true]) {
      const archive = join(dir, zip64 ? 'zip64.zip' : 'zip32.zip')
      await writeZip(archive, entries, { zip64 })
      for (const reader of readers) {
        if (!reader) continue
        const run = Bun.spawnSync([...reader, archive])
        const output = `${run.stdout}${run.stderr}`
        expect({ exitCode: run.exitCode, output }).toMatchObject({ exitCode: 0 })
        for (const { name } of entries) expect(output).toContain(name)
      }
    }
  })

  test.skipIf(!BSDTAR)('reads what bsdtar writes: data descriptors, zero local sizes', async () => {
    const src = join(dir, 'src')
    await makeTree(src)
    const archive = join(dir, 'bsdtar.zip')
    const run = Bun.spawnSync([BSDTAR!, '-a', '-cf', archive, '-C', src, 'build'])
    expect({ exitCode: run.exitCode, stderr: `${run.stderr}` }).toEqual({ exitCode: 0, stderr: '' })
    // The point of this test: local headers with flag bit 3 and no sizes in them.
    const bytes = await readFile(archive)
    let streamed = 0
    for (let at = bytes.indexOf('PK\x03\x04'); at >= 0; at = bytes.indexOf('PK\x03\x04', at + 4)) {
      if (bytes.readUInt16LE(at + 6) & 8) streamed++
    }
    expect(streamed).toBeGreaterThan(0)

    await extractZip(archive, join(dir, 'out'))
    await expectTree(join(dir, 'out'))
  })

  test.skipIf(!ZIP)('reads what Info-ZIP zip writes', async () => {
    const src = join(dir, 'src')
    await makeTree(src)
    const archive = join(dir, 'infozip.zip')
    const run = Bun.spawnSync([ZIP!, '-r', '-y', '-q', archive, 'build'], { cwd: src })
    expect({ exitCode: run.exitCode, stderr: `${run.stderr}` }).toEqual({ exitCode: 0, stderr: '' })
    await extractZip(archive, join(dir, 'out'))
    await expectTree(join(dir, 'out'))
  })
})

describe('extractArchive', () => {
  test('unpacks a .zip on this host, Linux included, where GNU tar cannot', async () => {
    const archive = join(dir, 'sd-master-bin-Linux-Ubuntu-24.04-x86_64.zip')
    await writeZip(archive, [
      { name: 'build/bin/sd-server', data: text('#!/bin/sh\n'), mode: 0o755 },
      { name: 'build/bin/libstable-diffusion.so', data: sample(10_000) },
    ])
    const out = join(dir, 'engine')
    await extractArchive(archive, out)
    expect(await readFile(join(out, 'build', 'bin', 'sd-server'), 'utf8')).toBe('#!/bin/sh\n')
    expect((await stat(join(out, 'build', 'bin', 'libstable-diffusion.so'))).size).toBe(10_000)
    if (posix) expect((await stat(join(out, 'build', 'bin', 'sd-server'))).mode & 0o111).not.toBe(0)
  })
})
