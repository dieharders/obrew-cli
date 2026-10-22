/**
 * The manual end-to-end check for image generation, against the REAL engine and models:
 *
 *   bun run smoke:image                        # from source
 *   OBREW_BIN=./obrew bun run smoke:image      # against a built binary
 *   bun run smoke:image --bench                # also time a 1280×720 image per installed model
 *   bun run smoke:image -c backend=cpu         # -c pairs pass through to every image run
 *
 * Run it on each platform before bumping `sdcpp_tag` (stable-diffusion.cpp changes between
 * releases, and Metal / Vulkan / ROCm regress independently). It sets up what is missing (several
 * GB the first time), then: a small image, image-to-image, a reference edit, a ×2 upscale — each
 * checked for the right size and for not being one flat colour (a known Metal failure mode) —
 * and stops the engine. One line per step; exit 1 on the first failure. Images go to a temp dir.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePng, isBlank } from '../src/image/png'

const bin = process.env.OBREW_BIN
const argv0 = bin ? [bin] : [process.execPath, 'src/main.ts']
const args = process.argv.slice(2)
const bench = args.includes('--bench')
const pairs = args.flatMap((a, i) => (a === '-c' && args[i + 1] ? ['-c', args[i + 1]!] : []))
const out = await mkdtemp(join(tmpdir(), 'obrew-smoke-image-'))

async function obrew(cmd: string[]): Promise<{ code: number; events: Array<Record<string, unknown>>; stderr: string; ms: number }> {
  const t0 = Date.now()
  const proc = Bun.spawn([...argv0, ...cmd], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>]
      } catch {
        return []
      }
    })
  return { code, events, stderr, ms: Date.now() - t0 }
}

function step(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) process.exit(1)
}

const failure = (r: Awaited<ReturnType<typeof obrew>>) => {
  const failed = r.events.find((e) => e.type === 'image.failed' || (e.type === 'setup.done' && e.ok === false))
  return failed ? String(failed.message) : r.stderr.trim().split('\n').at(-1) ?? ''
}

/** Run an image command; check the saved image's size and that it is not blank. Returns its path. */
async function image(name: string, cmd: string[], size: string): Promise<string> {
  const r = await obrew(['image', ...cmd, '--json', '--out', out, ...pairs])
  const saved = r.events.find((e) => e.type === 'image.saved')
  if (r.code !== 0 || !saved) step(name, false, failure(r))
  const img = decodePng(new Uint8Array(await Bun.file(String(saved!.path)).arrayBuffer()))
  step(name, `${img.width}x${img.height}` === size && !isBlank(img), `${img.width}×${img.height} in ${(r.ms / 1000).toFixed(1)} s${isBlank(img) ? ' — BLANK IMAGE' : ''}`)
  return String(saved!.path)
}

const setup = await obrew(['image', 'setup', '--json'])
step('image setup', setup.code === 0, setup.code === 0 ? String(setup.events.find((e) => e.type === 'setup.log' && String(e.message).startsWith('default image model'))?.message ?? '') : failure(setup))

const first = await image('text to image (512², 4 steps)', ['a red bicycle leaning on a brick wall, photo', '--size', '512x512', '--steps', '4', '--seed', '1'], '512x512')
await image('image to image', ['the same bicycle as a watercolor painting', '--image', first, '--strength', '0.5', '--size', '512x512', '--steps', '4'], '512x512')
await image('reference edit', ['the same bicycle in the snow', '--ref', first, '--size', '512x512'], '512x512')
const up = await obrew(['image', 'upscale', first, '--scale', '2', '--json', '--out', out, ...pairs])
const upSaved = up.events.find((e) => e.type === 'image.saved')
step('upscale ×2', up.code === 0 && upSaved?.width === 1024 && upSaved?.height === 1024, up.code === 0 ? `in ${(up.ms / 1000).toFixed(1)} s` : failure(up))

if (bench) {
  const list = JSON.parse((await new Response(Bun.spawn([...argv0, 'image', 'models', 'list', '--json'], { stdout: 'pipe', env: { ...process.env } }).stdout).text())) as {
    presets: Array<{ id: string; kind: string; installed: boolean }>
  }
  for (const p of list.presets.filter((x) => x.kind === 'generator' && x.installed)) {
    // Twice: the first includes loading the model, the second is the warm engine.
    for (const pass of ['cold', 'warm']) {
      const r = await obrew(['image', 'a harbour town at dusk, cinematic', '--model', p.id, '--aspect', '16:9', '--seed', '2', '--json', '--out', out, ...pairs])
      step(`bench ${p.id} 1280×720 (${pass})`, r.code === 0, r.code === 0 ? `${(r.ms / 1000).toFixed(1)} s` : failure(r))
    }
  }
}

const stop = await obrew(['image', 'engine', 'stop'])
step('engine stop', stop.code === 0)
console.log(`images: ${out}`)
