import { describe, expect, test } from 'bun:test'
import { chooseGguf, chooseMmproj, parseModelSpec, projectorFor, resolveUrl, type HfFile } from './hf'

const f = (path: string, size = 1): HfFile => ({ path, size, sha256: null })

describe('parseModelSpec', () => {
  test('repo only', () => expect(parseModelSpec('unsloth/Qwen3-4B-GGUF')).toEqual({ repoId: 'unsloth/Qwen3-4B-GGUF', file: null }))
  test('repo:file', () => expect(parseModelSpec('a/b:x.gguf')).toEqual({ repoId: 'a/b', file: 'x.gguf' }))
  test('rejects junk', () => expect(() => parseModelSpec('not-a-repo')).toThrow(/org\/repo/))
})

describe('chooseGguf', () => {
  test('the only model file wins', () => {
    expect(chooseGguf([f('README.md'), f('m.gguf'), f('mmproj-f16.gguf')], null).path).toBe('m.gguf')
  })
  test('prefers Q4_K_M among many', () => {
    const files = [f('m-Q8_0.gguf'), f('m-Q4_K_M.gguf'), f('m-Q5_K_M.gguf')]
    expect(chooseGguf(files, null).path).toBe('m-Q4_K_M.gguf')
  })
  test('explicit file, by name or path', () => {
    const files = [f('sub/m-Q8_0.gguf'), f('m-Q4_K_M.gguf')]
    expect(chooseGguf(files, 'm-Q8_0.gguf').path).toBe('sub/m-Q8_0.gguf')
    expect(() => chooseGguf(files, 'zzz.gguf')).toThrow(/Available/)
  })
  test('ambiguous without a preferred quant asks the user', () => {
    expect(() => chooseGguf([f('a-IQ2.gguf'), f('b-IQ3.gguf')], null)).toThrow(/name one/)
  })
  test('multi-part files are not auto-selected', () => {
    expect(chooseGguf([f('m-00001-of-00002.gguf'), f('m-00002-of-00002.gguf'), f('m-Q4_0.gguf')], null).path).toBe('m-Q4_0.gguf')
  })
})

describe('chooseMmproj', () => {
  test('prefers f16', () => {
    expect(chooseMmproj([f('mmproj-BF16.gguf'), f('mmproj-F16.gguf')], null).path).toBe('mmproj-F16.gguf')
  })
  test('none → error', () => expect(() => chooseMmproj([f('m.gguf')], null)).toThrow(/no mmproj/))
})

describe('projectorFor', () => {
  test('one that names no model belongs to the model beside it, f16 first', () => {
    expect(projectorFor([f('m-Q4_K_M.gguf'), f('mmproj-BF16.gguf'), f('mmproj-F16.gguf')], 'm-Q4_K_M.gguf')?.path).toBe('mmproj-F16.gguf')
    expect(projectorFor([f('m.gguf'), f('mmproj-model-f16.gguf')], 'm.gguf')?.path).toBe('mmproj-model-f16.gguf')
    expect(projectorFor([f('m-Q4_K_M.gguf'), f('mmproj-Q8_0.gguf')], 'm-Q4_K_M.gguf')?.path).toBe('mmproj-Q8_0.gguf')
  })
  test("only the model's own directory counts", () => {
    const files = [f('a/m-Q4_K_M.gguf'), f('a/mmproj-F16.gguf'), f('b/n-Q4_K_M.gguf'), f('b/mmproj-F16.gguf'), f('t-Q4_K_M.gguf')]
    expect(projectorFor(files, 'a/m-Q4_K_M.gguf')?.path).toBe('a/mmproj-F16.gguf')
    expect(projectorFor(files, 'b/n-Q4_K_M.gguf')?.path).toBe('b/mmproj-F16.gguf')
    expect(projectorFor(files, 't-Q4_K_M.gguf')).toBeNull()
  })
  test('one that names a model belongs to that model, not to a text model beside it', () => {
    const files = [f('Qwen2.5-7B-Instruct-Q4_K_M.gguf'), f('Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf'), f('mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf')]
    expect(projectorFor(files, 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf')?.path).toBe('mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf')
    expect(projectorFor(files, 'Qwen2.5-7B-Instruct-Q4_K_M.gguf')).toBeNull()
  })
  test('a repo with none → null, not an error', () => expect(projectorFor([f('m.gguf')], 'm.gguf')).toBeNull())
})

describe('resolveUrl', () => {
  test('encodes path segments and honours HF_ENDPOINT', () => {
    process.env.HF_ENDPOINT = 'http://127.0.0.1:9/'
    try {
      expect(resolveUrl('a/b', 'dir/my file.gguf')).toBe('http://127.0.0.1:9/a/b/resolve/main/dir/my%20file.gguf')
    } finally {
      delete process.env.HF_ENDPOINT
    }
  })
})
