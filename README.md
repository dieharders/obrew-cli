# obrew

Local AI models as a headless agent CLI. `obrew` runs GGUF models on your machine through
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, gives the model a fenced set
of tools plus any MCP servers you point it at, and streams what happens as JSON lines. It is
shaped like `codex exec --json` so host apps (MotionBuff, BunView) can drive it as a provider next
to Claude Code and Codex.

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
           [--mcp-server name=<url> ...] [--tools Read,Grep,Glob|none] "<prompt>"
obrew auth status [--json]
obrew login [--model <repo[:file]>] [--json]
obrew models list|pull <repo>[:file] [--mmproj]|rm <id>|use <id>
obrew engine install [--variant cuda|cpu|vulkan|metal] | status | stop
obrew sessions list|show <id>|rm <id>
```

Every run-time knob is also a `-c key=value` pair (`thinking`, `max_tokens`, `temperature`,
`ctx_size`, `n_gpu_layers`, `tool_mode`, ...), so `exec` and `exec resume` accept the identical
flag set.

## Tools are constrained, always

The model never emits free-form tool JSON. With a chat template that knows about tools
(Qwen 2.5/3, Llama 3.x, Hermes, Mistral, DeepSeek), `obrew` sends the tool schemas and
llama.cpp decodes the call under a grammar built from them. With any other template, or
`-c tool_mode=universal`, choosing a tool and filling its arguments are two separate requests,
each decoded under a JSON schema. Either way the arguments are validated against the tool's
schema before it runs, and an invalid call is repaired once under that schema. A failing tool
is reported back to the model as a result; it never ends the run.

`--output-schema '{...}'` (or `@file.json`) decodes the final answer under a schema and puts the
parsed value on `turn.completed.output`; `--grammar @file.gbnf` does the same with GBNF.

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

`obrew serve --port 8008` fronts the same engine with an OpenAI-compatible API:
`/v1/chat/completions`, `/v1/completions`, `/v1/models`, plus `/obrew/status`, `/obrew/models`
and `POST /obrew/models/pull` (SSE progress). The `model` field picks the model and swaps the
engine when it differs.

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
