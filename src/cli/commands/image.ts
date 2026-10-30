/**
 * `obrew image …` — local image generation: text to image, image to image, edits with reference
 * images, and upscaling, through a warm stable-diffusion.cpp `sd-server` (src/image/).
 *
 * The host contract mirrors `exec`: with `--json` stdout carries one event per line and nothing
 * else, the prompt may come as JSON on stdin (`--input-format json`), a stall or wall timer ends
 * a run that stops making progress, and every failure is an `image.failed` event AND exit 1
 * (usage mistakes exit 2 with no event). A host stops a run by killing it; the job it started in
 * the warm engine is cancelled then, or by the next obrew if the kill was a hard one.
 *
 * `setup`, `upscale`, `models`, `engine` and `help` are reserved as the first word, the way
 * `exec` reserves `resume`: `obrew image "setup of a desk"` is a prompt, `obrew image setup` is not.
 */
import { resolve } from 'node:path'
import { engineConsoleFrom } from '../../engine/flags'
import { detectHardware, isBaseAppleChip, memoryBudgetBytes, toGiB, type Hardware } from '../../image/engine/hardware'
import { findImageEngine, imageEngineStatus, installImageEngine } from '../../image/engine/install'
import { DEFAULT_IMAGE_IDLE_TTL_MS, readImageShared, reapIdleImageShared, reapImageOrphans, stopAllImageEngines } from '../../image/engine/shared'
import { IMAGE_VARIANTS, type ImageVariant } from '../../image/engine/variant'
import { SDCPP_TAG } from '../../image/engine/version'
import { fileSink, formatOfPath, generateImages, newRunId, upscaleImage, type RunContext } from '../../image/generate'
import { serverLogPath } from '../../image/paths'
import { DEFAULT_EDITOR, DEFAULT_GENERATOR, DEFAULT_UPSCALER, findPreset, PRESETS, presetBytes, tierFor, type Role, type Tier } from '../../image/presets'
import { pullCustom, pullPreset, type PullCallbacks } from '../../image/pull'
import { isComplete, loadImageRegistry, pathsOf, removeBundle, setSlot, slotId, type Slot } from '../../image/registry'
import { ASPECT_NAMES, ASPECTS, parseSize, type Aspect } from '../../image/size'
import { isAlive } from '../../engine/running'
import { logTail } from '../../engine/llama-server'
import { hfToken, loadConfig } from '../../shared/config'
import { humanBytes } from '../../shared/download'
import { isAbortError, ObrewError, UsageError, type FailCode } from '../../shared/errors'
import { ImageInputSchema, type ExecEvent } from '../../shared/events'
import { track, untrack } from '../../shared/proc'
import { asInt, asNumber, oneOf, parse, parseConfigPairs } from '../args'
import { createOutput, type Output } from '../output'

const HELP = `obrew image [options] "<prompt>"                 generate images
obrew image upscale <file> [--scale 2|4 | --size WxH] [--out <file|dir>] [--json]
obrew image setup [--model <preset>] [--variant cpu|cuda|vulkan|rocm|metal] [--no-edit] [--no-upscaler] [--json]
obrew image models list|pull|rm|use [...] [--json]
obrew image engine install|status|stop|log [--variant …] [--json]

Generate:
  --json                     one JSON event per line on stdout; else saved paths on stdout
  --input-format text|json   json: read {"prompt", "negativePrompt"?} from stdin
  --model <id>               installed image model (default: \`obrew image models use\`'s)
  --aspect ${ASPECT_NAMES.join('|')}   native sizes ${ASPECT_NAMES.map((a) => `${ASPECTS[a][0]}×${ASPECTS[a][1]}`).join(', ')}
  --size WxH                 exact output size; generated natively when the model can, else
                             generated smaller, upscaled and resampled (e.g. 1920x1080)
  --count <1-8>              images in this run, seeds seed, seed+1, … (default 1)
  --seed <n>                 default: random, reported on every event
  --steps <n> --cfg <x>      override the model's defaults
  --negative <text>          what to avoid
  --image <file>             image to image, from this picture …
  --strength <0-1>           … changed this much (default 0.6)
  --ref <file>               reference image (repeatable): edits and variations, the same
                             character in a new scene. Uses the default editor unless --model.
  --upscale 2|4              upscale the result with the upscaler
  --format png|jpeg|webp     default png, or the --out file's extension
  --out <file|dir>           where to save (default: the current directory)
  --preview off|fast         fast: emit image.preview frames (small PNGs, base64)
  --engine shared|ephemeral  shared (default) keeps sd-server warm between runs
  --stall-ms <n>             abort after this long with no progress (default 300000)
  --wall-ms <n>              abort after this long in total (default 3600000)
  -c key=value               max_vram=<GiB>, offload=true|false, vae_tiling=true|false,
                             backend=<sd.cpp --backend>, threads=<n>, engine_idle_ms=<n>,
                             engine_console=true (Windows: show the engine's console)`

