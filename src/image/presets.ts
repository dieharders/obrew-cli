/**
 * The curated image models: what `obrew image setup` installs and `models list` offers.
 *
 * Every default is permissively licensed (Apache-2.0 / BSD-3-Clause here), ungated on Hugging
 * Face (no token), and pinned: repository, commit, path, SHA-256 and size per file, so a repo
 * that re-uploads a file under the same name cannot change what a preset installs. Data, not
 * code: re-pinning is `bun run scripts/image-presets.ts`, which prints these entries from the Hub.
 * See docs/image-generation.md for why these. `optional` presets are not part of `setup`.
 *
 * A diffusion model needs more than its weights. Z-Image and FLUX.2 klein both condition on the
 * Qwen3-4B language model (the ORIGINAL Qwen3-4B: Z-Image's own text-encoder shards are byte for
 * byte Qwen/Qwen3-4B, and Comfy-Org ships the identical file for klein), so the two share one
 * 2.5 GB file; the registry keys files by hash and stores it once.
 *
 * `small` is the file used when the memory budget is below 7.5 GiB (6 GB-class GPUs; an "8 GB"
 * card reports about 7.99 GiB and gets the default).
 */
import { GIB } from './engine/hardware'

/** `tokenizer` is a `tokenizer.json` for the `llm`, when its vocabulary differs from the one sd.cpp embeds (Qwen3.5). */
export const ROLES = ['diffusion', 'model', 'llm', 'vae', 't5xxl', 'clip_l', 'clip_g', 'tokenizer', 'upscaler'] as const
export type Role = (typeof ROLES)[number]

export interface PinnedFile {
  repo: string
  revision: string
  path: string
  sha256: string
  size: number
}

export interface PresetComponent {
  role: Role
  file: PinnedFile
  small?: PinnedFile
}

export interface Caps {
  /** Text to image. */
  generate: boolean
  /** An init image plus a strength. */
  img2img: boolean
  /** Reference images (`--ref`): edits, variations, the same character in a new scene. */
  edit: boolean
  /** An ESRGAN upscaler, for `POST /sdcpp/v1/upscale`. */
  upscale: boolean
  maxRefs: number
  /** An upscaler's factor. */
  scale?: number
}

export interface Defaults {
  steps: number
  cfg: number
  sampler?: string
}

export type BundleKind = 'generator' | 'upscaler'

export interface Preset {
  id: string
  title: string
  description: string
  kind: BundleKind
  license: string
  homepage: string
  components: PresetComponent[]
  defaults: Defaults
  caps: Caps
  /** Width and height must be multiples of this. */
  align: number
  /** The largest image generated natively; anything larger is generated smaller and upscaled. */
  maxPixels: number
  /** What it is good at, for a host's picker. */
  uses: string[]
  /** Not part of `image setup`: installed on request with `image models pull <id>` or `setup --model <id>`. */
  optional?: boolean
}

const QWEN3_4B: PinnedFile = {
  repo: 'unsloth/Qwen3-4B-GGUF',
  revision: '22c9fc8a8c7700b76a1789366280a6a5a1ad1120',
  path: 'Qwen3-4B-Q4_K_M.gguf',
  sha256: 'f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a',
  size: 2_497_281_312,
}

