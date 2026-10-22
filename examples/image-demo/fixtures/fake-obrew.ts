/**
 * A stand-in for the obrew CLI, for the demo's tests: it answers the five commands the demo runs
 * with canned JSON / JSONL, and records each invocation (argv and stdin) to `FAKE_OBREW_LOG`.
 * `FAKE_OBREW_SLOW=1` makes `image` run until it is killed, for the cancel test.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const stdin = argv.includes('--input-format') ? await Bun.stdin.text() : ''
if (process.env.FAKE_OBREW_LOG) appendFileSync(process.env.FAKE_OBREW_LOG, JSON.stringify({ argv, stdin, pid: process.pid }) + '\n')
const say = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n')
const flag = (name: string) => argv[argv.indexOf(name) + 1]

const [a, b] = argv
if (a === 'auth' && b === 'status') {
  say({ ready: true, image: { ready: true, edit: true, upscale: true, engine: { installed: true, tag: 'fake', variant: 'cpu' }, model: { default: 'flux2-klein-4b', chosen: null, installed: true, edit: 'flux2-klein-4b' }, setup: 'obrew image setup' } })
} else if (a === 'image' && b === 'models') {
  say({ default: 'flux2-klein-4b', defaultEdit: 'flux2-klein-4b', upscaler: 'realesrgan-x4plus', presets: [{ id: 'flux2-klein-4b', title: 'FLUX.2 [klein] 4B', kind: 'generator', installed: true, downloadBytes: 1 }], bundles: [], aspects: { '16:9': [1280, 720] } })
} else if (a === 'image' && b === 'setup') {
  say({ type: 'download.plan', files: [{ file: 'm.gguf', size: 10, cached: false }], totalBytes: 10 })
  say({ type: 'download.progress', file: 'm.gguf', received: 10, total: 10 })
  say({ type: 'setup.done', ok: true, message: 'image generation is ready' })
} else if (a === 'image') {
  const out = flag('--out')
  const run = 'img_fake'
  say({ type: 'image.started', runId: run, mode: b === 'upscale' ? 'upscale' : 'generate', model: 'flux2-klein-4b', engine: { tag: 'fake', variant: 'cpu', port: 1 }, width: 16, height: 9, count: 1, seed: 1 })
  process.stderr.write('[image 1] step 1/4\n')
  if (process.env.FAKE_OBREW_SLOW === '1') {
    say({ type: 'image.progress', runId: run, index: 0, phase: 'sampling', step: 1, steps: 4 })
    await Bun.sleep(60_000)
  }
  mkdirSync(out!, { recursive: true })
  const path = join(out!, 'fake-1.png')
  writeFileSync(path, 'png')
  say({ type: 'image.saved', runId: run, index: 0, path, width: 16, height: 9, seed: 1, format: 'png', bytes: 3, model: 'flux2-klein-4b', durationMs: 5 })
  say({ type: 'image.completed', runId: run, durationMs: 6, images: [{ path, width: 16, height: 9, seed: 1 }] })
} else {
  process.stderr.write(`fake obrew: unexpected ${argv.join(' ')}\n`)
  process.exit(2)
}