const ENGINE_MODES = ['shared', 'ephemeral'] as const
const FORMATS = ['png', 'jpeg', 'webp'] as const
const TIERS = ['default', 'small'] as const

export async function runImage(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case 'help':
      console.log(HELP)
      return 0
    case 'upscale':
      return runUpscale(argv.slice(1))
    case 'setup':
      return runSetup(argv.slice(1))
    case 'models':
      return runModels(argv.slice(1))
    case 'engine':
      return runEngine(argv.slice(1))
    default:
      return runGenerate(argv)
  }
}

/** Timers and signals shared by every command that runs the engine: the shape `exec` has. */
function runControl(out: Output, stallMs: number, wallMs: number) {
  const controller = new AbortController()
  track(controller)
  let failCode: FailCode | null = null
  const stop = (code: FailCode) => {
    failCode ??= code
    controller.abort()
  }
  const onSignal = () => stop('aborted')
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const activity = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stop('timeout'), stallMs)
  }
  const wallTimer = setTimeout(() => stop('timeout'), wallMs)
  activity()
  return {
    signal: controller.signal,
    activity,
    failCode: () => failCode,
    /** The failure as the wire reports it, decided once. */
    fail(err: unknown): { code: FailCode; message: string } {
      const code: FailCode = failCode ?? (err instanceof ObrewError ? err.code : isAbortError(err) ? 'aborted' : 'engine_failed')
      const message =
        failCode === 'timeout' ? 'no progress within the time limit' : failCode === 'aborted' ? 'stopped' : err instanceof Error ? err.message : String(err)
      if (code === 'engine_missing' || code === 'model_missing') out.log('not ready: run `obrew image setup`')
      return { code, message }
    },
    dispose() {
      clearTimeout(wallTimer)
      if (stallTimer) clearTimeout(stallTimer)
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      untrack(controller)
    },
  }
}

