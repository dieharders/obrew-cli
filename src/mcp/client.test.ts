import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { calls, startFakeMcp, type FakeMcp } from '../../test/fixtures/fake-mcp'
import { McpClient, contentToText } from './client'
import { parseMcpServerSpec } from './spec'

const STDIO_FIXTURE = join(import.meta.dir, '..', '..', 'test', 'fixtures', 'fake-mcp-stdio.ts')

describe('parseMcpServerSpec', () => {
  test('http, stdio, and mistakes', () => {
    expect(parseMcpServerSpec('mb=http://127.0.0.1:5/mcp/j/build')).toEqual({ name: 'mb', transport: 'http', url: 'http://127.0.0.1:5/mcp/j/build' })
    expect(parseMcpServerSpec('fs=stdio:bun server.ts --root .')).toEqual({ name: 'fs', transport: 'stdio', command: ['bun', 'server.ts', '--root', '.'] })
    expect(() => parseMcpServerSpec('nope')).toThrow(/name=/)
    expect(() => parseMcpServerSpec('bad name=http://x')).toThrow(/must be/)
    expect(() => parseMcpServerSpec('x=ftp://y')).toThrow(/http/)
  })
})

describe('contentToText', () => {
  test('joins text parts, JSON for the rest, structuredContent as a fallback', () => {
    expect(contentToText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] })).toBe('a\n{"type":"image","data":"x"}\nb')
    expect(contentToText({ structuredContent: { n: 1 } })).toBe('{"n":1}')
    expect(contentToText({})).toBe('')
  })
})

describe('McpClient over HTTP', () => {
  let fake: FakeMcp | null = null
  afterEach(() => {
    fake?.stop()
    fake = null
    calls.length = 0
  })

  for (const sse of [false, true]) {
    test(`handshake, list, call, isError, namespaced tools (${sse ? 'SSE' : 'JSON'} replies)`, async () => {
      fake = startFakeMcp({ sse, sessionId: 'sess-1' })
      const client = await McpClient.connect({ name: 'fake', transport: 'http', url: fake.url })
      expect(client.protocolVersion).toBe('2024-11-05')
      expect(client.serverInfo.name).toBe('fake')

      const tools = await client.tools()
      expect(tools.map((t) => t.name)).toEqual(['mcp__fake__echo', 'mcp__fake__fail', 'mcp__fake__slow', 'mcp__fake__add'])
      expect(tools[0]!.inputSchema).toMatchObject({ required: ['text'] })
      expect(tools[0]!.timeoutMs).toBeGreaterThan(120_000)

      const ctx = { cwd: '.', signal: new AbortController().signal }
      expect(await tools[0]!.execute({ text: 'hi' }, ctx)).toEqual({ content: 'hi', isError: false })
      expect(await tools[1]!.execute({}, ctx)).toEqual({ content: 'DENIED: nope', isError: true })
      expect(await tools[3]!.execute({ a: 2, b: 3 }, ctx)).toEqual({ content: '5', isError: false })
      expect(calls.map((c) => c.name)).toEqual(['echo', 'fail', 'add'])
      await client.close()
    })
  }

  test('a JSON-RPC error is thrown; an unreachable server fails the connect', async () => {
    fake = startFakeMcp()
    const client = await McpClient.connect({ name: 'fake', transport: 'http', url: fake.url })
    await expect(client.callTool('missing', {})).rejects.toThrow(/unknown tool/)
    await expect(McpClient.connect({ name: 'dead', transport: 'http', url: 'http://127.0.0.1:1/mcp' })).rejects.toThrow(/cannot reach/)
  })
})

describe('McpClient over stdio', () => {
  test('spawns the server, talks NDJSON, closes it', async () => {
    const client = await McpClient.connect({ name: 'io', transport: 'stdio', command: [process.execPath, STDIO_FIXTURE] })
    const tools = await client.tools()
    expect(tools.map((t) => t.name)).toContain('mcp__io__echo')
    const echo = tools.find((t) => t.name === 'mcp__io__echo')!
    expect(await echo.execute({ text: 'over stdio' }, { cwd: '.', signal: new AbortController().signal })).toEqual({ content: 'over stdio', isError: false })
    await client.close()
  })

  test('a command that does not exist fails the connect', async () => {
    await expect(McpClient.connect({ name: 'x', transport: 'stdio', command: ['definitely-not-a-real-binary-xyz'] })).rejects.toThrow()
  })
})
