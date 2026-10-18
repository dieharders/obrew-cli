/**
 * Voice packs: the Qwen3-TTS GGUF pairs obrew can speak with.
 *
 * A pack is a talker model plus the shared 12 Hz codec, both from one Hugging Face repo
 * (Serveurperso/Qwen3-TTS-GGUF, the conversions qwentts.cpp is built against). Pulled files
 * live flat under `<data>/models/tts/<org>--<repo>/`, the way chat models do; there is no
 * registry file because the pack list is fixed in this build and "installed" is "both files
 * are on disk". The active pack is one line in config.json (`ttsPack`).
 *
 * Three kinds, by what the talker was trained for:
 *   customvoice — nine named speakers, no reference audio needed. The default.
 *   base        — zero-shot voice cloning from a short reference clip.
 *   voicedesign — a voice from a text description (1.7B only).
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { authHeaders, fileName, listRepoFiles, resolveUrl, type HfFile } from '../models/hf'
import { loadConfig, saveConfig, type Config } from '../shared/config'
import { downloadVerified } from '../shared/download'
import { ObrewError } from '../shared/errors'
import { dataDir } from '../shared/paths'

export const TTS_REPO = 'Serveurperso/Qwen3-TTS-GGUF'
const CODEC = 'qwen-tokenizer-12hz-Q8_0.gguf'

/** The CustomVoice speakers Qwen3-TTS ships. `eric` and `dylan` carry dialect overrides upstream. */
export const QWEN_SPEAKERS = ['ryan', 'vivian', 'serena', 'aiden', 'eric', 'dylan', 'uncle_fu', 'ono_anna', 'sohee'] as const

export type PackKind = 'customvoice' | 'base' | 'voicedesign'

export interface VoicePack {
  id: string
  label: string
  repo: string
  /** Talker GGUF file name in the repo. */
  talker: string
  /** Codec GGUF file name in the repo. */
  codec: string
  kind: PackKind
  size: '0.6b' | '1.7b'
  /** Named speakers the pack answers to (`voice` in a request). Empty for cloning packs. */
  speakers: readonly string[]
  description: string
}

const pack = (id: string, size: '0.6b' | '1.7b', kind: PackKind, talker: string, label: string, description: string): VoicePack => ({
  id,
  label,
  repo: TTS_REPO,
  talker,
  codec: CODEC,
  kind,
  size,
  speakers: kind === 'customvoice' ? QWEN_SPEAKERS : [],
  description,
})

export const VOICE_PACKS: readonly VoicePack[] = [
  pack('qwen3-tts-0.6b-customvoice', '0.6b', 'customvoice', 'qwen-talker-0.6b-customvoice-Q8_0.gguf', 'Qwen3-TTS 0.6B · named voices', 'Nine built-in speakers, 10 languages. ~1.3 GB. The default.'),
  pack('qwen3-tts-0.6b-base', '0.6b', 'base', 'qwen-talker-0.6b-base-Q8_0.gguf', 'Qwen3-TTS 0.6B · voice cloning', 'Clone a voice from a short reference clip. ~1.3 GB.'),
  pack('qwen3-tts-1.7b-customvoice', '1.7b', 'customvoice', 'qwen-talker-1.7b-customvoice-Q8_0.gguf', 'Qwen3-TTS 1.7B · named voices', 'Higher quality named speakers; needs a GPU for real time. ~2.3 GB.'),
  pack('qwen3-tts-1.7b-base', '1.7b', 'base', 'qwen-talker-1.7b-base-Q8_0.gguf', 'Qwen3-TTS 1.7B · voice cloning', 'Higher quality cloning; needs a GPU for real time. ~2.3 GB.'),
  pack('qwen3-tts-1.7b-voicedesign', '1.7b', 'voicedesign', 'qwen-talker-1.7b-voicedesign-Q8_0.gguf', 'Qwen3-TTS 1.7B · voice design', 'Describe a voice in words. Needs a GPU for real time. ~2.3 GB.'),
]

export const DEFAULT_PACK = 'qwen3-tts-0.6b-customvoice'

export const ttsModelsDir = () => join(dataDir(), 'models', 'tts')
const repoDir = (repoId: string) => join(ttsModelsDir(), repoId.replace('/', '--'))

export function findPack(id: string): VoicePack | null {
  return VOICE_PACKS.find((p) => p.id === id) ?? null
}

