/**
 * `obrew embed [--model <id>] [--json] [--image <path>] [--query <text>] <text …>`
 *
 * Embeds each text (or image) with the embedding model. With `--query`, ranks the inputs by
 * cosine similarity to the query instead — the in-memory index, end to end, from the shell.
 */
import { EmbeddingEngine } from '../../embed/engine'
import { EmbeddingIndex } from '../../embed/index'
import { UsageError } from '../../shared/errors'
import { track, untrack } from '../../shared/proc'
import { parse } from '../args'

const HELP = `obrew embed [--model <id>] [--json] <text …>          vectors for each text
obrew embed --image <path> [--json]                    vector for an image (vision embed model)
obrew embed --query <text> <text …> [--json]           rank the texts against the query`

export async function runEmbed(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    help: { type: 'boolean', short: 'h', default: false },
    json: { type: 'boolean', default: false },
    model: { type: 'string' },
    image: { type: 'string', multiple: true },
    query: { type: 'string' },
  } as const)
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const texts = positionals
  const images = values.image ?? []
  if (texts.length === 0 && images.length === 0) throw new UsageError('embed needs at least one text or --image')

  const controller = new AbortController()
  track(controller)
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  const engine = await EmbeddingEngine.open(values.model, controller.signal)
  try {
    if (values.query) {
      const index = new EmbeddingIndex<string>()
      for (const [i, text] of texts.entries()) index.add(String(i), await engine.embed(text), text)
      const hits = index.search(await engine.embed(values.query), texts.length)
      if (values.json) console.log(JSON.stringify({ model: engine.model.id, query: values.query, hits }))
      else for (const h of hits) console.log(`${h.score.toFixed(4)}  ${h.meta}`)
      return 0
    }
    const vectors = [
      ...(await Promise.all(texts.map(async (t) => ({ input: t, embedding: await engine.embed(t) })))),
      ...(await Promise.all(images.map(async (p) => ({ input: p, embedding: await engine.embedImage(p) })))),
    ]
    if (values.json) console.log(JSON.stringify({ model: engine.model.id, data: vectors }))
    else for (const v of vectors) console.log(`${v.input.slice(0, 40).padEnd(40)}  ${v.embedding.length} dims  [${v.embedding.slice(0, 4).map((x) => x.toFixed(4)).join(', ')} …]`)
    return 0
  } finally {
    await engine.close()
    process.off('SIGINT', onSignal)
    untrack(controller)
  }
}