export const PRESETS: Preset[] = [
  {
    id: 'z-image-turbo',
    title: 'Z-Image-Turbo',
    description: 'Tongyi-MAI, 6B single-stream DiT. Best photorealism of the permissive models that fit 8 GB; English and Chinese text. 8 steps.',
    kind: 'generator',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
    components: [
      {
        role: 'diffusion',
        file: {
          repo: 'leejet/Z-Image-Turbo-GGUF',
          revision: 'c61c0e422dc8b541b7548cf33a4ef8302b0f8085',
          path: 'z_image_turbo-Q5_0.gguf',
          sha256: '12b4a5c064cf8a0fa45d665c5b399d43effbcbeb37748d028d0d0d0fc34c2255',
          size: 4_542_547_904,
        },
        small: {
          repo: 'leejet/Z-Image-Turbo-GGUF',
          revision: 'c61c0e422dc8b541b7548cf33a4ef8302b0f8085',
          path: 'z_image_turbo-Q4_K.gguf',
          sha256: '14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd',
          size: 3_864_250_304,
        },
      },
      { role: 'llm', file: QWEN3_4B },
      {
        // FLUX.1's autoencoder. Byte-identical to the one in the gated FLUX.1-schnell repo.
        role: 'vae',
        file: {
          repo: 'Comfy-Org/z_image_turbo',
          revision: '6fc90a3b1b653e935a0d175e260736de25b84df5',
          path: 'split_files/vae/ae.safetensors',
          sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38',
          size: 335_304_388,
        },
      },
    ],
    defaults: { steps: 8, cfg: 1 },
    caps: { generate: true, img2img: true, edit: false, upscale: false, maxRefs: 0 },
    align: 16,
    maxPixels: 2_200_000,
    uses: ['photoreal', 'architecture', 'character', 'thumbnail'],
  },
  {
    id: 'flux2-klein-4b',
    title: 'FLUX.2 [klein] 4B',
    description: 'Black Forest Labs, 4B. Fast (4 steps); one model generates and edits with reference images, e.g. the same character in a new scene.',
    kind: 'generator',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B',
    components: [
      {
        role: 'diffusion',
        file: {
          repo: 'leejet/FLUX.2-klein-4B-GGUF',
          revision: '3b1f5a9dc3abb32238b053aeb3d823c30afdacbd',
          path: 'flux-2-klein-4b-Q8_0.gguf',
          sha256: '0bba6951258ec8f92d51114a8fa13e66828297bfff58a738f52729b3ef66fa28',
          size: 4_300_629_440,
        },
        small: {
          repo: 'leejet/FLUX.2-klein-4B-GGUF',
          revision: '3b1f5a9dc3abb32238b053aeb3d823c30afdacbd',
          path: 'flux-2-klein-4b-Q4_0.gguf',
          sha256: 'd1023499ef3f2f82ff7c50e6778495195c1b6cc34835741778868428111f9ff4',
          size: 2_460_378_560,
        },
      },
      { role: 'llm', file: QWEN3_4B },
      {
        // Apache-2.0. sd.cpp's FLUX.2 doc links the VAE in the gated, non-commercial FLUX.2-dev
        // repo; this is BFL's permissive alternative, which sd.cpp also accepts.
        role: 'vae',
        file: {
          repo: 'black-forest-labs/FLUX.2-small-decoder',
          revision: 'a3efc24f613ef42d9428af62fdbd6f5fd8856c4a',
          path: 'full_encoder_small_decoder.safetensors',
          sha256: 'ea4273f02d1fafbf8e1d1c2cf6018ed8748652eb0bf34f2dd91171f16f15ab62',
          size: 249_519_092,
        },
      },
    ],
    defaults: { steps: 4, cfg: 1, sampler: 'euler' },
    caps: { generate: true, img2img: true, edit: true, upscale: false, maxRefs: 4 },
    align: 16,
    maxPixels: 2_200_000,
    uses: ['edit', 'character', 'draft', 'abstract'],
  },
  {
    // Optional: 9.4 GB, 50 steps at CFG 3, so it is slow on Apple Silicon and the CPU. Pulled on
    // request. sd.cpp runs it since master-982 (#2148); the tokenizer must be passed separately
    // because Qwen3.5's vocabulary differs from the Qwen tokenizer sd.cpp embeds. Unsloth's
    // mixed-precision `UD` quants: LPIPS 0.21 vs bf16 for UD-Q4_K_XL against 0.29 for Q4_K_M.
    id: 'moss-image-sft',
    title: 'MOSS-Image SFT',
    description: 'OpenMOSS, 5B DiT on a Qwen3.5-9B encoder. Renders text and follows layouts (tags, JSON bounding boxes); English and Chinese. 50 steps, CFG 3: slow, 9.4 GB.',
    kind: 'generator',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT',
    components: [
      {
        role: 'diffusion',
        file: {
          repo: 'unsloth/MOSS-Image-SFT-GGUF',
          revision: 'a013f7442e672e67b21f485b4b4f369df5500847',
          path: 'MOSS-Image-SFT-UD-Q4_K_XL.gguf',
          sha256: 'efe318d6ba48e9012fc650f642f9956e6ea382ee4098a6d7e903455ba2d58f0f',
          size: 3_419_844_768,
        },
        small: {
          repo: 'unsloth/MOSS-Image-SFT-GGUF',
          revision: 'a013f7442e672e67b21f485b4b4f369df5500847',
          path: 'MOSS-Image-SFT-UD-Q3_K_XL.gguf',
          sha256: 'd232a9b20bc650286035cc81eac42b0332c418c2026d9dc8c8f1f742a96b1583',
          size: 2_839_752_864,
        },
      },
      {
        // The text encoder is Qwen3.5-9B, not the Qwen3-4B the other two share.
        role: 'llm',
        file: {
          repo: 'unsloth/Qwen3.5-9B-GGUF',
          revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
          path: 'Qwen3.5-9B-Q4_K_M.gguf',
          sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
          size: 5_680_522_464,
        },
        small: {
          repo: 'unsloth/Qwen3.5-9B-GGUF',
          revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
          path: 'Qwen3.5-9B-Q3_K_M.gguf',
          sha256: '8fed90306e4f019e2bf35f3766470b7bc59ea1a9dae00f5ceb20b43cb5514393',
          size: 4_673_643_744,
        },
      },
      {
        // The FLUX.2 VAE with the small decoder, as MOSS ships it, in sd.cpp's layout (the file
        // sd.cpp's MOSS page points at). Apache-2.0.
        role: 'vae',
        file: {
          repo: 'Comfy-Org/MOSS-Image',
          revision: '530a4c94f92c35ef6818b1b035a983fe9dcf5f54',
          path: 'vae/flux2-vae_small.safetensors',
          sha256: 'd8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b',
          size: 249_521_340,
        },
      },
      {
        role: 'tokenizer',
        file: {
          repo: 'OpenMOSS-Team/MOSS-Image-SFT',
          revision: 'f972bd4b4b9e3852133cc5da954d87bc32cd8fb9',
          path: 'tokenizer/tokenizer.json',
          sha256: '06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523',
          size: 19_989_325,
        },
      },
    ],
    // Upstream's settings: 50 steps, CFG 3, flow shift 5 (sd.cpp's default for this model).
    defaults: { steps: 50, cfg: 3, sampler: 'euler' },
    caps: { generate: true, img2img: true, edit: false, upscale: false, maxRefs: 0 },
    align: 16,
    // Trained around 1 MP; larger sizes go through the upscaler.
    maxPixels: 1_100_000,
    uses: ['text', 'poster', 'layout', 'thumbnail'],
    optional: true,
  },
  {
    id: 'realesrgan-x4plus',
    title: 'Real-ESRGAN x4plus',
    description: '4× super-resolution, run by the same engine. Exact sizes such as 1920×1080 come from resampling its output.',
    kind: 'upscaler',
    license: 'BSD-3-Clause',
    homepage: 'https://github.com/xinntao/Real-ESRGAN',
    components: [
      {
        role: 'upscaler',
        file: {
          repo: 'Comfy-Org/Real-ESRGAN_repackaged',
          revision: '5fd49b7b278836f48af63ecd314d0f98ab336105',
          path: 'RealESRGAN_x4plus.safetensors',
          sha256: '37f9a931c215f040aa6d50f711f2cb115f713c46df1d0d6469a8bd7bfe9a60bb',
          size: 66_857_836,
        },
      },
    ],
    defaults: { steps: 0, cfg: 0 },
    caps: { generate: false, img2img: false, edit: false, upscale: true, maxRefs: 0, scale: 4 },
    align: 1,
    maxPixels: 0,
    uses: ['upscale'],
  },
]

export const DEFAULT_GENERATOR = 'z-image-turbo'
export const DEFAULT_EDITOR = 'flux2-klein-4b'
export const DEFAULT_UPSCALER = 'realesrgan-x4plus'

/** Below this memory budget the `small` files are used. */
export const SMALL_TIER_BELOW = 7.5 * GIB

export type Tier = 'default' | 'small'

/** Unknown budget (CPU-only, an iGPU): the default files, which run from system RAM either way. */
export const tierFor = (budgetBytes: number | null): Tier => (budgetBytes !== null && budgetBytes < SMALL_TIER_BELOW ? 'small' : 'default')

export const findPreset = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id)

export function presetFiles(preset: Preset, tier: Tier): Array<{ role: Role; file: PinnedFile }> {
  return preset.components.map((c) => ({ role: c.role, file: tier === 'small' && c.small ? c.small : c.file }))
}

/** Bytes a preset downloads at a tier (shared files counted once per preset). */
export const presetBytes = (preset: Preset, tier: Tier): number => presetFiles(preset, tier).reduce((n, c) => n + c.file.size, 0)
