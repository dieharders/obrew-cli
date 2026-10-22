# Obrew CLI

Local AI models as a headless agent CLI. `obrew-cli` runs GGUF models on your machine through
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, gives the model a fenced set
of tools plus any MCP servers you point it at, and streams what happens as JSON lines.

The Python [obrew-engine](https://github.com/dieharders/obrew-engine) is being ported here in
phases. No Python, no webview, no REPL: one Bun binary.

## Quickstart

```bash
bun install
bun run dev login                      # installs llama-server + pulls the default model
bun run dev exec "say hi"              # human output
bun run dev exec --json "say hi"       # one JSON event per line
bun run dev exec resume <id> "again"   # continue a session
```

## Commands

```
obrew exec [resume <sessionId>] [--json] [--model <id>] [--effort low|medium|high]
           [-c key=value ...] [--cwd <dir>] [--system-prompt <t> | --system-prompt-file <p>]
           [--mcp-server name=<url> ...] [--tools Read,Grep,Glob|none]
           [--image <path> ...] [--vision] ("<prompt>" | --input-format json)
obrew auth status [--json]
obrew login [--model <repo[:file]>] [--mmproj | --no-mmproj] [--image] [--json]
obrew models list|pull <repo>[:file] [--mmproj]|rm <id>|use <id>
obrew engine install [--variant cuda|cpu|vulkan|metal] | status | stop
obrew sessions list|show <id>|rm <id>
obrew image [--json] [--model <id>] [--aspect 16:9 | --size WxH] [--ref <img> | --image <img>]
            [--upscale 2|4] [--count n] [--seed n] [--out <file|dir>] "<prompt>"
obrew image setup | upscale <img> | models list|pull|rm|use | engine install|status|stop|log
```

Every run-time knob is also a `-c key=value` pair (`thinking`, `max_tokens`, `temperature`,
`ctx_size`, `n_gpu_layers`, `tool_mode`, ...), so `exec` and `exec resume` accept the identical
flag set.

A host driving `exec` should pass the turn's text on stdin rather than in argv: with
`--input-format json`, `exec` reads one JSON object, `{"prompt": "...", "systemPrompt": "...",
"outputSchema": {...}}` (`systemPrompt` and `outputSchema` optional), and then EOF. That keeps
a long prompt, or a large schema, clear of the ~32 KB Windows allows for a whole command line,
and nothing has to be written to a temp file.

## Which model runs

`exec` with no `--model` runs the default: the one chosen with `obrew models use <id>`, else
the built-in Gemma 4 E2B when the machine has it, else whatever else it has — so a machine set
up with `obrew models pull` alone still runs. A plain pull never takes the default away from a
model that already holds it, and removing the default falls back to a model that is left rather
than to one that was never downloaded. `obrew models list` marks the default with `*`, and
`obrew auth status` reports it and whether it is installed.

`obrew login` installs that same default, so a choice survives the next login instead of being
replaced by the built-in model; `login --model <repo[:file]>` names one and makes it the default.

## Tools are constrained, always

The model never emits free-form tool JSON. With a chat template that knows about tools
(Qwen 2.5/3, Llama 3.x, Hermes, Mistral, DeepSeek), `obrew` sends the tool schemas and
llama.cpp decodes the call under a grammar built from them. With any other template, or
`-c tool_mode=universal`, choosing a tool and filling its arguments are two separate requests,
each decoded under a JSON schema. Either way the arguments are validated against the tool's
schema before it runs, and an invalid call is repaired once under that schema. A failing tool
is reported back to the model as a result; it never ends the run.

`--output-schema '{...}'` (or `@file.json`, or `outputSchema` on stdin) decodes the final answer
under a schema and puts the parsed value on `turn.completed.output`; `--grammar @file.gbnf` does
the same with GBNF. With tools available the model may use them first and only the answer is
constrained; with `--tools none` the constrained request is the whole turn.

## MCP servers

`--mcp-server name=http://127.0.0.1:1234/mcp` dials a streamable-HTTP MCP server for this run
only; `--mcp-server name=stdio:<command …>` launches one as a child process. Its tools appear
to the model as `mcp__<name>__<tool>`, get the same schema validation as built-ins, and a
result the server marks `isError` is fed back to the model rather than ending the run.

## The warm engine

`exec` keeps one `llama-server` alive between runs (`--engine shared`, the default): the first
run loads the model, later runs with the same model and flags reuse it, a different model
replaces it, and an engine idle for ten minutes is stopped by the next run. `--engine ephemeral`
(or `OBREW_ENGINE=ephemeral`) loads and unloads per run. `obrew engine status|start|stop`
inspect and control it.

On Windows the engine runs with no console window; its log is in the data directory, and
`obrew engine log` prints the tail. To watch it live instead, pass `-c engine_console=true` to
the `exec` or `engine start` that starts it: that engine gets a console window of its own
(closing the window stops the engine). A warm engine keeps whatever it started with, so run
`obrew engine stop` first to switch.

`obrew serve --port 8008` fronts the same engine with an OpenAI-compatible API:
`/v1/chat/completions`, `/v1/completions`, `/v1/models`, plus `/obrew/status`, `/obrew/models`
and `POST /obrew/models/pull` (SSE progress), which installs a model the way `obrew models pull`
does and leaves the default alone — `POST /obrew/models/default {"id": "<model id>"}` is
`obrew models use` for when a host wants to move it. The `model` field picks the model and
swaps the engine when it differs.

## Vision, search, embeddings

- `obrew exec --image still.png "what is shown?"` shows the model an image, through its vision
  projector (mmproj). `obrew login` downloads the projector the model's repo publishes for it
  (`--no-mmproj` declines it, and later logins remember that; `--mmproj` insists, and fails
  where there is none), `obrew models pull` only with `--mmproj`, and `obrew auth status`
  reports it as `model.vision`. The transcript keeps a marker per image, not the bytes.
- Having the projector is not loading it: it costs memory and load time, so only a run that
  asks for vision loads it — `--image`, or `--vision` to let Read show the model images without
  attaching one. `obrew engine start --vision` and `obrew serve --vision` do the same. A warm
  engine is reused only with the same flags, so a host that mixes image and text turns keeps one
  engine warm by passing `--vision` on all of them.
- `--tools Read,Grep,Glob,WebSearch` adds a DuckDuckGo-backed search tool (opt-in).
- `obrew models pull nomic-ai/nomic-embed-text-v1.5-GGUF && obrew models use --embed <id>` sets
  an embedding model; `obrew embed --query "…" "text a" "text b"` ranks texts by cosine
  similarity, `obrew embed --image x.png` embeds an image with a vision embedding model, and
  `serve` answers `/v1/embeddings`. Embeddings are in-memory only: nothing is stored between
  runs, by design.

## Images

`obrew image` generates images locally: text to image, image to image, edits with reference
images, and upscaling. It is its own module (`src/image/`) with its own engine — a pinned
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) `sd-server`
(`sdcpp_tag` in package.json) kept warm between runs like the text engine — and its own state
under `<data>/image/`. Why this engine and these models: [docs/image-generation.md](docs/image-generation.md).

