import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globTool } from './glob'
import { grepTool } from './grep'
import { readTool } from './read'
import { builtinRegistry } from './registry'

describe('built-in tools', () => {
  let cwd: string
  const ctx = () => ({ cwd, signal: new AbortController().signal })

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'obrew-tools-'))
    await mkdir(join(cwd, 'src', 'deep'), { recursive: true })
    await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(cwd, 'src', 'a.ts'), 'const a = 1\nexport const needle = "here"\nconst b = 2\n')
    await writeFile(join(cwd, 'src', 'deep', 'b.ts'), 'needle again\n')
    await writeFile(join(cwd, 'README.md'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'))
    await writeFile(join(cwd, 'node_modules', 'pkg', 'index.js'), 'needle in node_modules')
    await writeFile(join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
  })
  afterAll(() => rm(cwd, { recursive: true, force: true }))

  test('Read numbers lines and pages with offset/limit', async () => {
    const all = await readTool.execute({ path: 'README.md' }, ctx())
    expect(all.isError).toBeUndefined()
    expect(all.content.split('\n')[0]).toMatch(/^ ?1\tline 1$/)
    const page = await readTool.execute({ path: 'README.md', offset: 10, limit: 3 }, ctx())
    expect(page.content).toContain('10\tline 10')
    expect(page.content).toContain('12\tline 12')
    expect(page.content).not.toContain('line 13\n')
    expect(page.content).toContain('continue with offset=13')
  })

  test('Read refuses directories, binaries and paths outside', async () => {
    expect((await readTool.execute({ path: 'src' }, ctx())).isError).toBe(true)
    expect((await readTool.execute({ path: 'bin.dat' }, ctx())).isError).toBe(true)
    await expect(readTool.execute({ path: '../outside.txt' }, ctx())).rejects.toThrow(/DENIED/)
  })

  test('Glob lists matches as sorted relative paths and skips node_modules', async () => {
    const out = await globTool.execute({ pattern: '**/*.{ts,js}' }, ctx())
    expect(out.content.split('\n')).toEqual(['src/a.ts', 'src/deep/b.ts'])
    const scoped = await globTool.execute({ pattern: '*.ts', path: 'src/deep' }, ctx())
    expect(scoped.content).toBe('src/deep/b.ts')
    expect((await globTool.execute({ pattern: '*.zzz' }, ctx())).content).toBe('No files matched.')
  })

  test('Grep returns path:line: text, honours glob and ignoreCase, skips binaries', async () => {
    const out = await grepTool.execute({ pattern: 'NEEDLE', ignoreCase: true }, ctx())
    const lines = out.content.split('\n')
    expect(lines).toContain('src/a.ts:2: export const needle = "here"')
    expect(lines).toContain('src/deep/b.ts:1: needle again')
    expect(out.content).not.toContain('node_modules')
    const only = await grepTool.execute({ pattern: 'needle', glob: 'src/deep/*' }, ctx())
    expect(only.content.split('\n')).toEqual(['src/deep/b.ts:1: needle again'])
    expect((await grepTool.execute({ pattern: '(' }, ctx())).isError).toBe(true)
  })

  test('registry: default trio, none, unknown', () => {
    expect(builtinRegistry(undefined).list().map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob'])
    expect(builtinRegistry('none').size).toBe(0)
    expect(builtinRegistry('Read').schemas()[0]).toMatchObject({ type: 'function', function: { name: 'Read' } })
    expect(() => builtinRegistry('Bash')).toThrow(/unknown built-in tool/)
  })
})
