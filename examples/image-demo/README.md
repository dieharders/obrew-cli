# obrew image demo

A small web app that shows what `obrew image` can do, by driving the CLI exactly the way a host
app (MotionBuff) does: a subprocess per request, the prompt as JSON on stdin, one JSON event per
stdout line relayed to the browser, and a kill to cancel. It imports nothing from obrew's sources.

```bash
bun run demo:image                        # from the repo root; open the printed URL
OBREW_BIN=./obrew bun run demo:image      # against a built binary
OBREW_DEMO_PORT=9000 OBREW_DEMO_OUT=/tmp/imgs bun run demo:image
```

What to try:

- **Set up.** On a machine without image models, the page offers one button; it runs
  `obrew image setup --json` and shows the download plan and progress.
- **Use cases.** Thumbnail, Character, Photoreal, Architecture, Abstract and Poster / text pick a
  model, an aspect ratio and prompt scaffolding (`presets.ts`). Poster / text wants MOSS-Image,
  which `setup` does not install: `obrew image models pull moss-image-sft` (9.4 GB) first. Its
  default is 50 steps; the **Steps** field overrides any model's default (`--steps`).
- **Thumbnails.** The model paints the art with room on the left; the title is drawn by the page
  in real type over it, live as you type, and exported as a PNG — exact and editable, which no
  model's in-image text is.
- **Characters.** "Same character, new scene" turns a result into a reference image (`--ref`):
  FLUX.2 klein keeps the character and changes what the prompt asks for. "Vary" re-runs a
  request with the result as its reference and a new seed.
- **Start from your own picture.** Drop one in as a reference (edit) or for image to image, with
  a strength slider.
- **Exact sizes and upscaling.** "Exactly 1920×1080", and "Upscale ×2" on any result.
- **Live progress.** Steps, a preview frame per step, the CLI's own stderr under "CLI output".

| Route                | CLI call                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/status`    | `obrew auth status --json`                                                             |
| `GET /api/models`    | `obrew image models list --json`                                                       |
| `POST /api/setup`    | `obrew image setup --json`, relayed as SSE                                             |
| `POST /api/upload`   | none: saves the image into the output directory                                        |
| `POST /api/generate` | `obrew image --json --input-format json --out <dir> --preview fast …`, prompt on stdin |
| `POST /api/upscale`  | `obrew image upscale <file> --scale 2 --json --out <dir>`                              |

Images are saved in `examples/image-demo/.out/` (ignored by git). Tests: `bun test examples`.
