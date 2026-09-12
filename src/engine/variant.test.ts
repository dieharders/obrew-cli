import { describe, expect, test } from 'bun:test'
import { assetNames } from './variant'

describe('assetNames', () => {
  const tag = 'b9080'
  test('windows cuda needs the runtime archive too', () => {
    expect(assetNames(tag, 'cuda', 'win32', 'x64')).toEqual([
      'llama-b9080-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
    ])
  })
  test('windows cpu / vulkan', () => {
    expect(assetNames(tag, 'cpu', 'win32', 'x64')).toEqual(['llama-b9080-bin-win-cpu-x64.zip'])
    expect(assetNames(tag, 'vulkan', 'win32', 'x64')).toEqual(['llama-b9080-bin-win-vulkan-x64.zip'])
    expect(assetNames(tag, 'cpu', 'win32', 'arm64')).toEqual(['llama-b9080-bin-win-cpu-arm64.zip'])
  })
  test('macOS is metal whatever was asked', () => {
    expect(assetNames(tag, 'metal', 'darwin', 'arm64')).toEqual(['llama-b9080-bin-macos-arm64.tar.gz'])
    expect(assetNames(tag, 'cpu', 'darwin', 'x64')).toEqual(['llama-b9080-bin-macos-x64.tar.gz'])
  })
  test('linux cpu and vulkan; cuda is not published', () => {
    expect(assetNames(tag, 'cpu', 'linux', 'x64')).toEqual(['llama-b9080-bin-ubuntu-x64.tar.gz'])
    expect(assetNames(tag, 'vulkan', 'linux', 'arm64')).toEqual(['llama-b9080-bin-ubuntu-vulkan-arm64.tar.gz'])
    expect(assetNames(tag, 'cuda', 'linux', 'x64')).toBeNull()
  })
  test('impossible combinations are null, not a guess', () => {
    expect(assetNames(tag, 'metal', 'win32', 'x64')).toBeNull()
    expect(assetNames(tag, 'cuda', 'darwin', 'arm64')).toBeNull()
    expect(assetNames(tag, 'vulkan', 'win32', 'arm64')).toBeNull()
  })
})
