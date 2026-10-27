# Image generation — handoff

Status as of 2026-10-22, branch `feature/image-gen`. The work is committed (`c8285f7` and the
follow-ups after it); this file is untracked: it is a working note, so leave it out of the PR or
delete it once the work is picked up.

**Where it stands:**

- The research report is done.
- The CLI module and the demo app are working.
- 465 tests pass; one Linux-only test was skipped on macOS.
- Verified on real hardware on an Apple M4 only. Windows and Linux GPU paths are untested.

## Start here (new session)

1. Read this file.
2. Read [image-generation.md](image-generation.md), the research report and the reason for every choice.
3. Optionally read the approved plan: `~/.claude/plans/feature-add-image-generation-dazzling-locket.md`. It has the full design: file list, event contract, errors, phases.
4. The README has an **Images** section with the user-facing summary.
5. Sanity check:

   ```bash
   bun run typecheck && bun run lint && bun test ./src ./test ./examples   # 465 pass, 1 skip
   bun run src/main.ts auth status            # "images: ready (...)" on the machine it was built on
   bun run src/main.ts image models list
   ```

## What was asked, and the decisions taken

The feature: local image generation in obrew-cli for host apps, starting with MotionBuff. Use cases are thumbnails, character art, photorealism, architecture and abstract.

Constraints:

- 8 GB VRAM minimum;
- NVIDIA, AMD and Apple Silicon;
- CPU fallback preferred;
- Hugging Face downloads;
- free to bundle.

