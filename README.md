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
`ctx_size`, `n_gpu_layers`, ...), so `exec` and `exec resume` accept the identical flag set.

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
