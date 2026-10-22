// The demo page. Everything it does goes through the demo server, which runs the obrew CLI;
// every server message is one CLI message: {kind: 'event', event}, {kind: 'log', line} or
// {kind: 'exit', code}. The events are the ones a host app reads (image.*, download.*, setup.*).

const $ = (selector) => document.querySelector(selector)
const ASPECTS = ['16:9', '1:1', '9:16', '4:3', '3:4', '21:9']

const state = {
  useCases: [],
  useCase: null,
  models: null,
  status: null,
  /** The picture to start from: {name, url, mode: 'ref' | 'init'}. */
  input: null,
  busy: false,
  controller: null,
  failed: false,
  /** Thumbnail cards, redrawn when the title changes. */
  thumbnails: [],
}

// ------------------------------------------------------------------------------------------
// Talking to the server

/** POST, then read the answer as server-sent events, one CLI message per frame. */
async function stream(url, body, onMessage, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (frame.startsWith('data: ')) onMessage(JSON.parse(frame.slice(6)))
    }
  }
}

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`)
  return res.json()
}

// ------------------------------------------------------------------------------------------
// Status, models, use cases

const isInstalled = (id) => !!state.models?.presets?.some((p) => p.id === id && p.installed) || !!state.models?.bundles?.some((b) => b.id === id && b.complete)

async function refresh() {
  try {
    ;[state.status, state.models] = await Promise.all([getJson('/api/status'), getJson('/api/models')])
  } catch (err) {
    setStatus(false, `obrew did not answer: ${err.message}`)
    return
  }
  const img = state.status.image
  setStatus(img.ready, img.ready ? `ready · ${img.engine.variant} · ${img.model.default}` : 'image generation not set up')
  $('#setup').classList.toggle('hidden', img.ready)
  $('#go').disabled = !img.ready || state.busy
  const total = (state.models.presets ?? []).filter((p) => !p.installed).reduce((n, p) => n + p.downloadBytes, 0)
  if (total) $('#setup-hint').textContent = `Installs the engine and the default models from Hugging Face (up to ${bytes(total)}; downloads resume if interrupted).`

  const select = $('#model')
  const keep = select.value
  select.innerHTML = ''
  select.append(new Option(`Default (${state.models.default})`, 'default'))
  for (const p of state.models.presets ?? []) if (p.kind === 'generator' && p.installed) select.append(new Option(p.title, p.id))
  for (const b of state.models.bundles ?? []) if (!b.preset && b.kind === 'generator' && b.complete) select.append(new Option(b.title, b.id))
  if ([...select.options].some((o) => o.value === keep)) select.value = keep
  if (state.useCase) chooseModel(state.useCase)
}

function setStatus(ok, text) {
  const pill = $('#status')
  pill.textContent = text
  pill.className = `pill ${ok ? 'ok' : 'bad'}`
}

function chooseModel(useCase) {
  $('#model').value = isInstalled(useCase.model) ? useCase.model : 'default'
}

function renderUseCases() {
  const box = $('#use-cases')
  box.innerHTML = ''
  for (const uc of state.useCases) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = uc.label
    b.dataset.id = uc.id
    b.addEventListener('click', () => selectUseCase(uc))
    box.append(b)
  }
}

function selectUseCase(uc) {
  state.useCase = uc
  for (const b of $('#use-cases').children) b.setAttribute('aria-pressed', String(b.dataset.id === uc.id))
  $('#use-case-hint').textContent = uc.hint
  $('#prompt').placeholder = uc.example
  $('#aspect').value = uc.aspect
  $('#title-row').classList.toggle('hidden', !uc.title)
  chooseModel(uc)
}

// ------------------------------------------------------------------------------------------
// The input image (reference or image-to-image)

async function upload(file) {
  const res = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': file.type, 'x-filename': file.name }, body: file })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

function setInput(input) {
  state.input = input
  $('#input-mode').classList.toggle('hidden', !input)
  if (!input) {
    $('#drop').innerHTML = '<span>Drop an image here, or click to choose one</span>'
    $('#drop').append(fileInput())
    return
  }
  $('#drop').innerHTML = ''
  const img = new Image()
  img.src = input.url
  $('#drop').append(img, fileInput())
  for (const b of $('#input-mode .seg').querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === input.mode))
  $('#strength-row').classList.toggle('hidden', input.mode !== 'init')
  $('#input-hint').textContent =
    input.mode === 'ref'
      ? 'Reference: the model keeps what it sees (a character, a place) and changes what the prompt asks for.'
      : 'Image to image: the picture is redrawn; higher strength changes more.'
}

function fileInput() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp'
  input.hidden = true
  input.addEventListener('change', () => input.files[0] && pick(input.files[0]))
  return input
}

async function pick(file) {
  try {
    const saved = await upload(file)
    setInput({ ...saved, mode: state.input?.mode ?? 'ref' })
  } catch (err) {
    showError(`upload failed: ${err.message}`)
  }
}

// ------------------------------------------------------------------------------------------
// Running jobs

function startJob(title) {
  state.busy = true
  state.failed = false
  state.controller = new AbortController()
  $('#go').disabled = true
  $('#cancel').disabled = false
  $('#setup-go').disabled = true
  $('#job-title').textContent = title
  $('#error').classList.add('hidden')
  $('#log').textContent = ''
  $('#preview').classList.add('hidden')
  $('#shot-empty').classList.remove('hidden')
  setProgress(null, 'Starting…')
}

function endJob() {
  state.busy = false
  state.controller = null
  $('#cancel').disabled = true
  $('#setup-go').disabled = false
  $('#go').disabled = !state.status?.image?.ready
}

function setProgress(fraction, text) {
  const bar = $('#bar')
  bar.classList.toggle('busy', fraction === null)
  bar.firstElementChild.style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`
  if (text) $('#phase').textContent = text
}