Decisions taken during planning (user's choices):

| Topic           | Decision                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| Licenses        | Permissive only for defaults: Apache-2.0, MIT, OpenRAIL-style, BSD                                            |
| Engine          | A native binary, no Python: stable-diffusion.cpp `sd-server`. ComfyUI is a possible later backend (report §6) |
| Module          | Its own module, separate from text inference                                                                  |
| MVP scope       | Text-to-image, image editing (img2img plus reference images) and upscaling                                    |
| Demo            | A local web app in `examples/image-demo/` that drives the CLI the way MotionBuff would                        |
| Report location | `docs/image-generation.md`                                                                                    |

## What exists now

| Area              | Where                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Research report   | `docs/image-generation.md`, including measured M4 timings in §7                                                                                                                                                                |
| Image module      | `src/image/`: `presets.ts`, `registry.ts`, `pull.ts`, `generate.ts`, `size.ts`, `png.ts`, `status.ts`, `config.ts`, `paths.ts`                                                                                                 |
| Engine            | `src/image/engine/`: `install.ts`, `variant.ts`, `hardware.ts`, `flags.ts`, `client.ts`, `shared.ts` (warm engine + GPU peers), `jobs.ts` (orphan-job reaper), `version.ts`                                                    |
| CLI               | `src/cli/commands/image.ts`: `obrew image`, `upscale`, `setup`, `models`, `engine`                                                                                                                                             |
| Host integration  | `auth status` `image` block, `login --image`, `engine stop` stops both engines, `exec` makes room on the GPU (`src/shared/gpu.ts`), `serve` adds `POST /v1/images/generations`                                                 |
| Shared groundwork | `src/shared/release.ts` (GitHub release lookup), `src/shared/unzip.ts` (Linux zips), `src/engine/command.ts`, `detach.ts` `stdioLog`, `running.ts` `dir`, `hf.ts` `revision`                                                   |
| Wire contract     | `src/shared/events.ts`: `image.started`, `.progress`, `.preview`, `.saved`, `.completed`, `.failed`, `download.plan`, `ImageInputSchema`; `errors.ts`: `out_of_memory`                                                         |
| Demo              | `examples/image-demo/`: `server.ts`, `cli.ts`, `presets.ts`, `public/index.html`, `public/app.js`, `README.md`, tests                                                                                                          |
| Tests             | Fakes: `test/fixtures/fake-sd-server.ts`, `image-home.ts`, `image.ts`, `zip.ts`. Contract test: `test/image-contract.test.ts`. Plus unit tests next to each module                                                             |
| Scripts           | `scripts/smoke-image.ts`, run as `bun run smoke:image [--bench]`, for real hardware                                                                                                                                            |
| Wiring            | `package.json` (`sdcpp_tag: master-994-e779d4f`; scripts `demo:image` and `smoke:image`; `test` includes `./examples`), `tsconfig.json` and CI workflows include `examples`, `.gitignore` excludes `examples/image-demo/.out/` |

The new code is about 10k lines (TypeScript, JavaScript and HTML), including tests.

## How to run it

```bash
bun run src/main.ts image setup                      # engine + models (≈12 GB the first time)
bun run src/main.ts image "a lighthouse at dusk" --aspect 16:9
bun run src/main.ts image "same lighthouse in winter" --ref <png>      # reference edit
bun run src/main.ts image "watercolor" --image <png> --strength 0.5    # img2img
bun run src/main.ts image "a lighthouse" --size 1920x1080              # exact size
bun run src/main.ts image upscale <png> --scale 2
bun run demo:image                                    # open the printed URL (default :8790)
bun run smoke:image --bench                           # real-hardware check + timings
```

`OBREW_BIN=./obrew` makes the demo and the smoke script use the compiled binary (`bun run build`).

## Verified results

**Automated:**

- 465 tests pass across 40 files; 1 is skipped on macOS because it is Linux-only. Re-run when this file was written.
- Typecheck and lint are clean.

**Real hardware: Apple M4 (10-core GPU, 32 GB), Metal, sd.cpp master-987.** "Warm" means the engine was already running.

| Check                                                              | Result                                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `image setup` (engine 35 MB, ~12 GB of models verified or adopted) | 12 s; re-runs download nothing                                                                                                                |
| FLUX.2 klein 4B, 1280×720, 4 steps, cold                           | 73 s                                                                                                                                          |
| Z-Image-Turbo, 1280×720, 8 steps                                   | 214 s (~23 s per step); 222 s including a model switch                                                                                        |
| klein, exact 1920×1080 (generated at 1920×1088, cropped), warm     | 174 s; the old ESRGAN route took 348 s                                                                                                        |
| Reference edit (klein, 1360×768)                                   | 150–174 s; it keeps the scene and character                                                                                                   |
| img2img, strength 0.55 (klein, 1360×768)                           | 70 s                                                                                                                                          |
| ESRGAN ×4, 1280×720 → 5120×2880                                    | ~230 s; tile size 256 or 512 makes no difference                                                                                              |
| `serve` `/v1/images/generations`, 512², cold / warm-streamed       | 35 s / 23 s; SSE events correct                                                                                                               |
| Demo app with the compiled binary                                  | Page, status, models, generate with SSE previews, `/files` all work; layout and thumbnail-title overlay checked by headless-Chrome screenshot |
| `smoke:image` with the compiled binary                             | All steps pass: text-to-image 512² 29 s, img2img 21 s, edit 43 s, upscale ×2 60 s                                                             |
| Interrupted real HF download (250 MB VAE)                          | Killed at 82 MB; the second run resumed (Range) and the SHA-256 matched                                                                       |
| Text and image engines together (32 GB)                            | Coexist                                                                                                                                       |
| Same, under `OBREW_GPU_BUDGET_GIB=8`                               | Each idle engine evicted the other, both directions                                                                                           |
| `engine stop`                                                      | Stops both engines                                                                                                                            |

## Decisions made while building (departures from the plan)

- **Shared text encoder: the original Qwen3-4B** (`unsloth/Qwen3-4B-GGUF`), shared by Z-Image and klein.
  - Z-Image's own encoder shards are byte-identical to `Qwen/Qwen3-4B`.
  - sd.cpp's docs suggest Instruct-2507, which is a different checkpoint.
  - Sharing saves 2.5 GB.
- **Default generator by hardware:**
  - `setup` makes **klein** the default on base Apple chips and CPU-only machines; it is 2.6× faster than Z-Image on the M4.
  - Z-Image stays installed and is the default on GPUs.
- **Exact sizes:**
  - Up to about 2.2 MP: generated at the 16-aligned size and cropped, with no upscaler.
  - Above that: ESRGAN ×4, then resample.
  - Why: ESRGAN is very slow on Metal.
- **Edits keep the input's size** when the model can generate it natively.
- **`login --image`** runs the normal login, then image setup. The plan said "alias of image setup".
- **`--engine ephemeral`** runs sd-server as an attached child. Shared mode stays detached.
  - An attached child inherits the environment on every platform.
  - Processes created through WMI on Windows don't, which is why the scripted fakes in tests use ephemeral.
- **Format rule:** a resampled or cropped output can only be PNG (obrew's encoder). JPEG or WebP is accepted only for a native size or `--upscale 4`; any other combination is `bad_request`.
- **Formatting:** `.prettierrc` sets `printWidth: 100`, but much of the existing code uses longer lines, and the new code follows it. 28 of the new files are not prettier-formatted, and neither are several existing ones at `HEAD`: `src/engine/install.ts`, `src/cli/commands/exec.ts` and `src/serve/server.ts`. As a result, `bunx prettier --check .` fails. Only the two docs and the README were formatted. Lint and typecheck do not enforce prettier.

## Bugs found by the test pass and fixed (for the record)

1. The registry kept a stale path when a shared file was re-downloaded elsewhere. It now always records where the bytes are, and their size.
2. A custom component with no size in the Hub listing never resolved. Sizes now come from disk.
3. Two revisions of one path, or two upscalers with the same name, could overwrite each other. A clash now gets a distinct name (`name@<sha12>.ext`) and never touches another bundle's file.
4. GPU leases were one per process, so a concurrent `serve` request could release the other's lease. Leases are now one file per lease and own-process leases count, so requests wait for each other.
5. `-c offload / max_vram / vae_tiling` were ignored on Metal and CPU. They now apply on every variant.
6. `makeDefault` skipped slot capability checks. `assertSlot` now runs before any download.

Also fixed:

- The repair hint shown for a custom bundle.
- `nativeFor` now keeps the aspect ratio when it rounds down.
- Windows `reg query` output is kept even when the command exits 1. Not verified on Windows.

## Known gaps and risks

- **Not tested on Windows or Linux GPUs:**
  - CUDA build plus the cudart download and cache;
  - AMD detection through the registry (`reg query`), and Vulkan;
  - the `cmd /d /s /c … >> log` log capture and child-pid lookup in `src/engine/detach.ts`;
  - glibc and `$ORIGIN` behaviour of the Linux zips.
- **Apple speed:** a base M4 takes 1–3.5 minutes per image. Pro, Max and NVIDIA should be much faster, but haven't been measured.
- **ESRGAN on Metal:** about 4 minutes for a 720p×4. A lighter upscaler would help (see To do).
- **sd.cpp churn:** stable-diffusion.cpp publishes a release for every merged commit and renames flags. It is pinned to `master-994-e779d4f`, and install probes the flags. Run `smoke:image` before bumping `sdcpp_tag`.
- **Metal bugs upstream:**
  - M5 with the tensor API: obrew sets `GGML_METAL_TENSOR_DISABLE=1`.
  - Batched CFG: obrew passes `--batched-cfg off`.
  - A blank-image check warns if it happens anyway.
- **Coexistence on 8 GB:** non-streamed `serve` requests rely on `server.timeout(req, 0)`. Hosts should batch image work, because each text↔image swap reloads a model (10–30 s).

## To do (suggested order)

1. **Review and open a PR** to `master`.
2. **Run `bun run smoke:image --bench` on:**
   - Windows + NVIDIA 8 GB (CUDA, and `--variant vulkan` to compare);
   - Windows + AMD (Vulkan, and `--variant rocm`);
   - Linux (Vulkan / ROCm; also check glibc on Ubuntu 22.04);
   - an Apple Pro/Max chip.

   Fill in the report's §7 and §10, and decide the defaults: CUDA vs Vulkan on NVIDIA, Vulkan vs ROCm on AMD, and whether klein should be the Mac default on all chips.

3. **CI.** Run the manual CI workflow on all three OSes. The image tests use fakes. Windows CI exercises the detached spawn with the `cmd` wrapper; the scripted fakes use ephemeral engines because of WMI environment inheritance.
4. **MotionBuff integration:**
   - gate image features on `auth status --json` → `image.ready` / `.edit` / `.upscale`;
   - use `obrew login --image` or `obrew image setup --json` as its setup button;
   - run `obrew image --json --input-format json --out <job dir>` per image;
   - bump `OBREW_VERSION` once released. It is in `app/src/agent/cli/server/install/index.ts`, currently `'0.1.5'`, and MotionBuff requires that exact version.

   `examples/image-demo/server.ts` shows the full contract.

5. **Two plan items that were not built:**
   - `test/e2e/image.test.ts`, a real-engine test gated by `OBREW_E2E=1`. Until then, `bun run smoke:image` covers the same ground by hand.
   - `scripts/image-presets.ts`, which would regenerate the preset pins (revision, sha256, size) from the Hub. Today the pins are hard-coded in `src/image/presets.ts`.
6. **A faster upscaler** for Metal and CPU. Candidates: Real-ESRGAN x2plus, `realesr-general-x4v3` (compact) or `x4plus_anime_6B`. Check sd.cpp support (it detects the architecture from the weights), the license and Hugging Face availability.
7. **Phase 2:**
   - inpainting (`--mask`);
   - LoRA, plus an SDXL-class CPU / low-end tier (DreamShaper XL v2 Turbo, or RealVisXL + SDXL-Lightning) and Animagine XL 4.0 for anime;
   - an `ernie-image-turbo` preset for text inside images;
   - hires-fix;
   - `serve` `/v1/images/edits`;
   - model hot-swap through `/sdcpp/v1/models/load`;
   - ROCm as the AMD default once it is stable.
8. **Phase 3:** video (`vid_gen`), more upscalers, and an optional bring-your-own ComfyUI backend behind the `ImageBackend` interface in `src/image/engine/client.ts`.
9. **Unrelated finding:** llama.cpp has switched to semver release tags (v0.7.0, 2026-10-15). `llamacpp_tag` (currently `b10937`) and the asset-name scheme in `src/engine/variant.ts` will need a look at the next text-engine bump.

## State on the machine where this was built (macOS)

- `~/Library/Application Support/Obrew/image/` holds:
  - the engine (`engines/master-994-e779d4f-metal/`; the old `master-987-a77d362-metal/` is still there and can be deleted);
  - about 12 GB of models (`models/`, `upscalers/`);
  - `models.json`, `hardware.json`;
  - the log at `logs/sd-server.log`.
- Defaults there: generator `flux2-klein-4b` (base M4), editor `flux2-klein-4b`, upscaler `realesrgan-x4plus`. `z-image-turbo` is also installed.
- To start over: `obrew image engine stop`, delete `<data>/image/`, then `obrew image setup`.

## Cancelling (2026-10-22 follow-up)

- Ctrl-C and a host's kill take the same path: SIGINT and SIGTERM both abort the run, which sends
  `POST /sdcpp/v1/jobs/{id}/cancel` and exits at once. On Windows a kill is TerminateProcess, and
  the next obrew run's reaper (`src/image/engine/jobs.ts`) sends the cancel instead.
- **master-987 could not interrupt a generating job** (409 "cannot be interrupted yet"): the GPU
  finished the cancelled image and the next one queued behind it (102 s on the smoke test).
  `master-994-e779d4f` adds [#2190](https://github.com/leejet/stable-diffusion.cpp/pull/2190): the
  job answers `cancel_requested: true` and stops at its next step (the next image waited 5.5 s,
  one step). `master-995` was skipped: it only adds an LLM-input refactor that touches reference
  edits.
- Guards: the fake sd-server now models this (a generating job stops at its next step);
  `test/image-contract.test.ts` sends SIGINT / SIGTERM to the CLI; `src/image/engine/jobs.test.ts`
  covers the reaper; `smoke:image` has a "cancel (Ctrl-C)" step that fails on master-987. Making
  the fake ignore the cancel fails all three engine-side tests.
- Not checked: `obrew image upscale` is one synchronous request with no job id, so a cancel
  probably does not stop the upscale inside the engine.

## Things learned about sd-server (master-987) worth keeping

- **Model loading:**
  - The model loads lazily. `models/status` says `ready` (with `origin: command_line`) in about a second, and the first job pays the load cost.
  - A load failure leaves the server up with `state: "error"`.
- **No `/health` and no `--log-file`.** obrew captures stdout and stderr itself.
- **img2img without width and height** falls back to 512×512 and center-crops the input, so obrew always sends a size.
- **Previews:** `preview: "proj"` is a cheap latent projection, and it is what carries `step` / `total_steps` in job polling. obrew always requests it.
- **Upscaling:**
  - `/sdcpp/v1/upscale` works with no model loaded.
  - Upscalers come from `--hires-upscalers-dir`, top level only, and are named by file stem.
  - The output is ×4 per pass, capped at 8192 px per side.
- **Defaults to know:**
  - `--batched-cfg` is on by default.
  - `--auto-fit` places weights on GPU, RAM or disk by itself, and `--max-vram` caps it.
  - `--list-devices` shows what a build can use (e.g. `MTL0`, `CPU`).
- **Bun gotchas:**
  - `Bun.spawn` without `env` does not pass `process.env` changes made at runtime; always pass `env: { ...process.env }`.
  - On Windows, a process created through WMI does not inherit the parent's environment at all.
