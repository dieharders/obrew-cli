/**
 * The speech layer's pure parts: the request obrew accepts, what it forwards, the asset names
 * the installer asks a release for, and the pack registry's rules.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ttsAssetNames } from '../engine/variant'
import { PCM_HEADERS, SpeechRequestSchema, upstreamBody } from './client'
import { DEFAULT_PACK, VOICE_PACKS, activePack, findPack, installedPacks, packFiles, requirePack } from './packs'

describe('SpeechRequestSchema', () => {
  test('input is required; pcm is the default format', () => {
    expect(() => SpeechRequestSchema.parse({})).toThrow()
    expect(() => SpeechRequestSchema.parse({ input: '' })).toThrow()
    expect(SpeechRequestSchema.parse({ input: 'hi' }).response_format).toBe('pcm')
  })

  test('only pcm and wav are formats; OpenAI clients may still send speed and stream', () => {
    expect(() => SpeechRequestSchema.parse({ input: 'hi', response_format: 'mp3' })).toThrow()
    const req = SpeechRequestSchema.parse({ input: 'hi', response_format: 'wav', speed: 1.2, stream: true })
    expect(req.response_format).toBe('wav')
  })

  test('the upstream body drops obrew-only fields and keeps the engine’s', () => {
    const req = SpeechRequestSchema.parse({ input: 'hi', model: 'qwen3-tts-0.6b-customvoice', voice: 'ryan', stream: true, seed: 3 })
    expect(upstreamBody(req)).toEqual({ input: 'hi', voice: 'ryan', response_format: 'pcm', seed: 3 })
  })

  test('pcm headers say what the engine produces', () => {
    expect(PCM_HEADERS['x-sample-rate']).toBe('24000')
    expect(PCM_HEADERS['x-format']).toBe('s16le')
  })
})

describe('ttsAssetNames', () => {
  test('Windows x64 has cpu, vulkan and cuda archives; nothing for arm64 or metal', () => {
    expect(ttsAssetNames('v0.1.0', 'cpu', 'win32', 'x64')).toEqual(['qwentts-v0.1.0-bin-win-cpu-x64.zip'])
    expect(ttsAssetNames('v0.1.0', 'cuda', 'win32', 'x64')).toEqual(['qwentts-v0.1.0-bin-win-cuda-x64.zip'])
    expect(ttsAssetNames('v0.1.0', 'vulkan', 'win32', 'x64')).toEqual(['qwentts-v0.1.0-bin-win-vulkan-x64.zip'])
    expect(ttsAssetNames('v0.1.0', 'metal', 'win32', 'x64')).toBeNull()
    expect(ttsAssetNames('v0.1.0', 'cpu', 'win32', 'arm64')).toBeNull()
  })

  test('macOS is one archive per arch; Linux follows llama.cpp’s ubuntu naming', () => {
    expect(ttsAssetNames('v0.1.0', 'metal', 'darwin', 'arm64')).toEqual(['qwentts-v0.1.0-bin-macos-arm64.tar.gz'])
    expect(ttsAssetNames('v0.1.0', 'cuda', 'darwin', 'arm64')).toBeNull()
    expect(ttsAssetNames('v0.1.0', 'cpu', 'linux', 'x64')).toEqual(['qwentts-v0.1.0-bin-ubuntu-x64.tar.gz'])
    expect(ttsAssetNames('v0.1.0', 'cuda', 'linux', 'x64')).toEqual(['qwentts-v0.1.0-bin-ubuntu-cuda-x64.tar.gz'])
  })
})

describe('voice packs', () => {
  let home: string
  const previous = process.env.OBREW_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'obrew-tts-'))
    process.env.OBREW_HOME = home
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env.OBREW_HOME
    else process.env.OBREW_HOME = previous
    await rm(home, { recursive: true, force: true })
  })

  /** Put non-empty stand-ins where a pack's files would be. */
  const fakeInstall = async (id: string) => {
    const files = packFiles(requirePack(id))
    await mkdir(join(files.talker, '..'), { recursive: true })
    await writeFile(files.talker, 'talker')
    await writeFile(files.codec, 'codec')
  }

  test('the default pack exists and every pack shares the codec', () => {
    expect(findPack(DEFAULT_PACK)).not.toBeNull()
    expect(new Set(VOICE_PACKS.map((p) => p.codec)).size).toBe(1)
    expect(() => requirePack('nope')).toThrow(/not a voice pack/)
  })

  test('nothing installed → no packs, and activePack says what to pull', async () => {
    expect(await installedPacks()).toEqual([])
    await expect(activePack({})).rejects.toThrow(/obrew voices pull qwen3-tts-0.6b-customvoice/)
  })

  test('an installed pack is found; the chosen one wins over the default when installed', async () => {
    await fakeInstall('qwen3-tts-0.6b-base')
    expect((await installedPacks()).map((p) => p.id)).toEqual(['qwen3-tts-0.6b-base'])
    // Chosen but not installed: falls through to what is on disk.
    expect((await activePack({ ttsPack: 'qwen3-tts-1.7b-base' })).id).toBe('qwen3-tts-0.6b-base')
    await fakeInstall(DEFAULT_PACK)
    expect((await activePack({})).id).toBe(DEFAULT_PACK)
    expect((await activePack({ ttsPack: 'qwen3-tts-0.6b-base' })).id).toBe('qwen3-tts-0.6b-base')
  })
})