function showError(text) {
  state.failed = true
  const box = $('#error')
  box.textContent = text
  box.classList.remove('hidden')
}

function log(line) {
  const box = $('#log')
  box.textContent += `${line}\n`
  box.scrollTop = box.scrollHeight
}

const bytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${(n / (1 << 20)).toFixed(0)} MB`)

/** One CLI message → the page. `job` carries what cards need to know (the thumbnail title). */
function onMessage(msg, job) {
  if (msg.kind === 'log') return log(msg.line)
  if (msg.kind === 'exit') {
    if (msg.code !== 0 && !state.failed) showError(`obrew exited with ${msg.code}; see the CLI output`)
    return
  }
  const e = msg.event
  switch (e.type) {
    case 'engine.status':
      return setProgress(null, e.detail ?? (e.state === 'starting' ? 'Starting the image engine…' : e.state === 'loading' ? 'Loading the model…' : 'Engine ready'))
    case 'download.plan':
      job.total = e.totalBytes
      job.done = {}
      return setProgress(e.totalBytes ? 0 : null, e.totalBytes ? `Downloading ${bytes(e.totalBytes)}…` : 'Everything is already downloaded')
    case 'download.progress': {
      job.done ??= {}
      job.done[e.file] = e.received
      const got = Object.values(job.done).reduce((a, b) => a + b, 0)
      return job.total ? setProgress(Math.min(1, got / job.total), `Downloading ${e.file} · ${bytes(got)} of ${bytes(job.total)}`) : setProgress(e.total ? e.received / e.total : null, `Downloading ${e.file}`)
    }
    case 'setup.log':
      return log(e.message)
    case 'setup.done':
      if (!e.ok) showError(e.message)
      else setProgress(1, 'Set up: image generation is ready')
      return refresh()
    case 'image.started':
      job.count = e.count
      $('#job-title').textContent = `${e.mode === 'upscale' ? 'Upscaling' : e.mode === 'edit' ? 'Editing' : e.mode === 'img2img' ? 'Redrawing' : 'Generating'} · ${e.width}×${e.height} · ${e.model}${e.seed !== null ? ` · seed ${e.seed}` : ''}`
      return setProgress(null, e.mode === 'upscale' ? 'Upscaling…' : 'Starting…')
    case 'image.progress': {
      const which = job.count > 1 ? `Image ${e.index + 1} of ${job.count} · ` : ''
      if (e.phase === 'queued') return setProgress(null, `${which}queued${e.position ? ` (position ${e.position})` : ''}`)
      if (e.phase === 'upscaling') return setProgress(null, `${which}upscaling…`)
      if (e.phase === 'decoding') return setProgress(1, `${which}decoding…`)
      return e.step ? setProgress(e.step / e.steps, `${which}step ${e.step} of ${e.steps}`) : setProgress(null, `${which}encoding the prompt…`)
    }
    case 'image.preview':
      $('#preview').src = `data:image/png;base64,${e.b64}`
      $('#preview').classList.remove('hidden')
      $('#shot-empty').classList.add('hidden')
      return
    case 'image.saved':
      $('#preview').src = e.url
      $('#preview').classList.remove('hidden')
      return addCard(e, job)
    case 'image.completed':
      return setProgress(1, `Done in ${(e.durationMs / 1000).toFixed(1)} s`)
    case 'image.failed':
      showError(`${e.code}: ${e.message}`)
      return setProgress(0, 'Failed')
  }
}

async function run(url, body, job) {
  startJob(job.title)
  try {
    await stream(url, body, (msg) => onMessage(msg, job), state.controller.signal)
  } catch (err) {
    if (err.name === 'AbortError') setProgress(0, 'Cancelled')
    else showError(err.message)
  } finally {
    endJob()
  }
}

function seedValue() {
  const s = $('#seed').value.trim()
  return s === '' ? undefined : Number(s)
}

function generate(overrides = {}) {
  if (state.busy || !state.useCase) return
  const uc = state.useCase
  const text = $('#prompt').value.trim() || uc.example
  const body = {
    prompt: `${text}, ${uc.suffix}`,
    negativePrompt: uc.negative,
    model: $('#model').value,
    aspect: $('#aspect').value,
    seed: seedValue(),
    count: Number($('#count').value),
  }
  if ($('#fullhd').checked && body.aspect === '16:9') body.size = '1920x1080'
  if (state.input?.mode === 'ref') body.refs = [state.input.name]
  if (state.input?.mode === 'init') {
    body.image = state.input.name
    body.strength = Number($('#strength').value)
  }
  Object.assign(body, overrides)
  void run('/api/generate', body, { title: 'Generating…', thumbnail: !!uc.title, prompt: text, body })
}

// ------------------------------------------------------------------------------------------
// Results

/**
 * The thumbnail pattern: the model paints the art, the page sets the title in real type, so it
 * is exact, editable and on-brand. A dark gradient on the left keeps it legible.
 */
function drawThumbnail(canvas, img, title) {
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const text = title.trim().toUpperCase()
  if (!text) return
  const w = canvas.width
  const h = canvas.height
  const shade = ctx.createLinearGradient(0, 0, w * 0.62, 0)
  shade.addColorStop(0, 'rgba(0,0,0,0.78)')
  shade.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, w * 0.62, h)
  // The largest size at which the title fits 46% of the width in at most three lines.
  const maxWidth = w * 0.46
  let size = Math.round(h * 0.16)
  let lines = []
  for (; size > 12; size -= 2) {
    ctx.font = `900 ${size}px system-ui, -apple-system, 'Segoe UI', sans-serif`
    lines = []
    let line = ''
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width <= maxWidth || !line) line = next
      else {
        lines.push(line)
        line = word
      }
    }
    if (line) lines.push(line)
    if (lines.length <= 3 && lines.every((l) => ctx.measureText(l).width <= maxWidth)) break
  }
  const lineHeight = size * 1.05
  let y = h / 2 - ((lines.length - 1) * lineHeight) / 2
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = size * 0.25
  for (const l of lines) {
    ctx.fillText(l, w * 0.05, y)
    y += lineHeight
  }
}

function addCard(e, job) {
  $('#empty')?.remove()
  const card = document.createElement('div')
  card.className = 'card'
  const media = document.createElement('div')
  media.className = 'media'
  const img = new Image()
  img.src = e.url
  img.alt = job.prompt ?? 'generated image'
  if (job.thumbnail) {
    const canvas = document.createElement('canvas')
    img.onload = () => drawThumbnail(canvas, img, $('#title').value)
    media.append(canvas)
    state.thumbnails.push({ canvas, img })
  } else {
    media.append(img)
  }
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = `${e.width}×${e.height} · ${e.model}${e.seed !== null ? ` · seed ${e.seed}` : ''} · ${(e.durationMs / 1000).toFixed(1)} s`
  const actions = document.createElement('div')
  actions.className = 'actions'
  const button = (label, onClick) => {
    const b = document.createElement('button')
    b.className = 'btn small'
    b.textContent = label
    b.addEventListener('click', onClick)
    actions.append(b)
    return b
  }
  button('Upscale ×2', () => run('/api/upscale', { file: e.name, scale: 2 }, { title: 'Upscaling…' }))
  button('Same character, new scene', () => {
    setInput({ name: e.name, url: e.url, mode: 'ref' })
    $('#prompt').value = ''
    $('#prompt').placeholder = 'the same character, now …'
    $('#prompt').focus()
  })
  // The same request again, with this image as its reference and a fresh seed.
  button('Vary', () =>
    job.body
      ? run('/api/generate', { ...job.body, refs: [e.name], image: undefined, strength: undefined, seed: undefined, count: 1 }, { ...job, title: 'Varying…' })
      : generate({ refs: [e.name], image: undefined, seed: undefined }),
  )
  const download = document.createElement('a')
  download.className = 'btn small'
  download.href = e.url
  download.download = e.name.split('/').pop()
  download.textContent = 'Download'
  actions.append(download)
  if (job.thumbnail) {
    button('Download thumbnail', () => {
      const entry = state.thumbnails.find((t) => t.img === img)
      entry.canvas.toBlob((blob) => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `thumbnail-${e.seed ?? 'image'}.png`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      }, 'image/png')
    })
  }
  card.append(media, meta, actions)
  $('#gallery').prepend(card)
}

// ------------------------------------------------------------------------------------------
// Wiring

function wire() {
  for (const a of ASPECTS) $('#aspect').append(new Option(a, a))
  $('#go').addEventListener('click', () => generate())
  $('#cancel').addEventListener('click', () => state.controller?.abort())
  $('#setup-go').addEventListener('click', () => run('/api/setup', {}, { title: 'Setting up image generation' }))
  $('#title').addEventListener('input', () => {
    for (const t of state.thumbnails) if (t.img.complete) drawThumbnail(t.canvas, t.img, $('#title').value)
  })
  $('#strength').addEventListener('input', () => ($('#strength-value').textContent = $('#strength').value))
  $('#prompt').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) generate()
  })
  for (const b of document.querySelectorAll('#input-mode [data-mode]')) {
    b.addEventListener('click', () => state.input && setInput({ ...state.input, mode: b.dataset.mode }))
  }
  $('#input-clear').addEventListener('click', () => setInput(null))
  const drop = $('#drop')
  drop.addEventListener('click', (ev) => {
    if (ev.target.tagName !== 'INPUT') drop.querySelector('input[type=file]').click()
  })
  drop.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && drop.querySelector('input[type=file]').click())
  drop.addEventListener('dragover', (ev) => {
    ev.preventDefault()
    drop.classList.add('over')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('over'))
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault()
    drop.classList.remove('over')
    const file = ev.dataTransfer.files[0]
    if (file) void pick(file)
  })
  drop.querySelector('input[type=file]').addEventListener('change', (ev) => ev.target.files[0] && pick(ev.target.files[0]))
}

async function main() {
  wire()
  state.useCases = await getJson('/api/use-cases')
  renderUseCases()
  selectUseCase(state.useCases[0])
  await refresh()
}

void main()
