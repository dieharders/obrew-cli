# Local image generation for obrew-cli

**Architectures, models and runtimes compared — October 2026**

This report compares the ways obrew-cli could generate images on the user's own machine, so host
apps — starting with MotionBuff — can ask for thumbnails, character art, photorealistic scenes,
architecture renders and abstract art. It covers six model architectures, roughly sixty models and
ten runtimes, filters them through obrew's constraints, recommends an engine, a default model and
a small curated catalog, and summarises how the feature plugs into obrew (§9).

Research date: 2026-10-22. Sources are linked inline and listed in §11. Benchmark scores are
vendor-reported unless marked otherwise; "AA Elo" is the
[Artificial Analysis text-to-image arena](https://artificialanalysis.ai/text-to-image/arena/leaderboard-text)
(v2.1, FLUX.2 [dev] fixed at 1000). Nothing here is legal advice.

## 1. Recommendation in brief

| Decision                 | Recommendation                                                                                                                                                            | Why                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine                   | **stable-diffusion.cpp `sd-server`** (MIT), pinned to a tested release, run as its own module beside the llama.cpp text engine                                            | The only native engine with prebuilt CUDA, Vulkan, ROCm, Metal and CPU builds; keeps the model loaded; OpenAI-compatible API plus a job API with step progress and cancel; day-0 support for most 2026 models |
| Default model            | **Z-Image-Turbo** (Tongyi-MAI, Apache-2.0)                                                                                                                                | Highest human-preference score of any permissively licensed model that fits 8 GB (AA Elo 936); 8 steps; strong photorealism and English/Chinese text; ungated on Hugging Face                                 |
| Editing and fast drafts  | **FLUX.2 [klein] 4B** (Black Forest Labs, Apache-2.0)                                                                                                                     | 4 steps; the smallest modern model (Q8 4.3 GB); one model does generation and multi-reference editing (consistent characters across scenes); AA Elo 837                                                       |
| Upscaling                | **Real-ESRGAN x4plus** (BSD-3-Clause), run inside the same engine                                                                                                         | ×4 super-resolution; exact sizes such as 1920×1080 by resampling the ×4 result                                                                                                                                |
| Text-heavy alternate     | **ERNIE-Image-Turbo** (Baidu, Apache-2.0)                                                                                                                                 | Best in-image text of the 8 GB-capable permissive models (LongText 0.966, OneIG text 0.967); AA Elo 914                                                                                                       |
| Low-end, CPU-only, anime | **SDXL family** (OpenRAIL++): DreamShaper XL v2 Turbo, or RealVisXL V5 with SDXL-Lightning; **Animagine XL 4.0** for anime; SD 1.5 + LCM-LoRA as the last-resort CPU path | Runs on every runtime and on CPU; few-step distills keep CPU times tolerable; large LoRA ecosystem                                                                                                            |
| Thumbnails               | Let the host render title text (MotionBuff already composes HTML frames) and ask the model for the art; use ERNIE when text must be inside the image                      | No permissive 8 GB model renders every title reliably; host-rendered text is exact, editable and on-brand                                                                                                     |

Main risks: Apple Silicon (stable-diffusion.cpp's Metal path has open correctness bugs and little
speed data), stable-diffusion.cpp's churn (a release per merged commit; flags get renamed), the
Windows CUDA download (~865 MB against 28 MB for Vulkan), and CPU speed for modern 4–8B models
(minutes per image). §10 lists a short benchmark.

## 2. Requirements and how they were applied

| Requirement                        | How it was applied                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum 8 GB VRAM                  | Weights + activations must fit 8 GB at ~1 MP after quantization (GGUF Q4–Q8), with the text encoder run first and then freed or kept on the CPU |
| NVIDIA and AMD GPUs, Apple Silicon | The engine needs a GPU path for all three on Windows, Linux and macOS                                                                           |
| CPU fallback (preferred)           | The engine needs a CPU backend; a small-model tier keeps CPU-only machines usable                                                               |
| Hugging Face downloads (preferred) | Every recommended file is on HF; ungated repos preferred so no token is needed                                                                  |
| Open source / free to include      | Engine: MIT / Apache / BSD. Default models: permissive with no revenue cap — Apache-2.0, MIT, OpenRAIL family                                   |
| Native binary (decision)           | Python runtimes (diffusers, mflux, ComfyUI) are compared but not recommended                                                                    |
| Its own module (decision)          | Not tied to llama.cpp or the text engine's conventions                                                                                          |

## 3. Architectures compared

An image model has three parts: a **text encoder** that turns the prompt into vectors, a
**denoiser** (a UNet or a transformer) that iterates from noise to an image, and usually a **VAE**
that decodes the denoiser's compressed latent into pixels. Distilled "Turbo / Lightning" variants
cut sampling from 25–50 steps to 1–16. GGUF quantization shrinks weights 2–4× for a small quality
cost.

| Family                                                 | Examples                                                                                     | How it works                                                                                                                         | Prompt adherence and text                                                       | Memory at ~1 MP                                                                | Speed                                               | Native runtime support                       | Verdict                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------- | --------------------------------------- |
| UNet latent diffusion (2022–23)                        | SD 1.5, SDXL and fine-tunes                                                                  | Convolutional UNet, CLIP text encoders, 8× VAE                                                                                       | Weak: SDXL GenEval 0.55, DPG 74.7; no legible text                              | SD 1.5 ~2 GB; SDXL 4–7 GB                                                      | 1–8 steps with distills; CPU-feasible at 512–768 px | Everywhere (sd.cpp, Core ML, OpenVINO, ONNX) | Keep as the low-end, CPU and anime tier |
| MMDiT with CLIP/T5 encoders (2024)                     | SD3.5, FLUX.1, Chroma                                                                        | Dual-stream transformer, rectified flow, T5-XXL (4.7B) encoder                                                                       | Better; short text fine, long text weak (FLUX.1 [dev] LongText 0.61)            | FLUX.1 Q4 ~6.4 GB + T5                                                         | 4 (schnell) to 40 steps                             | sd.cpp                                       | Superseded by the next row              |
| **Single-stream DiT + LLM/VLM text encoder (2025–26)** | Z-Image, ERNIE-Image, FLUX.2 / FLUX.3 klein, Qwen-Image 2.1, Ideogram 4, MOSS, Boogu, Krea 2 | Text and image tokens in one transformer stream; a 3–9B LLM (Qwen3, Ministral, Qwen3-VL) encodes the prompt; shared FLUX-family VAEs | Best: LongText 0.92–0.98, bilingual, GenEval 0.82–0.89                          | DiT Q4–Q6 3–6 GB + encoder 2–5 GB (encoder runs once, then freed or offloaded) | 4–16 steps (turbo)                                  | sd.cpp (day-0 for most)                      | **Pick from here**                      |
| Efficient small DiTs                                   | Sana 0.6B/1.6B, Sana-Sprint, PixArt-Σ, Lumina-Image 2.0, PRX, Nitro-E                        | Linear attention or deep-compression autoencoders                                                                                    | Good for their size (Sana GenEval 0.64–0.74); weak text                         | ≤ 4 GB + encoder                                                               | Sub-second on a desktop GPU                         | Mostly Python-only (PixArt in sd.cpp)        | Not shippable natively today            |
| Pixel-space and unified transformers                   | HiDream-O1-Image, Iris-3B, SenseNova U1.5, Chroma1-Radiance                                  | No VAE: the transformer predicts pixels; some share one token space for text and image                                               | HiDream-O1 is the best permissive model (GenEval 0.90, LongText 0.98)           | HiDream-O1 BF16 ~17.6 GB (no quantized build yet); Iris-3B Turbo ~6 GB         | 28–50 steps (HiDream-O1); 4 (Iris Turbo)            | sd.cpp                                       | Optional high-end tier; watch           |
| Autoregressive and unified multimodal                  | Janus-Pro, BAGEL, OmniGen2, GLM-Image, HunyuanImage 3.0, NextStep-1, Cosmos3                 | An LLM emits image tokens one at a time, often followed by a diffusion decoder                                                       | Strong only at 64–83B; small ones weak (BAGEL Elo 594; Janus-Pro 384 px output) | 17 GB to several 80 GB GPUs                                                    | Slow sequential decoding                            | Python only                                  | Not practical on 8 GB                   |

Why the single-stream, LLM-encoder design won for this use case:

- **Parameter efficiency.** Concatenating text and image tokens in one stream gets more quality per
  parameter than dual-stream MMDiT: 6–8B single-stream models (Z-Image, ERNIE) beat the 12B FLUX.1
  MMDiTs in the arena and on text benchmarks.
- **Text rendering and language.** Qwen3/Ministral-class encoders lift LongText scores from
  0.54–0.61 (T5 models) to 0.92–0.98 and handle Chinese and English prompts. That matters for
  thumbnails.
- **Manageable memory.** The encoder is often half the stack (Z-Image is 4B + 6B), but it runs once
  per prompt, so running it first and then freeing it, or keeping it in system RAM, costs little.
- **The FLUX.2 VAE is a shared latent space.** ERNIE, Ideogram 4, Fibo 2.0, MOSS, LLaDA-Image, Lens
  and FLUX.3 klein all use it. Engines that support one tend to support the next quickly.

Autoregressive models stay impractical on 8 GB: the generator is a full 7–80B LLM that keeps all
weights and a growing KV cache resident while producing hundreds of tokens in sequence, low-bit
tooling is immature (GLM-Image says so itself), and the small ones lose badly in the arena.

## 4. Models compared within each architecture

### 4.1 Single-stream DiT + LLM text encoder (main candidates)

| Model (release)                  | DiT + text encoder           | License                          | Steps                   | Fits 8 GB as (GGUF)                                       | AA Elo                 | Text rendering                                               | sd.cpp         | Role            |
| -------------------------------- | ---------------------------- | -------------------------------- | ----------------------- | --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------ | -------------- | --------------- |
| **Z-Image-Turbo** (Nov 2025)     | 6B + Qwen3-4B                | Apache-2.0, ungated              | 8                       | Q5_0 4.54 GB or Q6_K 5.26 GB + encoder Q4_K_M 2.5 GB      | 936 (925–947)          | LongText 0.92 EN / 0.93 ZH                                   | Yes (Dec 2025) | Default         |
| **ERNIE-Image-Turbo** (Apr 2026) | 8B + Ministral-3-3B          | Apache-2.0, ungated              | 8                       | Q4_K_M 5.02 GB or Q5_K_M 5.93 GB + encoder Q4_K_M 2.15 GB | 914 (904–924)          | LongText 0.966; OneIG text 0.967                             | Yes            | Text-heavy      |
| **FLUX.2 [klein] 4B** (Jan 2026) | 4B + Qwen3-4B                | Apache-2.0, ungated              | 4                       | Q8_0 4.30 GB + encoder                                    | 837                    | Readable English; weak Chinese (the 9B scores LongText 0.54) | Yes (Jan 2026) | Drafts, editing |
| Qwen-Image-2512 (Dec 2025)       | 20B MMDiT + Qwen2.5-VL-7B    | Apache-2.0                       | 50 (Lightning 4/8)      | Q4_K_M 13.2 GB — needs weight offload on 8 GB             | 903 (Aug 2025 version) | Strong (OneIG text 0.99; LongText 0.96)                      | Yes            | 16 GB+ tier     |
| MOSS-Image SFT (Oct 2026)        | 5B + Qwen3.5-9B              | Apache-2.0                       | 50, two passes per step | Q4 3.33 GB, but a 9B encoder                              | —                      | No independent data                                          | Yes            | Watch           |
| Boogu-Image 0.1 Turbo (Jun 2026) | 10B + Qwen3-VL-8B            | Apache-2.0                       | 3–4                     | 12 GB-class with offload + fp8                            | —                      | "Ultra-dense" text (vendor)                                  | Yes            | Watch           |
| Ming-Image 0.1 Design (Sep 2026) | 6B + Ling-mini-2.0 (16B MoE) | MIT (encoder license unverified) | 12                      | Validated on an 80 GB GPU                                 | 999                    | Strong; RGBA output                                          | Yes            | Too heavy       |

Excluded by license, although several fit 8 GB and top the open-weights rankings:

| Model                                 | License                                                                                                                                                    | AA Elo         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Qwen-Image-2.1 / Turbo (Sep–Oct 2026) | Qwen Research License — research or evaluation only                                                                                                        | 1042 (#1 open) |
| Fibo 2.0 (Oct 2026)                   | Bria, CC BY-NC 4.0                                                                                                                                         | 1039           |
| Ideogram 4 (Jun 2026)                 | Ideogram Non-Commercial Model Agreement                                                                                                                    | 1026           |
| FLUX.2 [dev] (Nov 2025), klein 9B     | FLUX [dev] Non-Commercial License                                                                                                                          | 1000 / 929     |
| FLUX.3 Image Klein (Oct 15 2026)      | FLUX Kommunity License: commercial outputs only under US$5M revenue; distribution only for non-commercial purposes; mandatory content filtering; revocable | not ranked     |
| Krea 2 (Jun 2026)                     | Krea 2 Community License with a revenue cap; gated                                                                                                         | —              |

### 4.2 Pixel-space and unified transformers

| Model (release)             | Size                           | License    | Steps | 8 GB fit                                       | AA Elo | Notes                                                                                               |
| --------------------------- | ------------------------------ | ---------- | ----- | ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| HiDream-O1-Image (May 2026) | 8B, no VAE or separate encoder | MIT        | 28–50 | No: BF16 only (~17.6 GB); community FP8 ~10 GB | 975    | Best permissive scores (GenEval 0.90, DPG 89.8, LongText 0.98); open Metal bug at Q8 (white images) |
| Iris-3B Turbo (Oct 2026)    | 3B + Qwen3-VL-4B               | Apache-2.0 | 4     | ~6 GB weights + encoder: tight                 | —      | GenEval 0.82, LongText-EN 0.80 (vendor); two weeks old                                              |
| SenseNova U1.5 (Aug 2026)   | 17.5B MoT                      | Apache-2.0 | 50    | No                                             | —      | Posters, infographics                                                                               |

### 4.3 MMDiT with CLIP/T5 encoders

| Model                         | Size                                   | License                                              | Steps            | 8 GB fit         | AA Elo              | Notes                                  |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------- | ---------------- | ---------------- | ------------------- | -------------------------------------- |
| FLUX.1 [schnell]              | 12B + T5-XXL + CLIP-L                  | Apache-2.0 (HF repo asks to accept terms)            | 1–4              | Q4_K_S 6.78 GB   | 740                 | Superseded by Z-Image / klein          |
| Chroma1-HD / Flash            | 8.9B + T5-XXL                          | Apache-2.0                                           | 40 (Flash fewer) | Q4_K_M 5.57 GB   | —                   | Stylized and character work; weak text |
| SD3.5 Medium / Large / Turbo  | 2.5B / 8.1B + CLIP-L, CLIP-G, T5-XXL   | Stability Community License (under US$1M revenue)    | 4–40             | Medium Q8 2.9 GB | LMArena 938 (Large) | Excluded: revenue cap                  |
| FLUX.1 [dev] / Krea / Kontext | 12B                                    | Non-commercial weights (outputs usable commercially) | 28               | Q4 ~6.4 GB       | 823–896             | Excluded                               |
| HiDream-I1                    | 17B + four encoders incl. Llama-3.1-8B | MIT + Llama 3.1 license                              | 16–50            | No               | —                   | Excluded: size                         |

### 4.4 UNet latent diffusion (SD 1.5 / SDXL lineage)

Base models and accelerators:

| Model                      | Size                 | License                 | Steps                     | File size                  | Notes                                                                                                    |
| -------------------------- | -------------------- | ----------------------- | ------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| SDXL 1.0 base              | 2.6B UNet + CLIP-L/G | CreativeML OpenRAIL++-M | 25–30                     | Q8_0 5.04 GB; FP16 6.94 GB | GenEval 0.55, DPG 74.7; runs on every runtime, including Core ML, OpenVINO, ONNX                         |
| SSD-1B / Segmind Vega      | ~1.3B / smaller      | Apache-2.0              | 25 (4 with LCM / VegaRT)  | —                          | ~50% smaller, up to 60% faster than SDXL; weaker humans and text (vendor)                                |
| SD 1.5                     | 0.9B                 | CreativeML OpenRAIL-M   | 20–30 (2–4 with LCM-LoRA) | 1.75–2.13 GB               | Dated, 512 px; the official repo is gone, community mirror `stable-diffusion-v1-5/stable-diffusion-v1-5` |
| SDXS-512                   | small                | OpenRAIL++              | 1                         | —                          | Near-real-time CPU previews; low quality                                                                 |
| SDXL-Lightning (ByteDance) | LoRA / UNet          | OpenRAIL++              | 2 / 4 / 8                 | —                          | The best permissively licensed accelerator                                                               |
| LCM-LoRA                   | LoRA                 | OpenRAIL++              | 2–8                       | —                          | Works with SD 1.5, SDXL, SSD-1B                                                                          |
| TCD                        | LoRA                 | MIT                     | 2–8                       | —                          | sd.cpp sampler support unconfirmed                                                                       |

Excluded: SD-Turbo / SDXL-Turbo (now under the Stability AI Community License: registration,
"Powered by Stability AI" display, US$1M revenue cap); DMD2 (CC BY-NC); Hyper-SD and PCM (no
license stated); SD 2.1 (removed from Hugging Face); Stable Cascade (non-commercial); Playground
v2.5 (license required above 1M monthly users); Kolors (registration for commercial use).

Fine-tunes for photorealism and characters:

| Model                      | Use                       | License                                                             | Allowed as a curated download?        |
| -------------------------- | ------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| RealVisXL V5.0             | Photoreal                 | OpenRAIL++                                                          | Yes                                   |
| DreamShaper XL v2 Turbo    | General, 6 steps at CFG 2 | OpenRAIL++                                                          | Yes                                   |
| Animagine XL 4.0           | Anime                     | OpenRAIL++-M "without any modifications or additional restrictions" | Yes                                   |
| Illustrious-XL v1.1 / v2.0 | Anime                     | SDXL license / OpenRAIL-M                                           | Yes (merges carry their own licenses) |
| Juggernaut XL up to v10    | Photoreal                 | OpenRAIL-M + "no paid API without a license"                        | Local use only                        |
| Juggernaut XI and later    | Photoreal                 | CC BY-NC-ND 4.0                                                     | No                                    |
| NoobAI-XL                  | Anime                     | FAIPL + "we prohibit any form of commercialization"                 | No                                    |
| Pony Diffusion V6 XL       | Anime                     | Modified FAIPL banning monetized inference apps                     | No                                    |
| Anima (2026)               | Anime                     | Non-commercial weights                                              | No                                    |

### 4.5 Efficient small DiTs

| Model                                | License                                                                                                      | Quality                                    | Runtimes                                          | Verdict                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------- | --------------------------------------- |
| Sana 0.6B / 1.6B, Sana-Sprint 1.6B   | HF tag Apache-2.0, yet the cards say "intended for research purposes only"; Gemma-2-2B encoder (Gemma terms) | GenEval 0.64 / 0.66; Sprint 0.74 in 1 step | diffusers, ComfyUI, SGLang; Sprint via OpenVINO   | No native path; license wording unclear |
| PixArt-Σ 0.6B                        | OpenRAIL++                                                                                                   | GenEval 0.54, DPG 80.5                     | sd.cpp, diffusers (needs the 4.7B T5-XXL encoder) | Dated                                   |
| Lumina-Image 2.0 (2.6B)              | Apache-2.0                                                                                                   | —                                          | diffusers                                         | Python only                             |
| Kandinsky 5 Image Lite (6B)          | MIT                                                                                                          | —                                          | diffusers                                         | Python only, not small                  |
| PRX 1.3B, Nitro-E 304M, Meissonic 1B | Apache-2.0 / MIT / Apache-2.0                                                                                | Thin evidence                              | diffusers or PyTorch                              | Python only                             |
| MiniT2I 258M / 912M (Jun 2026)       | Code MIT; weights license not stated                                                                         | GenEval 0.87–0.88 (authors' evaluators)    | sd.cpp (B/16), PyTorch port                       | Watch; license unclear                  |

### 4.6 Autoregressive and unified multimodal

| Model (release)             | Size                   | License                                                      | Evidence                      | Memory                   |
| --------------------------- | ---------------------- | ------------------------------------------------------------ | ----------------------------- | ------------------------ |
| Janus-Pro-7B (Jan 2025)     | 7B                     | MIT code + DeepSeek model license                            | 384×384 output; LongText 0.02 | —                        |
| BAGEL (May 2025)            | 14B MoT (7B active)    | Apache-2.0                                                   | AA Elo 594                    | —                        |
| OmniGen2 (Jun 2025)         | 3B + 4B                | Apache-2.0                                                   | AA Elo 717                    | ~17 GB                   |
| GLM-Image (Jan 2026)        | 9B AR + 7B DiT decoder | MIT                                                          | AA Elo 885                    | ~23 GB with CPU offload  |
| HunyuanImage 3.0 (Sep 2025) | 80B MoE (13B active)   | Tencent Hunyuan Community (not valid in EU, UK, South Korea) | AA Elo 932–987                | Three or more 80 GB GPUs |
| NextStep-1 (Aug 2025)       | 14B AR + flow head     | Apache-2.0                                                   | —                             | —                        |
| Cosmos3-Super (May 2026)    | 64B MoT                | OpenMDW-1.1                                                  | AA Elo 985–993                | 8× H100 recommended      |

None is practical on an 8 GB GPU.

### 4.7 License screen

- **Allowed as defaults** (permissive, no cap): Z-Image and Z-Image-Turbo; ERNIE-Image and Turbo;
  FLUX.2 klein 4B (plus base 4B and FLUX.2-small-decoder); Qwen-Image, Qwen-Image-2512,
  Qwen-Image-Edit-2511 and the Lightning distills; HiDream-O1-Image; MOSS-Image; Iris-3B; Boogu;
  LLaDA-Image; Chroma1; FLUX.1 [schnell]; SDXL and its OpenRAIL fine-tunes listed above; SSD-1B /
  Vega; SD 1.5; SDXL-Lightning; LCM-LoRA; TCD; Real-ESRGAN (BSD-3-Clause).
- **Their text encoders are permissive too:** Qwen3-4B, Qwen3-VL-4B/8B, Ministral-3-3B,
  Qwen2.5-VL-7B, Qwen3.5-9B and T5-XXL are all Apache-2.0.
- **Capped or conditional — not defaults:** SD3.5 and SD/SDXL-Turbo (under US$1M revenue);
  FLUX.3 Image Klein (under US$5M, no commercial distribution); Krea 2 (revenue cap); Playground
  v2.5 (1M monthly users); Kolors (registration); HunyuanImage (territory exclusions, 100M MAU);
  Juggernaut XL up to v10 (no paid API).
- **Non-commercial or research-only — excluded:** Qwen-Image-2.1, Ideogram 4, Fibo / Fibo 2.0, the
  FLUX.1 / FLUX.2 [dev] family including klein 9B, DMD2, Stable Cascade, Anima, Juggernaut XI+,
  NoobAI, Pony, PiD, Mage-Flow.
- **No license stated — excluded:** Hyper-SD, PCM, MiniT2I weights.

Two practical notes. OpenRAIL licenses allow commercial use and redistribution but carry use-based
restrictions that must be passed on, so the app's notices should ship each model's license text
(confirm against the primary OpenRAIL texts before release). And the obvious VAE downloads are
restricted — FLUX.1-schnell's repo is gated and sd.cpp's FLUX.2 doc links the non-commercial
FLUX.2-dev VAE — but permissive, ungated equivalents exist (Comfy-Org's `ae.safetensors` and
`black-forest-labs/FLUX.2-small-decoder`; §8).

Z-Image, FLUX.2-klein-4B, ERNIE-Image, HiDream-O1, MOSS-Image, Iris-3B, Qwen-Image(-2512), Chroma
and the `leejet/*-GGUF` repos are ungated, so no Hugging Face token is needed.

## 5. Fit by use case

| Use case               | First choice                                          | Also good                                                                                      | Evidence                                                                              |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Thumbnails with titles | Z-Image-Turbo for the art, title rendered by the host | ERNIE-Image-Turbo when text must be in the image                                               | ERNIE LongText 0.966 vs Z-Image-Turbo 0.92; host text is exact and editable           |
| Character art          | Z-Image-Turbo (realistic); Animagine XL 4.0 (anime)   | FLUX.2 klein with reference images for the same character across scenes; Chroma1-HD (stylized) | Qwen-Image and HiDream-O1 lead HPSv3 Characters but need 16 GB+                       |
| Photorealism           | Z-Image-Turbo                                         | RealVisXL V5 on low-end machines                                                               | Highest arena score of the permissive 8 GB models; vendor positioning is photorealism |
| Architecture           | Z-Image-Turbo                                         | HiDream-O1 or Qwen-Image-2512 on 16 GB+                                                        | HPSv3 Architecture: HiDream-O1 11.02, Qwen-Image 10.22, Z-Image-Turbo 9.26            |
| Abstract               | ERNIE-Image-Turbo                                     | Z-Image (base) for variety                                                                     | OneIG style 0.43 and diversity 0.24 vs Z-Image-Turbo's 0.37 and 0.14                  |

## 6. Runtimes compared

| Runtime                                 | NVIDIA                          | AMD                                       | Apple GPU  | CPU         | Install footprint                          | 2026 model coverage                                         | API for a TS CLI                         | License             | Fit                               |
| --------------------------------------- | ------------------------------- | ----------------------------------------- | ---------- | ----------- | ------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------- | ------------------- | --------------------------------- |
| **stable-diffusion.cpp**                | CUDA (Windows prebuilt), Vulkan | Vulkan and ROCm, Windows + Linux          | Metal      | Yes         | 17–35 MB per variant; Windows CUDA ~865 MB | Very broad, usually day-0                                   | `sd-server`: OpenAI + A1111 + async jobs | MIT                 | **Recommended**                   |
| diffusers (PyTorch)                     | CUDA                            | ROCm (Linux; Windows via AMD wheels, new) | MPS        | Yes         | 0.12–6 GB of wheels + Python               | Broadest                                                    | None built in                            | Apache-2.0          | Fails "native"; fastest on NVIDIA |
| mflux (MLX)                             | —                               | —                                         | Yes        | —           | Python + MLX                               | Strong 2026 set                                             | CLI / Python                             | MIT                 | Mac-only, Python                  |
| ComfyUI                                 | Yes                             | Yes                                       | Yes        | Yes         | GB-scale (Python + PyTorch)                | Broadest community support                                  | Workflow-JSON API + websocket            | GPL-3.0             | See below                         |
| OpenVINO GenAI                          | No                              | No                                        | No         | Yes (Intel) | npm addon                                  | SD to Qwen-Image 2.1, Z-Image                               | Node API                                 | Apache-2.0          | Fails the GPU matrix              |
| ONNX Runtime (onnxruntime-node)         | Linux CUDA; Windows DirectML    | Windows DirectML                          | No         | Yes         | —                                          | Do-it-yourself pipelines                                    | Do-it-yourself                           | MIT                 | Fails the GPU matrix              |
| AMD Lemonade Embeddable                 | via sd.cpp                      | via sd.cpp                                | via sd.cpp | via sd.cpp  | portable binary                            | Same as sd.cpp                                              | OpenAI-compatible                        | Apache-2.0          | Extra layer over sd.cpp           |
| LocalAI / KoboldCpp                     | via sd.cpp                      | via sd.cpp                                | via sd.cpp | via sd.cpp  | heavy                                      | Same as sd.cpp                                              | OpenAI / A1111-like                      | MIT / AGPL-3.0      | Extra layer                       |
| Ollama                                  | —                               | —                                         | —          | —           | —                                          | Image generation added Jan 2026, removed Aug 2026 (v0.32.6) | —                                        | MIT                 | Not available                     |
| Core ML SD / DiffusionKit / Draw Things | —                               | —                                         | Apple only | —           | —                                          | SD/SDXL only / archived / GPL gRPC server                   | —                                        | MIT / MIT / GPL-3.0 | No                                |
| llama.cpp                               | —                               | —                                         | —          | —           | —                                          | No image generation; maintainers point to sd.cpp            | —                                        | MIT                 | No                                |

### stable-diffusion.cpp in detail

**Releases.** Tags look like `master-<build>-<hash>` (latest `master-987-a77d362`, 2026-10-21),
about one per merged commit (28–68 a month); the README warns that options change often. Pin a
tested tag, as obrew pins `llamacpp_tag`. Every zip ships both `sd-cli` and `sd-server`.

| Target         | Asset (`master-987-a77d362`)                                                                  | Zip size        |
| -------------- | --------------------------------------------------------------------------------------------- | --------------- |
| Windows CUDA   | `sd-master-a77d362-bin-win-cuda12-x64.zip` + `cudart-sd-bin-win-cu12-x64.zip`                 | 328 MB + 537 MB |
| Windows Vulkan | `sd-master-a77d362-bin-win-vulkan-x64.zip`                                                    | 28 MB           |
| Windows ROCm   | `sd-master-a77d362-bin-win-rocm-10.1.0-x64.zip`                                               | 252 MB          |
| Windows CPU    | `sd-master-a77d362-bin-win-cpu-x64.zip`                                                       | 17 MB           |
| Linux Vulkan   | `sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`                                  | 35 MB           |
| Linux ROCm     | `sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-rocm-10.1.0.zip` (files under `build/bin/`)  | 282 MB          |
| Linux CPU      | `sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64.zip`                                         | 25 MB           |
| macOS          | `sd-master-a77d362-bin-Darwin-macOS-26.6.2-arm64.zip` (universal binaries, Metal compiled in) | 35 MB           |
| Not published  | Linux CUDA, Linux arm64                                                                       | —               |

Windows CUDA builds use CUDA 12.8 and support Pascal through Blackwell; ROCm builds target RDNA1–4
on Windows and add CDNA on Linux. Older reports that "the precompiled macOS build has no Metal"
(December 2025) are superseded: current macOS zips contain Metal code.

**Server.** `sd-server` (default `127.0.0.1:1234`; `--listen-ip` / `--listen-port`) keeps one model
loaded and exposes:

- OpenAI: `POST /v1/images/generations` (`data[].b64_json`, png/jpeg/webp), `/v1/images/edits`,
  `GET /v1/models`.
- A1111: `/sdapi/v1/txt2img`, `/sdapi/v1/progress` (with a latent preview).
- Native async jobs: `POST /sdcpp/v1/img_gen`; `GET /sdcpp/v1/jobs/{id}` (status, queue position,
  step / total_steps, preview PNG); `POST /sdcpp/v1/jobs/{id}/cancel`; `POST /sdcpp/v1/upscale`;
  `GET /sdcpp/v1/capabilities`; a full queue answers 429.
- Model management: `/sdcpp/v1/models/load|unload|status|refresh`, `/sdcpp/v1/recipes`. Loading is
  refused while jobs are pending; hardware and memory options are startup flags.

**Low-VRAM controls.** `--offload-to-cpu` with `--max-vram <GiB>` (segmented execution with
prefetch; the maintainers say it costs little speed — unverified), `--params-backend cpu|disk`,
per-module placement (`--backend te=cpu,vae=…,diffusion=…`), `--vae-tiling` (with automatic retry
on out-of-memory), `--flash-attn auto`, and load-time quantization (`--type q8_0|q4_K|…`). The CLI's
progress bar is not machine-readable; the server's job API is.

**Known issues (October 2026).**

- Metal: blank white images on M5 with the Metal tensor API (`GGML_METAL_TENSOR_DISABLE=1` works
  around it, [#1990](https://github.com/leejet/stable-diffusion.cpp/issues/1990)); white images with
  batched CFG ([#2149](https://github.com/leejet/stable-diffusion.cpp/issues/2149)); HiDream-O1 Q8
  white images ([#1847](https://github.com/leejet/stable-diffusion.cpp/issues/1847)); the build doc
  still calls Metal "highly inefficient" for very large matrix operations.
- Vulkan: crashes on very large dispatches (several LoRAs above ~0.8 MP); Mesa RADV caps single
  allocations at 4 GiB, so large VAE decodes need tiling; an SDXL slowdown on RDNA2 in master-964
  was fixed in master-968.
- ROCm: some model-specific regressions (Qwen-Image on gfx1100), and trouble when an iGPU and a
  dGPU are both visible.

**Speed versus PyTorch.** In January 2026 community tests sd.cpp was 1.6–3.7× slower than warm
ComfyUI on an RX 7800 XT, and FLUX.2 klein ran at 6.7 vs 10.5 it/s on an RTX 4090. A later change
(PR #1228) made it 29–58% faster; no newer head-to-head exists.

### ComfyUI: why it isn't the built-in engine, and how it could join later

ComfyUI (GPL-3.0, v0.42.1 on 2026-10-19) is the most capable local image stack: the broadest day-0
model support, mature low-VRAM memory management, a huge node ecosystem (ControlNet, IP-Adapter,
inpainting, video), a desktop app for NVIDIA, AMD, Intel and Apple Silicon, and — in January 2026
tests — 1.6–3.7× the speed of sd.cpp on the same GPU. It also fits 8 GB at runtime. It moves
weights to system RAM automatically, runs fp8 weights natively, and runs GGUF files through a
community custom node. As obrew's built-in engine it loses on:

- **Packaging.** It needs Python and PyTorch. Download size isn't the problem; the build matrix
  is. Each OS _and_ each GPU flavor needs its own build, because CUDA, ROCm, MPS and CPU use
  different PyTorch builds.
  - It can be frozen into an executable with PyInstaller or Nuitka in one-folder mode. One-file
    mode re-extracts gigabytes on every launch.
  - Neither freezer cross-compiles, and ComfyUI's dynamic imports need freezer hooks.
  - A standalone Python installed on first run (python-build-standalone via uv, or ComfyUI's own
    portable build) gets the same result with less fragility.
- **License bookkeeping.** GPL-3.0 (see below): manageable, but real work for every copy that
  is shipped.
- **Integration surface.** Its API runs node-graph "workflows" (JSON graphs, websocket progress),
  so obrew would maintain a workflow per model and track node changes; GGUF models need a community
  custom node.
- **Custom-node risk.** Custom nodes are arbitrary Python running with the user's permissions, and
  the ecosystem has had malicious nodes; a locked-down install is real work.
- **Weight and churn.** Slower cold starts, an extra 1–2 GB of RAM for the Python process, and
  frequent releases to re-pin and re-test.
- **AMD on Windows.** Works through ROCm 7.x on recent GPUs; older Radeons are spotty, while sd.cpp's
  28 MB Vulkan build covers them.

**GPL, in practice** (not legal advice). Talking to ComfyUI over its HTTP API as a separate
program is "mere aggregation" in the FSF's terms, so obrew and MotionBuff stay MIT. Obligations
attach only to ComfyUI copies that we distribute:

- **User-installed ComfyUI that obrew connects to:** no obligations for us.
- **ComfyUI that obrew or MotionBuff downloads or bundles:** we must
  - ship it as its own, unmodified program;
  - include the GPL-3.0 text;
  - offer the exact corresponding source, including the build scripts if it is frozen into an
    executable;
  - add no terms that restrict users' rights to that component.
- **Code that runs inside ComfyUI** (a custom node or a patch) is a derivative work and must be
  GPL when distributed. Keeping obrew's side to the public HTTP and workflow API avoids this.

**Where it fits:** a second backend behind the same image interface as sd.cpp. Start with
bring-your-own: we distribute nothing, so there are no obligations. Bundle it later if its speed
on NVIDIA is worth the extra build matrix.

### Why not the others

diffusers is the fastest and broadest on NVIDIA, but it means shipping Python plus 0.12–6 GB of
PyTorch wheels per platform and writing a server. mflux is the best Mac engine but Python and
Mac-only. OpenVINO and ONNX Runtime cannot cover AMD and Apple GPUs. Ollama removed image
generation in August 2026. Wrappers (Lemonade, LocalAI, KoboldCpp) embed sd.cpp themselves, so they
add a layer without adding a backend.

## 7. What to expect on target hardware

Direct measurements on obrew's exact targets are scarce. The table separates evidence from
estimates; the benchmark in §10 replaces the estimates.

| Hardware                         | Evidence (runtime, source)                                                                                                                                                                                                                                                                                                         | Expectation (estimate)                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| NVIDIA 8 GB (RTX 3060 Ti / 4060) | No sd.cpp data at 8 GB. RTX 1000 Ada 6 GB: Z-Image Q3 ≈ 2 s/step (sd.cpp CUDA, community, [#1145](https://github.com/leejet/stable-diffusion.cpp/issues/1145)). SDXL 1024 px / 30 steps ≈ 14–15 s on an RTX 4060 (ComfyUI, community, inconsistent)                                                                                | Z-Image-Turbo at ~1 MP ≈ 15–30 s warm; FLUX.2 klein 4B ≈ 10–15 s; first run adds the model load                                           |
| AMD (Vulkan / ROCm)              | RX 7600 XT, Jan 2026: Z-Image-Turbo 8.1 s/step and klein 4B 7.3 s/step on Vulkan (before PR #1228). RX 7800 XT after #1228: klein 4B 15.9 s (Vulkan) / 10.3 s (ROCm) per image ([#1215](https://github.com/leejet/stable-diffusion.cpp/issues/1215))                                                                               | ROCm beats Vulkan for DiTs on RDNA3; Vulkan is far smaller to ship                                                                        |
| Apple Silicon                    | sd.cpp Metal: M5 Max, Z-Image-Turbo 864×480 / 8 steps ≈ 28 s ([#1990](https://github.com/leejet/stable-diffusion.cpp/issues/1990)). mflux, M1 Max, 1024 px: klein 4B q4 24–31 s; Z-Image-Turbo q4 65–90 s ([mflux #817](https://github.com/mflux-community/mflux/issues/817)). Core ML SDXL 1024 px / 20 steps: M1 Max 46 s (2023) | 30 s to 3 min per image depending on the chip. Treat 16 GB unified memory as the floor for modern models                                  |
| CPU only                         | FastSD CPU (OpenVINO, i7-12700): SD-Turbo 512 px / 1 step ≈ 5 s; SDXL-Lightning 768 px / 2 steps ≈ 12 s; Iris-3B Turbo int8 1024 px / 4 steps ≈ 90 s; FLUX.1 schnell int4 512 px / 3 steps ≈ 4.5 min. sd.cpp FLUX.1 schnell q8 on a Ryzen 3900X: 75 s/step                                                                         | Modern 4–8B models take several minutes per image; CPU-only users are better served by the SDXL-Lightning / SD 1.5 LCM tier at 512–768 px |

System RAM matters too: with the text encoder or weights offloaded, plan on at least 16 GB of RAM
alongside an 8 GB GPU (an estimate; no source documents it).

### Measured with this implementation: Apple M4

A base M4 (10-core GPU, 32 GB), stable-diffusion.cpp `master-987` on Metal, through `obrew image`
(times include obrew's own overhead; "cold" includes starting the engine and loading the model):

| Job                                                                         | Model                  | Time                                   |
| --------------------------------------------------------------------------- | ---------------------- | -------------------------------------- |
| `image setup`: engine install and self-test, ~12 GB of model files verified | —                      | 12 s                                   |
| 1280×720, 4 steps, cold                                                     | FLUX.2 klein 4B (Q8_0) | 73 s                                   |
| 1280×720, 8 steps                                                           | Z-Image-Turbo (Q5_0)   | 214 s (~23 s per step)                 |
| 1920×1080: generated at 1920×1088 and cropped, warm                         | FLUX.2 klein 4B        | 174 s                                  |
| Reference edit, 1360×768                                                    | FLUX.2 klein 4B        | 150–174 s                              |
| Image to image, strength 0.55, 1360×768                                     | FLUX.2 klein 4B        | 70 s                                   |
| 512×512 through `obrew serve`, cold / warm                                  | FLUX.2 klein 4B        | 35 s / 23 s                            |
| Upscale ×4, 1280×720 → 5120×2880                                            | Real-ESRGAN x4plus     | ~230 s (tile size makes no difference) |
| A text turn while the image engine is warm (both fit)                       | Gemma 4 E2B            | 19 s                                   |

Two decisions came from these numbers. On a base Apple chip FLUX.2 klein is 2.6× faster than
Z-Image-Turbo for a similar image, so `setup` makes it the default generator there (Z-Image stays
installed, one `--model` away). And ESRGAN's convolutions are slow on Metal, so exact sizes up to
~2 MP — 1920×1080 included — are generated at the size and cropped rather than upscaled, which
halved the time for a 1080p image. Pro/Max chips and NVIDIA cards should be several times faster;
those numbers are still to be measured (§10).

## 8. Curated presets

Installed by `obrew image setup` (pinned by repository, commit, path and SHA-256; all ungated):

| Preset              | Diffusion model                                                                              | Text encoder                                    | VAE / weights                                                                                                    | Steps / CFG | For                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `z-image-turbo`     | `leejet/Z-Image-Turbo-GGUF` Q5_0 (4.54 GB); Q4_K (3.86 GB) below a 7.5 GiB memory budget     | `unsloth/Qwen3-4B-GGUF` Q4_K_M (2.5 GB), shared | `Comfy-Org/z_image_turbo` → `split_files/vae/ae.safetensors` (Apache-2.0; byte-identical to FLUX.1's gated `ae`) | 8 / 1.0     | Default generator on GPUs: photoreal, architecture, characters                        |
| `flux2-klein-4b`    | `leejet/FLUX.2-klein-4B-GGUF` Q8_0 (4.30 GB); Q4_0 (2.46 GB) below 7.5 GiB                   | the same Qwen3-4B file                          | `black-forest-labs/FLUX.2-small-decoder` → `full_encoder_small_decoder.safetensors` (Apache-2.0)                 | 4 / 1.0     | Default editor (`--ref`); default generator on CPU-only machines and base Apple chips |
| `realesrgan-x4plus` | `Comfy-Org/Real-ESRGAN_repackaged` → `RealESRGAN_x4plus.safetensors` (66.9 MB, BSD-3-Clause) | —                                               | —                                                                                                                | ×4          | Upscaling                                                                             |

One text-encoder file serves both generators, and it is the ORIGINAL Qwen3-4B: Z-Image-Turbo's
own text-encoder shards are byte-identical to `Qwen/Qwen3-4B`, and Comfy-Org ships the same
`qwen_3_4b.safetensors` for Z-Image and for FLUX.2 klein. (stable-diffusion.cpp's Z-Image page
suggests `Qwen3-4B-Instruct-2507`, a different checkpoint from the one the model was trained with.)
Sharing it saves 2.5 GB.

Later presets: `ernie-image-turbo` (text inside images), an SDXL-class low-end / CPU tier
(DreamShaper XL v2 Turbo, or RealVisXL + SDXL-Lightning), `animagine-xl-4` (anime) and `sd15-lcm`
(very weak CPUs).

Exact sizes: 1920×1080 is generated at 1920×1088 (sizes are multiples of 16) and cropped by four
rows top and bottom — real detail, no upscaler. Only sizes beyond the model's ~2.2 MP limit (4K)
go through ESRGAN ×4 and a resample, because on Apple Silicon ESRGAN x4plus is slow (§7).

## 9. How it plugs into obrew-cli

- **Its own module and state.** `src/image/`, with its own `<data>/image/` directory (engines,
  models, upscalers, process records, logs, config, registry). It is kept apart from the text
  engine's files because their schemas drop unknown keys when re-saved.
- **Engine.** stable-diffusion.cpp pinned in package.json (`sdcpp_tag`), with variants cpu, cuda,
  vulkan, rocm and metal. Defaults: CUDA for Windows NVIDIA whose driver supports CUDA 12.8;
  Vulkan for AMD, Intel and Linux NVIDIA (ROCm opt-in); Metal on macOS; CPU otherwise. Install
  runs the build (`--help`, `--list-devices`) and records its flags, so a renamed flag is dropped
  rather than fatal. One warm, detached `sd-server` with an idle timeout (`--engine ephemeral`
  runs it as an attached child instead), driven through the job API: progress, previews, per-job
  cancel, and jobs left behind by a hard-killed host are cancelled by the next run. Switching
  models restarts it; the upscaler loads alongside. Memory flags (`--offload-to-cpu`,
  `--max-vram`, `--vae-tiling`, Metal's `--batched-cfg off`) are chosen from the detected memory.
- **Models.** Curated presets pinned by commit and SHA-256; files are shared across bundles by
  hash, adopted if already on disk, and resumed on interrupted downloads; a download plan is
  announced first. Custom bundles can name any Hugging Face components.
- **CLI.** `obrew image "<prompt>"` with `--aspect`/`--size`, `--seed`, `--count`, `--image` +
  `--strength` (img2img), `--ref` (reference edits), `--upscale`; plus `obrew image upscale`,
  `image setup`, `image models …` and `image engine …`. Output is one JSON event per line under
  `--json` (`image.started`, `image.progress`, `image.preview`, `image.saved`, `image.completed`,
  `image.failed`, with a new `out_of_memory` code).
- **Hosts.** `obrew auth status --json` gains an `image` block (`ready`, `edit`, `upscale`) without
  changing the text `ready`; `obrew login --image` also sets images up; `obrew engine stop` stops
  both engines; `obrew serve` answers `POST /v1/images/generations` (optionally streamed). When
  the text and image engines do not both fit in GPU memory, the idle one is stopped — never a
  busy one.
- **Demo.** `examples/image-demo/` is a small Bun web page that drives the CLI exactly as
  MotionBuff would: setup with progress, generation by use case, live previews, edit / vary /
  upscale, and thumbnail titles drawn by the page over the generated art.

## 10. Risks, open questions and the benchmark

| Risk                                                 | Impact                                              | Mitigation                                                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| sd.cpp churn (a release per commit; renamed flags)   | Breakage on every bump                              | Pin a tag; match assets by pattern; probe flags at install; smoke-test each backend before a bump                                            |
| Metal correctness (blank images on M5; batched CFG)  | Mac users get blank images                          | `GGML_METAL_TENSOR_DISABLE=1` on M5; presets use CFG 1; detect blank output and report it                                                    |
| Apple speed                                          | 1–3.5 minutes per image on a base M4 (measured, §7) | 16 GB unified memory floor; klein is the default generator on base Apple chips; exact sizes up to ~2 MP are generated natively, not upscaled |
| Windows CUDA download (~865 MB)                      | Slow first setup                                    | One-time and cached; Vulkan (28 MB) as the light alternative                                                                                 |
| No Linux CUDA prebuilt                               | Linux NVIDIA runs on Vulkan                         | Accept, or build CUDA in obrew's CI later                                                                                                    |
| Text and image engines sharing one GPU               | Out-of-memory                                       | Evict the idle engine when both don't fit; hosts batch image work                                                                            |
| CPU speed                                            | Minutes per image                                   | klein on CPU first; the SDXL-class tier if it proves too slow                                                                                |
| License obligations (OpenRAIL restrictions, notices) | Compliance                                          | Ship each preset's license with the app's notices; show the license per preset                                                               |
| Fast-moving model landscape                          | Catalog dated within months                         | Presets are data; re-review quarterly; watch Qwen-Image-2.1 relicensing, FLUX.3 Klein terms, quantized HiDream-O1                            |

**Benchmark.** Run the presets at 1280×720 and 1024×1024 on: Windows with an 8 GB RTX (CUDA vs
Vulkan); an 8 GB AMD RDNA2/3 card (Vulkan vs ROCm, Windows and Linux); an Apple Silicon Mac
(Metal); and an x86 CPU-only machine. Record cold and warm seconds per image, peak VRAM and RAM,
blank-image failures, and a side-by-side review of five prompts per use case. The results set the
Mac default (Z-Image vs klein), the NVIDIA and AMD default variants, and the quantization per
memory tier.

## 11. Sources

Engines and runtimes:
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (README, `docs/`,
[server API](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md),
[releases](https://github.com/leejet/stable-diffusion.cpp/releases),
[build doc](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/build.md),
[performance doc](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/performance.md));
[diffusers](https://github.com/huggingface/diffusers) and its
[memory guide](https://huggingface.co/docs/diffusers/main/en/optimization/memory);
[mflux](https://github.com/mflux-community/mflux);
[Ollama v0.32.6](https://github.com/ollama/ollama/releases/tag/v0.32.6);
[Lemonade](https://github.com/lemonade-sdk/lemonade);
[LocalAI image docs](https://github.com/mudler/LocalAI/blob/master/docs/content/features/image-generation.md);
[KoboldCpp](https://github.com/LostRuins/koboldcpp); [ComfyUI](https://github.com/Comfy-Org/ComfyUI);
[OpenVINO GenAI models](https://openvinotoolkit.github.io/openvino.genai/docs/supported-models/);
[ONNX Runtime for Node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html);
[llama.cpp RFC #28541](https://github.com/ggml-org/llama.cpp/issues/28541);
[GPL FAQ on aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation).

Rankings: [Artificial Analysis text-to-image arena](https://artificialanalysis.ai/text-to-image/arena/leaderboard-text);
[LMArena text-to-image](https://arena.ai/leaderboard/text-to-image).

Model cards and licenses:
[Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo),
[ERNIE-Image](https://huggingface.co/baidu/ERNIE-Image) /
[Turbo](https://huggingface.co/baidu/ERNIE-Image-Turbo),
[FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B),
[FLUX.2-small-decoder](https://huggingface.co/black-forest-labs/FLUX.2-small-decoder),
[HiDream-O1-Image](https://huggingface.co/HiDream-ai/HiDream-O1-Image),
[Qwen-Image-2512](https://huggingface.co/Qwen/Qwen-Image-2512),
[Qwen-Image-2.1 license](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE),
[Ideogram 4 license](https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md),
[FLUX.3 Image Klein license](https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md),
[Fibo 2.0](https://huggingface.co/briaai/Fibo-2.0-dev),
[Iris-3B](https://huggingface.co/speridlabs/iris-3b),
[MOSS-Image](https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT),
[Boogu-Image](https://huggingface.co/Boogu/Boogu-Image-0.1-Turbo),
[Ming-Image](https://huggingface.co/inclusionAI/Ming-Image-0.1-Design),
[Chroma1-HD](https://huggingface.co/lodestones/Chroma1-HD),
[FLUX.1 schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell),
[SD3.5 Large Turbo](https://huggingface.co/stabilityai/stable-diffusion-3.5-large-turbo),
[Stability Community License](https://stability.ai/community-license-agreement),
[SDXL base](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0),
[SDXL-Lightning](https://huggingface.co/ByteDance/SDXL-Lightning),
[RealVisXL V5.0](https://huggingface.co/SG161222/RealVisXL_V5.0),
[DreamShaper XL v2 Turbo](https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo),
[Animagine XL 4.0](https://huggingface.co/cagliostrolab/animagine-xl-4.0),
[SSD-1B](https://huggingface.co/segmind/SSD-1B),
[SD 1.5 mirror](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5),
[Sana 1.6B](https://huggingface.co/Efficient-Large-Model/Sana_1600M_1024px),
[Tencent Hunyuan license](https://github.com/Tencent-Hunyuan/HunyuanImage-2.1/blob/master/LICENSE),
[GLM-Image](https://huggingface.co/zai-org/GLM-Image),
[Sana paper (benchmark table)](https://arxiv.org/html/2410.10629).

Quantized and component files:
[leejet/Z-Image-Turbo-GGUF](https://huggingface.co/leejet/Z-Image-Turbo-GGUF),
[unsloth/ERNIE-Image-Turbo-GGUF](https://huggingface.co/unsloth/ERNIE-Image-Turbo-GGUF),
[leejet/FLUX.2-klein-4B-GGUF](https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF),
[unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF),
[unsloth/Ministral-3-3B-Instruct-2512-GGUF](https://huggingface.co/unsloth/Ministral-3-3B-Instruct-2512-GGUF),
[Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo),
[Comfy-Org/Real-ESRGAN_repackaged](https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged),
[gpustack/stable-diffusion-xl-base-1.0-GGUF](https://huggingface.co/gpustack/stable-diffusion-xl-base-1.0-GGUF).

Hardware data: sd.cpp issues [#1215](https://github.com/leejet/stable-diffusion.cpp/issues/1215),
[#1145](https://github.com/leejet/stable-diffusion.cpp/issues/1145),
[#1990](https://github.com/leejet/stable-diffusion.cpp/issues/1990),
[#2137](https://github.com/leejet/stable-diffusion.cpp/issues/2137);
[mflux #817](https://github.com/mflux-community/mflux/issues/817);
[FastSD CPU](https://github.com/rupeshs/fastsdcpu);
[apple/ml-stable-diffusion](https://github.com/apple-aiml-research/ml-stable-diffusion).