async function readJsonInput(positionals: string[], negative: string | undefined): Promise<{ prompt: string; negativePrompt?: string }> {
  if (positionals.length > 0 || negative !== undefined) {
    throw new UsageError('--input-format json reads the prompt from stdin; drop the prompt argument and --negative')
  }
  let raw: unknown
  try {
    raw = JSON.parse(await Bun.stdin.text())
  } catch {
    throw new UsageError('--input-format json: stdin is not a JSON object')
  }
  const parsed = ImageInputSchema.safeParse(raw)
  if (!parsed.success) throw new UsageError(`--input-format json: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
  return parsed.data
}

function engineFlags(values: { engine?: string }, pairs: Record<string, unknown>) {
  return {
    engineMode: oneOf(values.engine ?? process.env.OBREW_ENGINE ?? 'shared', ENGINE_MODES, '--engine'),
    idleTtlMs: pairs.engine_idle_ms !== undefined ? asInt(pairs.engine_idle_ms, '-c engine_idle_ms') : undefined,
    console: engineConsoleFrom(pairs),
  }
}

async function runGenerate(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    'input-format': { type: 'string', default: 'text' },
    model: { type: 'string' },
    aspect: { type: 'string' },
    size: { type: 'string' },
    count: { type: 'string', default: '1' },
    seed: { type: 'string' },
    steps: { type: 'string' },
    cfg: { type: 'string' },
    negative: { type: 'string' },
    image: { type: 'string' },
    strength: { type: 'string' },
    ref: { type: 'string', multiple: true },
    upscale: { type: 'string' },
    format: { type: 'string' },
    out: { type: 'string' },
    preview: { type: 'string', default: 'off' },
    engine: { type: 'string' },
    cwd: { type: 'string' },
    'stall-ms': { type: 'string', default: '300000' },
    'wall-ms': { type: 'string', default: '3600000' },
    config: { type: 'string', multiple: true, short: 'c' },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const inputFormat = oneOf(values['input-format'], ['text', 'json'] as const, '--input-format')
  const input = inputFormat === 'json' ? await readJsonInput(positionals, values.negative) : { prompt: positionals.join(' ').trim(), negativePrompt: values.negative }
  if (!input.prompt.trim()) throw new UsageError(`a prompt is required\n\n${HELP}`)
  const pairs = parseConfigPairs(values.config)
  const cwd = resolve(values.cwd ?? process.cwd())
  const count = asInt(values.count, '--count')
  const format = values.format ? oneOf(values.format, FORMATS, '--format') : values.out ? (formatOfPath(values.out) ?? undefined) : undefined
  const preview = oneOf(values.preview, ['off', 'fast'] as const, '--preview') === 'fast'
  const upscale = values.upscale ? (Number(oneOf(values.upscale, ['2', '4'] as const, '--upscale')) as 2 | 4) : undefined
  const aspect = values.aspect ? (oneOf(values.aspect, ASPECT_NAMES, '--aspect') as Aspect) : undefined
  const engine = engineFlags(values, pairs)
  const out = createOutput(values.json)
  const control = runControl(out, asInt(values['stall-ms'], '--stall-ms'), asInt(values['wall-ms'], '--wall-ms'))

  try {
    await reapImageOrphans(out.log)
    if (await reapIdleImageShared()) out.log('image engine: stopped the idle sd-server')
    const ctx: RunContext = {
      runId: newRunId(),
      signal: control.signal,
      emit: (e: ExecEvent) => out.event(e),
      log: out.log,
      activity: control.activity,
      pairs,
      ...engine,
      sink: fileSink(values.out, cwd, count),
    }
    await generateImages(
      {
        prompt: input.prompt,
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
        model: values.model,
        aspect,
        size: values.size ? parseSize(values.size) : undefined,
        count,
        seed: values.seed !== undefined ? asInt(values.seed, '--seed') : undefined,
        steps: values.steps !== undefined ? asInt(values.steps, '--steps') : undefined,
        cfg: values.cfg !== undefined ? asNumber(values.cfg, '--cfg') : undefined,
        image: values.image ? resolve(cwd, values.image) : undefined,
        strength: values.strength !== undefined ? asNumber(values.strength, '--strength') : undefined,
        refs: (values.ref ?? []).map((r) => resolve(cwd, r)),
        upscale,
        format,
        preview,
      },
      ctx,
    )
    return 0
  } catch (err) {
    if (err instanceof UsageError) throw err
    out.event({ type: 'image.failed', ...control.fail(err) })
    return 1
  } finally {
    control.dispose()
  }
}

async function runUpscale(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    scale: { type: 'string' },
    size: { type: 'string' },
    format: { type: 'string' },
    out: { type: 'string' },
    engine: { type: 'string' },
    'stall-ms': { type: 'string', default: '300000' },
    'wall-ms': { type: 'string', default: '1800000' },
    config: { type: 'string', multiple: true, short: 'c' },
  } as const)
  if (values.help) {
    console.log('obrew image upscale <file> [--scale 2|4 | --size WxH] [--format png|jpeg|webp] [--out <file|dir>] [--json]')
    return 0
  }
  const file = positionals[0]
  if (!file || positionals.length > 1) throw new UsageError('upscale takes one image file')
  if (values.scale && values.size) throw new UsageError('--scale and --size cannot be combined')
  const pairs = parseConfigPairs(values.config)
  const out = createOutput(values.json)
  const control = runControl(out, asInt(values['stall-ms'], '--stall-ms'), asInt(values['wall-ms'], '--wall-ms'))
  try {
    await reapImageOrphans(out.log)
    await upscaleImage(
      {
        image: resolve(file),
        scale: values.scale ? (Number(oneOf(values.scale, ['2', '4'] as const, '--scale')) as 2 | 4) : undefined,
        size: values.size ? parseSize(values.size) : undefined,
        format: values.format ? oneOf(values.format, FORMATS, '--format') : values.out ? (formatOfPath(values.out) ?? undefined) : undefined,
      },
      {
        runId: newRunId(),
        signal: control.signal,
        emit: (e) => out.event(e),
        log: out.log,
        activity: control.activity,
        pairs,
        ...engineFlags(values, pairs),
        sink: fileSink(values.out, process.cwd(), 1),
      },
    )
    return 0
  } catch (err) {
    if (err instanceof UsageError) throw err
    out.event({ type: 'image.failed', ...control.fail(err) })
    return 1
  } finally {
    control.dispose()
  }
}

/** One controller for setup-style commands (downloads), cancelled by Ctrl-C. */
function setupControl() {
  const controller = new AbortController()
  track(controller)
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      untrack(controller)
    },
  }
}

/**
 * `download.progress` at most every 200 ms per file, plus the last one. A 4.5 GB model arrives
 * in tens of thousands of chunks; a host wants a moving bar, not a line per chunk.
 */
function progressEvents(out: Output): (file: string, received: number, total: number) => void {
  const last = new Map<string, number>()
  return (file, received, total) => {
    const now = Date.now()
    const done = total > 0 && received >= total
    if (!done && now - (last.get(file) ?? 0) < 200) return
    last.set(file, now)
    out.event({ type: 'download.progress', file, received, total })
  }
}

function pullCallbacks(out: Output, signal: AbortSignal, token: string | undefined): PullCallbacks {
  return {
    token,
    signal,
    onLog: (message) => out.event({ type: 'setup.log', message }),
    onPlan: (files, totalBytes) =>
      out.event({ type: 'download.plan', files: files.map((f) => ({ file: f.file.path, size: f.file.size, cached: f.cached })), totalBytes }),
    onProgress: progressEvents(out),
  }
}

const describeHardware = (hw: Hardware): string => {
  const gpu = hw.gpu.vendor === 'none' ? 'no GPU' : `${hw.gpu.name ?? hw.gpu.vendor}${hw.gpu.vramBytes ? ` (${toGiB(hw.gpu.vramBytes).toFixed(1)} GiB)` : ''}`
  const budget = memoryBudgetBytes(hw)
  return `${gpu}; ${toGiB(hw.ramBytes).toFixed(0)} GiB RAM${budget ? `; image memory budget ${toGiB(budget).toFixed(1)} GiB` : ''}`
}

/**
 * Engine, then models, then defaults — idempotent, so a host's Set-up button can run it on every
 * click. The default generator is the fastest good one for this machine: Z-Image-Turbo on a real
 * GPU; FLUX.2 klein on a base Apple chip (2.6× faster than Z-Image there, measured on an M4) and
 * on the CPU, where Z-Image is not practical. Both are installed on a GPU machine.
 */
export async function imageSetup(o: {
  model?: string
  variant?: ImageVariant
  tier?: Tier
  noEdit?: boolean
  noUpscaler?: boolean
  out: Output
  signal: AbortSignal
}): Promise<void> {
  const log = (message: string) => o.out.event({ type: 'setup.log', message })
  const hw = await detectHardware({ refresh: true })
  log(`hardware: ${describeHardware(hw)}`)
  let engine = await findImageEngine()
  if (!engine || (o.variant && engine.variant !== o.variant)) {
    engine = await installImageEngine({
      variant: o.variant,
      signal: o.signal,
      onLog: log,
      onProgress: progressEvents(o.out),
    })
  } else {
    log(`image engine ready (${engine.tag}, ${engine.variant})`)
  }
  if (o.model && findPreset(o.model)?.kind !== 'generator') {
    throw new ObrewError('bad_request', `"${o.model}" is not a curated image generator; see \`obrew image models list\``)
  }
  const cpuOnly = engine.variant === 'cpu'
  const tier = o.tier ?? tierFor(memoryBudgetBytes(hw))
  const generator = o.model ?? (cpuOnly || isBaseAppleChip(hw) ? DEFAULT_EDITOR : DEFAULT_GENERATOR)
  const wanted: Array<{ id: string; slots: Slot[] }> = []
  if (!cpuOnly || generator === DEFAULT_GENERATOR) wanted.push({ id: DEFAULT_GENERATOR, slots: generator === DEFAULT_GENERATOR ? ['generator'] : [] })
  if (!o.noEdit || generator === DEFAULT_EDITOR) wanted.push({ id: DEFAULT_EDITOR, slots: [...(generator === DEFAULT_EDITOR ? (['generator'] as Slot[]) : []), ...(o.noEdit ? [] : (['edit'] as Slot[]))] })
  if (o.model && o.model !== DEFAULT_GENERATOR && o.model !== DEFAULT_EDITOR) wanted.push({ id: o.model, slots: ['generator'] })
  if (!o.noUpscaler) wanted.push({ id: DEFAULT_UPSCALER, slots: ['upscaler'] })
  const token = hfToken(await loadConfig())
  const cb = pullCallbacks(o.out, o.signal, token)
  for (const w of wanted) await pullPreset(w.id, tier, { ...cb, makeDefault: w.slots })
  log(`default image model: ${generator}${generator === DEFAULT_EDITOR && !cpuOnly ? ` (the fastest here; \`--model ${DEFAULT_GENERATOR}\` for the highest quality)` : ''}`)
}

async function runSetup(argv: string[]): Promise<number> {
  const { values } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    model: { type: 'string' },
    variant: { type: 'string' },
    tier: { type: 'string' },
    'no-edit': { type: 'boolean', default: false },
    'no-upscaler': { type: 'boolean', default: false },
  } as const)
  if (values.help) {
    console.log('obrew image setup [--model <preset>] [--variant cpu|cuda|vulkan|rocm|metal] [--tier default|small] [--no-edit] [--no-upscaler] [--json]')
    return 0
  }
  const out = createOutput(values.json)
  const control = setupControl()
  try {
    await imageSetup({
      model: values.model,
      variant: values.variant ? oneOf(values.variant, IMAGE_VARIANTS, '--variant') : undefined,
      tier: values.tier ? oneOf(values.tier, TIERS, '--tier') : undefined,
      noEdit: values['no-edit'],
      noUpscaler: values['no-upscaler'],
      out,
      signal: control.signal,
    })
    out.event({ type: 'setup.done', ok: true, message: 'image generation is ready' })
    return 0
  } catch (err) {
    if (err instanceof UsageError) throw err
    out.event({ type: 'setup.done', ok: false, message: err instanceof Error ? err.message : String(err) })
    return 1
  } finally {
    control.dispose()
  }
}

/** What `models list --json` reports: presets (installed or not) and installed bundles. */
export async function listImageModels() {
  const registry = await loadImageRegistry()
  const hw = await detectHardware()
  const tier = tierFor(memoryBudgetBytes(hw))
  const presets = await Promise.all(
    PRESETS.map(async (p) => {
      const bundle = registry.bundles.find((b) => b.preset === p.id)
      return {
        id: p.id,
        title: p.title,
        description: p.description,
        kind: p.kind,
        license: p.license,
        homepage: p.homepage,
        uses: p.uses,
        caps: p.caps,
        defaults: p.defaults,
        downloadBytes: presetBytes(p, tier),
        optional: p.optional ?? false,
        installed: bundle ? await isComplete(registry, bundle) : false,
      }
    }),
  )
  const bundles = await Promise.all(
    registry.bundles.map(async (b) => ({
      id: b.id,
      preset: b.preset,
      kind: b.kind,
      title: b.title,
      license: b.license,
      caps: b.caps,
      defaults: b.defaults,
      complete: await isComplete(registry, b),
      bytes: pathsOf(registry, b).bytes,
      addedAt: b.addedAt,
    })),
  )
  return {
    default: slotId(registry, 'generator'),
    defaultEdit: slotId(registry, 'edit'),
    upscaler: slotId(registry, 'upscaler'),
    chosen: { default: registry.default, defaultEdit: registry.defaultEdit, upscaler: registry.upscaler },
    tier,
    aspects: ASPECTS,
    presets,
    bundles,
  }
}

const ROLE_FLAGS = ['diffusion', 'llm', 'vae', 't5xxl', 'clip_l', 'clip_g', 'tokenizer'] as const

async function runModels(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    tier: { type: 'string' },
    edit: { type: 'boolean', default: false },
    upscaler: { type: 'boolean', default: false },
    name: { type: 'string' },
    model: { type: 'string' },
    diffusion: { type: 'string' },
    llm: { type: 'string' },
    vae: { type: 'string' },
    t5xxl: { type: 'string' },
    clip_l: { type: 'string' },
    clip_g: { type: 'string' },
    tokenizer: { type: 'string' },
    steps: { type: 'string' },
    cfg: { type: 'string' },
    'can-edit': { type: 'boolean', default: false },
  } as const)
  const help = `obrew image models list [--json]
obrew image models pull <preset> [--tier default|small] [--json]
obrew image models pull --name <id> --diffusion org/repo[@rev]:path [--llm …] [--vae …] [--t5xxl …]
                        [--clip_l …] [--clip_g …] [--tokenizer …] [--steps n] [--cfg x] [--can-edit] [--json]
obrew image models pull --name <id> --model org/repo[@rev]:file.safetensors   (one-file checkpoint)
obrew image models rm <id>
obrew image models use <id> [--edit | --upscaler]`
  if (values.help) {
    console.log(help)
    return 0
  }
  const [sub, target] = positionals
  switch (sub) {
    case 'list': {
      const list = await listImageModels()
      if (values.json) {
        console.log(JSON.stringify(list))
        return 0
      }
      console.log(`default: ${list.default}   edit: ${list.defaultEdit}   upscaler: ${list.upscaler}`)
      for (const p of list.presets) {
        console.log(`${p.installed ? '*' : ' '} ${p.id.padEnd(20)} ${p.kind.padEnd(9)} ${p.license.padEnd(12)} ${humanBytes(p.downloadBytes).padStart(9)}  ${p.title}${p.optional && !p.installed ? '  (optional: models pull)' : ''}`)
      }
      for (const b of list.bundles.filter((b) => !b.preset)) console.log(`${b.complete ? '*' : '!'} ${b.id.padEnd(20)} ${b.kind.padEnd(9)} custom       ${humanBytes(b.bytes).padStart(9)}`)
      console.log('* installed')
      return 0
    }
    case 'pull': {
      const out = createOutput(values.json)
      const control = setupControl()
      try {
        const token = hfToken(await loadConfig())
        const cb = pullCallbacks(out, control.signal, token)
        const components: Array<{ role: Role; spec: string }> = []
        if (values.model) components.push({ role: 'model', spec: values.model })
        for (const role of ROLE_FLAGS) {
          const spec = values[role]
          if (spec) components.push({ role, spec })
        }
        let id: string
        if (components.length) {
          if (target) throw new UsageError('name the preset OR the components, not both')
          if (!values.name) throw new UsageError('--name <id> is required for a custom bundle')
          const bundle = await pullCustom(
            {
              name: values.name,
              components,
              defaults: { steps: values.steps ? asInt(values.steps, '--steps') : 20, cfg: values.cfg ? asNumber(values.cfg, '--cfg') : 4.5 },
              caps: values['can-edit'] ? { edit: true, maxRefs: 4 } : {},
            },
            cb,
          )
          id = bundle.id
        } else {
          if (!target) throw new UsageError(help)
          const hw = await detectHardware()
          const tier = values.tier ? oneOf(values.tier, TIERS, '--tier') : tierFor(memoryBudgetBytes(hw))
          id = (await pullPreset(target, tier, cb)).id
        }
        out.event({ type: 'setup.done', ok: true, message: id })
        return 0
      } catch (err) {
        if (err instanceof UsageError) throw err
        out.event({ type: 'setup.done', ok: false, message: err instanceof Error ? err.message : String(err) })
        return 1
      } finally {
        control.dispose()
      }
    }
    case 'rm': {
      if (!target) throw new UsageError('rm needs an image model id')
      const { bundle, deleted } = await removeBundle(target)
      console.log(`removed ${bundle.id}${deleted.length ? ` (${deleted.length} file${deleted.length === 1 ? '' : 's'} deleted)` : ''}`)
      return 0
    }
    case 'use': {
      if (!target) throw new UsageError('use needs an image model id')
      if (values.edit && values.upscaler) throw new UsageError('--edit and --upscaler cannot be combined')
      const slot: Slot = values.edit ? 'edit' : values.upscaler ? 'upscaler' : 'generator'
      const bundle = await setSlot(target, slot)
      console.log(`${slot === 'generator' ? 'default' : slot === 'edit' ? 'default editor' : 'upscaler'}: ${bundle.id}`)
      return 0
    }
    default:
      throw new UsageError(`image models: unknown subcommand "${sub ?? ''}"\n\n${help}`)
  }
}

async function runEngine(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    variant: { type: 'string' },
    tag: { type: 'string' },
  } as const)
  const help = `obrew image engine install [--variant cpu|cuda|vulkan|rocm|metal] [--tag <master-N-hash>] [--json]
obrew image engine status [--json]
obrew image engine stop      stop the warm sd-server (and any other obrew started)
obrew image engine log       print the sd-server log path and its tail`
  if (values.help) {
    console.log(help)
    return 0
  }
  switch (positionals[0]) {
    case 'install': {
      const out = createOutput(values.json)
      const control = setupControl()
      try {
        const record = await installImageEngine({
          tag: values.tag,
          variant: values.variant ? oneOf(values.variant, IMAGE_VARIANTS, '--variant') : undefined,
          signal: control.signal,
          onLog: (message) => out.event({ type: 'setup.log', message }),
          onProgress: progressEvents(out),
        })
        out.event({ type: 'setup.done', ok: true, message: `${record.tag} ${record.variant} → ${record.server}` })
        return 0
      } catch (err) {
        out.event({ type: 'setup.done', ok: false, message: err instanceof Error ? err.message : String(err) })
        return 1
      } finally {
        control.dispose()
      }
    }
    case 'status': {
      const status = await imageEngineStatus()
      const shared = await readImageShared()
      const live = shared && isAlive(shared.pid) ? shared : null
      const hw = await detectHardware()
      if (values.json) {
        console.log(JSON.stringify({ ...status, pinnedTag: SDCPP_TAG, shared: live, hardware: hw }))
        return 0
      }
      console.log(status.installed ? `installed: ${status.tag} (${status.variant})\n  ${status.server}` : `not installed (pinned tag ${SDCPP_TAG})`)
      console.log(`hardware: ${describeHardware(hw)}`)
      if (live) console.log(`warm: pid ${live.pid} port ${live.port} ${live.bundle ?? '(no model)'} (idle ${Math.round((Date.now() - live.lastUsed) / 1000)} s, TTL ${Math.round((live.idleTtlMs ?? DEFAULT_IMAGE_IDLE_TTL_MS) / 1000)} s)`)
      return 0
    }
    case 'stop': {
      const stopped = await stopAllImageEngines()
      console.log(`stopped ${stopped} image engine${stopped === 1 ? '' : 's'}`)
      return 0
    }
    case 'log': {
      console.log(serverLogPath())
      const tail = await logTail(serverLogPath(), 40)
      if (tail) console.log(tail)
      return 0
    }
    default:
      throw new UsageError(`image engine: unknown subcommand "${positionals[0] ?? ''}"\n\n${help}`)
  }
}