export function requirePack(id: string): VoicePack {
  const found = findPack(id)
  if (!found) throw new ObrewError('bad_request', `"${id}" is not a voice pack. Known: ${VOICE_PACKS.map((p) => p.id).join(', ')}`)
  return found
}

export interface PackFiles {
  talker: string
  codec: string
}

/** Where a pack's files live (whether or not they are there yet). */
export function packFiles(pack: VoicePack): PackFiles {
  return { talker: join(repoDir(pack.repo), pack.talker), codec: join(repoDir(pack.repo), pack.codec) }
}

const exists = async (path: string) => {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

export async function isPackInstalled(pack: VoicePack): Promise<boolean> {
  const files = packFiles(pack)
  return (await exists(files.talker)) && (await exists(files.codec))
}

export async function installedPacks(): Promise<VoicePack[]> {
  const out: VoicePack[] = []
  for (const pack of VOICE_PACKS) if (await isPackInstalled(pack)) out.push(pack)
  return out
}

/**
 * The pack `tts` and `serve` speak with: the chosen one, else the default, else the first
 * installed one. Throws `model_missing` with the pull command when nothing is on disk.
 */
export async function activePack(config?: Config): Promise<VoicePack> {
  const cfg = config ?? (await loadConfig())
  const chosen = cfg.ttsPack ? findPack(cfg.ttsPack) : null
  if (chosen && (await isPackInstalled(chosen))) return chosen
  const dflt = findPack(DEFAULT_PACK)!
  if (await isPackInstalled(dflt)) return dflt
  const any = (await installedPacks())[0]
  if (any) return any
  throw new ObrewError('model_missing', `no voice pack is installed; run \`obrew voices pull ${chosen?.id ?? DEFAULT_PACK}\``)
}

export interface PullPackOptions {
  token?: string
  signal: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (file: string, received: number, total: number) => void
}

async function fetchOne(repoId: string, file: HfFile, dest: string, opts: PullPackOptions): Promise<void> {
  if (file.size > 0 && (await exists(dest)) && (await stat(dest)).size === file.size) {
    opts.onLog?.(`${file.path} already present`)
    return
  }
  opts.onLog?.(`downloading ${repoId}/${file.path}`)
  await downloadVerified(
    { url: resolveUrl(repoId, file.path), sha256: file.sha256, size: file.size, dest, headers: authHeaders(opts.token) },
    opts.signal,
    (received, total) => opts.onProgress?.(file.path, received, total),
  )
}

/** Download a pack's talker and codec (the codec is shared, so a second pack reuses it). */
export async function pullPack(id: string, opts: PullPackOptions): Promise<VoicePack> {
  const pack = requirePack(id)
  const files = await listRepoFiles(pack.repo, opts.token, opts.signal)
  const want = (name: string): HfFile => {
    const found = files.find((f) => fileName(f.path) === name)
    if (!found) throw new ObrewError('bad_request', `${pack.repo} no longer publishes ${name}`)
    return found
  }
  const paths = packFiles(pack)
  // Codec first: small, shared, and a failure on it costs no model download.
  await fetchOne(pack.repo, want(pack.codec), paths.codec, opts)
  await fetchOne(pack.repo, want(pack.talker), paths.talker, opts)
  opts.onLog?.(`installed voice pack ${pack.id}`)
  return pack
}

export async function usePack(id: string): Promise<VoicePack> {
  const pack = requirePack(id)
  if (!(await isPackInstalled(pack))) throw new ObrewError('model_missing', `${pack.id} is not installed; run \`obrew voices pull ${pack.id}\``)
  await saveConfig({ ...(await loadConfig()), ttsPack: pack.id })
  return pack
}

/** Remove a pack's talker. The codec stays while another installed pack still needs it. */
export async function removePack(id: string): Promise<VoicePack> {
  const pack = requirePack(id)
  const { rm } = await import('node:fs/promises')
  const paths = packFiles(pack)
  await rm(paths.talker, { force: true })
  const others = (await installedPacks()).filter((p) => p.id !== pack.id && p.codec === pack.codec && p.repo === pack.repo)
  if (others.length === 0) await rm(paths.codec, { force: true })
  const config = await loadConfig()
  if (config.ttsPack === pack.id) await saveConfig({ ...config, ttsPack: undefined })
  return pack
}
