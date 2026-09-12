import { describe, expect, test } from 'bun:test'
import { launchArgs, loadOptionsFrom } from './flags'

describe('launchArgs', () => {
  test('always enables jinja, binds loopback, offloads all layers by default', () => {
    const args = launchArgs('/m/x.gguf', 8082)
    expect(args).toEqual([
      '-m', '/m/x.gguf', '--host', '127.0.0.1', '--port', '8082', '--jinja', '--no-webui', '--slots',
      '--n-gpu-layers', '999',
    ])
  })

  test('maps every load option to its llama-server flag', () => {
    const args = launchArgs('m', 1, {
      ctxSize: 8192, nGpuLayers: 20, threads: 8, batchSize: 512, seed: 7,
      cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', mmap: false, mlock: true,
      mmprojPath: '/p/mmproj.gguf', reasoningFormat: 'deepseek', extra: ['--flash-attn', 'on'],
    })
    expect(args).toContain('--ctx-size')
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('8192')
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('20')
    expect(args.slice(args.indexOf('--threads'), args.indexOf('--threads') + 4)).toEqual(['--threads', '8', '--threads-batch', '8'])
    expect(args).toContain('--no-mmap')
    expect(args).toContain('--mlock')
    expect(args[args.indexOf('--mmproj') + 1]).toBe('/p/mmproj.gguf')
    expect(args[args.indexOf('--reasoning-format') + 1]).toBe('deepseek')
    expect(args.slice(-2)).toEqual(['--flash-attn', 'on'])
  })

  test('-1 gpu layers means all', () => {
    const args = launchArgs('m', 1, { nGpuLayers: -1 })
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('999')
  })
})

describe('loadOptionsFrom', () => {
  test('reads launch keys from -c pairs and leaves request keys alone', () => {
    const opts = loadOptionsFrom({ ctx_size: 4096, threads: '4', mmap: 'off', temperature: 0.1 }, { ctxSize: 16384 })
    expect(opts).toEqual({ ctxSize: 4096, threads: 4, mmap: false })
  })

  test('rejects a non-integer', () => {
    expect(() => loadOptionsFrom({ ctx_size: 'lots' })).toThrow(/integer/)
  })
})
