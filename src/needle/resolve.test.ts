import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tempHome } from '../../test/fixtures/home'
import { saveConfig } from '../shared/config'
import { findNeedle, runnerAsset } from './install'
import { resolveToolModel, toolModelStatus } from './resolve'

const FAKE_NEEDLE = join(import.meta.dir, '../../test/fixtures/fake-needle.ts')

describe('which tool model', () => {
  let home: Awaited<ReturnType<typeof tempHome>>
  beforeEach(async () => {
    home = await tempHome()
  })
  afterEach(async () => {
    delete process.env.OBREW_TOOL_MODEL
    delete process.env.OBREW_NEEDLE
    await home.cleanup()
  })

  test('needle3 by default; asked for and absent is not an error, just not enabled', async () => {
    expect(await toolModelStatus()).toEqual({ id: 'needle3', enabled: false, installed: false })
  })

  test('enabled once the runner is there', async () => {
    process.env.OBREW_NEEDLE = FAKE_NEEDLE
    expect(await toolModelStatus()).toEqual({ id: 'needle3', enabled: true, installed: true })
  })

  test('-c tool_model beats OBREW_TOOL_MODEL beats config.json', async () => {
    process.env.OBREW_NEEDLE = FAKE_NEEDLE
    await saveConfig({ toolModel: 'none' })
    expect((await resolveToolModel()).id).toBe('none')
    process.env.OBREW_TOOL_MODEL = 'needle3'
    expect((await resolveToolModel()).enabled).toBe(true)
    expect((await resolveToolModel('off')).enabled).toBe(false)
  })

  test('a path runs those weights with the installed runner, when both exist', async () => {
    process.env.OBREW_NEEDLE = FAKE_NEEDLE
    const weights = join(home.dir, 'mine.cact')
    expect((await resolveToolModel(weights)).enabled).toBe(false)
    await Bun.write(weights, 'x')
    const resolved = await resolveToolModel(weights)
    expect(resolved).toMatchObject({ id: weights, enabled: true })
    expect(resolved.install?.weights).toBe(weights)
  })

  test('OBREW_NEEDLE pointing nowhere is a hard failure, not a silent fall-through', async () => {
    process.env.OBREW_NEEDLE = join(home.dir, 'missing')
    await expect(findNeedle()).rejects.toThrow(/OBREW_NEEDLE/)
  })

  test('a runner exists for the release targets and not for an Intel mac', () => {
    expect(runnerAsset('darwin', 'arm64')).toBe('macos-arm64/needle')
    expect(runnerAsset('linux', 'x64')).toBe('linux-x86_64/needle')
    expect(runnerAsset('win32', 'x64')).toBe('windows-x86_64/needle.exe')
    expect(runnerAsset('darwin', 'x64')).toBe(null)
  })
})