```bash
obrew image setup                              # engine + default models + upscaler (several GB)
obrew image "a lighthouse at dusk" --aspect 16:9
obrew image "same lighthouse, winter night" --ref lighthouse.png     # edit with a reference
obrew image "a watercolor of it" --image lighthouse.png --strength 0.5
obrew image "a lighthouse" --size 1920x1080   # exact: generated at 1920×1088 and cropped
obrew image upscale lighthouse.png --scale 2
obrew image models list|pull|rm|use   obrew image engine install|status|stop|log
```

- **Models.** `setup` installs Z-Image-Turbo (default generator), FLUX.2 [klein] 4B (default
  editor; also the default generator on CPU-only machines and base Apple chips, where it is the
  fast one) and Real-ESRGAN x4plus. All Apache-2.0 / BSD-3-Clause and ungated on Hugging Face,
  pinned by commit and SHA-256; the two generators share one Qwen3-4B text encoder file. Under
  ~7.5 GiB of GPU memory, smaller quantisations are chosen. Any other model sd.cpp supports
  installs from its parts: `models pull --name <id> --diffusion org/repo[@rev]:path --llm …`.
- **Engine.** `cuda` on Windows NVIDIA (driver for CUDA 12.8+), `vulkan` for AMD / Intel and for
  Linux NVIDIA, `metal` on macOS, `cpu` otherwise; `--variant rocm` on AMD. Memory flags
  (`--offload-to-cpu`, `--max-vram`, `--vae-tiling`) are chosen from the detected VRAM;
  `-c max_vram= / offload= / vae_tiling= / backend=` override them.
- **Sizes.** `--aspect` picks a native size (16:9 = 1280×720). `--size WxH` is exact: made
  directly when the model can, rounded up and cropped when that fits, else generated smaller,
  upscaled ×4 and resampled. `--upscale 2|4` upscales the result.
- **Hosts.** `--json` prints one event per line: `image.started`, `image.progress` (queue
  position, step, decoding, upscaling), `image.preview` (with `--preview fast`), `image.saved`
  (path, size, seed, model, duration), `image.completed`, or `image.failed` (exit 1; codes as
  for `exec`, plus `out_of_memory`). `--input-format json` reads `{"prompt", "negativePrompt"?}`
  from stdin. A kill cancels the job in the engine. `obrew auth status --json` reports an
  `image` block (`ready`, `edit`, `upscale`) without changing `ready`; `obrew login --image` also
  sets images up; `obrew engine stop` stops both engines. When the text and image engines do not
  both fit in GPU memory, an idle one is stopped to make room — never a busy one.
- **serve.** `POST /v1/images/generations` (`prompt`, `n`, `size`, `aspect`, `seed`, `steps`,
  `output_format`, `negative_prompt`) answers OpenAI-style `data[].b64_json`; `"stream": true`
  sends the `image.*` events over SSE instead.

`bun run demo:image` starts a small web app ([examples/image-demo](examples/image-demo)) that
drives the CLI the way a host app does. `bun run smoke:image [--bench]` is the real-hardware check.

## Where things live

`%LOCALAPPDATA%\Obrew` on Windows, `~/Library/Application Support/Obrew` on macOS,
`$XDG_DATA_HOME/obrew` on Linux. Override with `OBREW_HOME`. Engines are downloaded from the
pinned llama.cpp release (`llamacpp_tag` in package.json); models from Hugging Face.

## Development

```bash
bun run typecheck && bun run lint && bun test
bun run build            # -> ./obrew[.exe]
bun run build:all        # -> dist/ + SHA256SUMS
```
