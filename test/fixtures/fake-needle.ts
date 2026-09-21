/**
 * A stand-in for Cactus's `needle` runner in `--serve` mode, for the tests.
 *
 *   bun test/fixtures/fake-needle.ts --tools <file> --serve --port <n> [...ignored flags]
 *
 *   FAKE_NEEDLE_REPLY=<json>     the body every POST /complete answers with
 *   FAKE_NEEDLE_ENV_FILE=<path>  write the telemetry variables this process was started with
 *                                there, so a test can prove they arrived
 *   FAKE_NEEDLE_EXIT=1           exit before listening (a runner that cannot start)
 */
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const port = Number(argv[argv.indexOf('--port') + 1] ?? 0)
if (process.env.FAKE_NEEDLE_EXIT) process.exit(1)
if (process.env.FAKE_NEEDLE_ENV_FILE) {
  writeFileSync(
    process.env.FAKE_NEEDLE_ENV_FILE,
    JSON.stringify({ NEEDLE_TELEMETRY: process.env.NEEDLE_TELEMETRY, DO_NOT_TRACK: process.env.DO_NOT_TRACK }),
  )
}
const reply = process.env.FAKE_NEEDLE_REPLY ?? '{"success":true,"function_calls":[],"confidence":0.5}'

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname
    if (req.method === 'POST' && path === '/reset') return new Response('{}')
    if (req.method === 'POST' && path === '/complete') return new Response(reply)
    return new Response('not found', { status: 404 })
  },
})
