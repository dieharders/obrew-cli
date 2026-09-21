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
           ("<prompt>" | --input-format json)
obrew auth status [--json]
obrew login [--model <repo[:file]>] [--json]
obrew models list|pull <repo>[:file] [--mmproj]|rm <id>|use <id>
obrew engine install [--variant cuda|cpu|vulkan|metal] | status | stop
obrew sessions list|show <id>|rm <id>
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
`OBREW_MODEL=<id>` names the baseline model for a host that configures by environment: below an
explicit `--model`, above the default.

## The tool model

Two models, two jobs. The **baseline** model above writes — prose, narration, the content of an
answer. The **tool model** turns what it wrote into a tool call. It is
[Needle 3](https://cactuscompute.com/needle): 121M parameters, 36 MB, a model that only emits
function calls, and whose arguments are spans copied from its input, so it is never asked to
invent anything. It is not a GGUF and llama.cpp cannot load it; `obrew login` (or
`obrew engine install --needle`) fetches it and its ~1 MB runner from a pinned Hugging Face
commit, checksum-verified, and it runs as its own small process **beside** llama-server, kept
warm the same way (`obrew engine status` lists it, `obrew engine stop` stops it). The runner's
telemetry is always switched off; nothing can turn it on.

In universal tool mode the baseline model states the next step in plain lines —

    tool: snapshot
    slideId: slide-3

— seeing only each tool's name, description and argument names, while Needle holds the JSON
schemas and produces the call in tens of milliseconds. Every value is then checked against the
text it came from. Whatever does not check out — an unsure choice, arguments that are an
authored body such as a file's contents — goes to the two constrained requests described below,
so a run never depends on the tool model: without it (`-c tool_model=none`,
`OBREW_TOOL_MODEL=none`, `obrew models use --tool none`, or a platform with no runner) obrew
behaves exactly as it did before.

`-c tool_answers=true` (or `OBREW_TOOL_ANSWERS=1`) extends this to `--output-schema` answers:
drafted as text with thinking allowed, structured by Needle. It is **off by default** because
needle3 does not yet copy multi-field records reliably (60–67% of fields exact in our tests,
non-ASCII text mangled); each miss is caught and decoded under a grammar instead, at the cost of
the draft.

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

- `obrew exec --image still.png "what is shown?"` attaches images to a model pulled with
  `--mmproj`. The transcript keeps a marker per image, not the bytes.
- `--tools Read,Grep,Glob,WebSearch` adds a DuckDuckGo-backed search tool (opt-in).
- `obrew models pull nomic-ai/nomic-embed-text-v1.5-GGUF && obrew models use --embed <id>` sets
  an embedding model; `obrew embed --query "…" "text a" "text b"` ranks texts by cosine
  similarity, `obrew embed --image x.png` embeds an image with a vision embedding model, and
  `serve` answers `/v1/embeddings`. Embeddings are in-memory only: nothing is stored between
  runs, by design.

## Where things live

`%LOCALAPPDATA%\Obrew` on Windows, `~/Library/Application Support/Obrew` on macOS,
`$XDG_DATA_HOME/obrew` on Linux. Override with `OBREW_HOME`. Engines are downloaded from the
pinned llama.cpp release (`llamacpp_tag` in package.json); models from Hugging Face; the tool
model from the pinned `needle_rev`. `.env.example` lists the environment variables obrew reads.

## Development

```bash
bun run typecheck && bun run lint && bun test
bun run build            # -> ./obrew[.exe]
bun run build:all        # -> dist/ + SHA256SUMS
```
