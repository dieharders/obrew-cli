import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FenceError, resolveInside } from './fence'

describe('resolveInside', () => {
  let root: string
  let outside: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'obrew-fence-'))
    outside = await mkdtemp(join(tmpdir(), 'obrew-outside-'))
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub', 'a.txt'), 'a')
    await writeFile(join(outside, 'secret.txt'), 's')
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  test('relative paths inside resolve to absolute real paths', async () => {
    const p = await resolveInside(root, 'sub/a.txt')
    expect(p.toLowerCase()).toBe(resolve(root, 'sub', 'a.txt').toLowerCase().replace(/^[a-z]:/, (m) => m))
    expect(await Bun.file(p).exists()).toBe(true)
  })

  test('the root itself and a not-yet-existing child are inside', async () => {
    await resolveInside(root, '.')
    await resolveInside(root, 'sub/new/file.txt')
  })

  test('.. and absolute paths outside are denied', async () => {
    await expect(resolveInside(root, '../secret.txt')).rejects.toBeInstanceOf(FenceError)
    await expect(resolveInside(root, join(outside, 'secret.txt'))).rejects.toBeInstanceOf(FenceError)
    await expect(resolveInside(root, 'sub/../../x')).rejects.toBeInstanceOf(FenceError)
  })

  test('a symlink that escapes is denied even though its path looks inside', async () => {
    const link = join(root, 'sub', 'link')
    try {
      await symlink(join(outside, 'secret.txt'), link, 'file')
    } catch {
      return // no symlink privilege on this Windows account; nothing to test
    }
    await expect(resolveInside(root, 'sub/link')).rejects.toBeInstanceOf(FenceError)
  })

  test('a sibling directory sharing the root as a prefix is outside', async () => {
    const sibling = `${root}-evil`
    await mkdir(sibling, { recursive: true })
    try {
      await expect(resolveInside(root, sibling)).rejects.toBeInstanceOf(FenceError)
    } finally {
      await rm(sibling, { recursive: true, force: true })
    }
  })
})
