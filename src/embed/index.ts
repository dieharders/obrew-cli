/**
 * An in-memory vector index. Nothing is persisted, on purpose: documents are re-read on
 * demand (the way claude-code works), and embeddings exist to rank pieces of them within one
 * run — or to give a vision model an image to compare against. Brute-force cosine over
 * unit-normalised Float32 vectors is exact and fast enough for the tens of thousands of
 * chunks a run can hold.
 */
export interface IndexEntry<M = unknown> {
  id: string
  meta?: M
}

export interface Hit<M = unknown> extends IndexEntry<M> {
  score: number
}

export function normalise(vector: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vector.length)
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!
  const norm = Math.sqrt(sum) || 1
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm
  return out
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!
  return dot
}

export class EmbeddingIndex<M = unknown> {
  private readonly entries: Array<IndexEntry<M> & { vector: Float32Array }> = []
  private dim: number | null = null

  get size(): number {
    return this.entries.length
  }

  get dimension(): number | null {
    return this.dim
  }

  add(id: string, vector: ArrayLike<number>, meta?: M): void {
    if (this.dim === null) this.dim = vector.length
    else if (vector.length !== this.dim) throw new Error(`embedding dimension ${vector.length} does not match index dimension ${this.dim}`)
    this.entries.push({ id, meta, vector: normalise(vector) })
  }

  remove(id: string): boolean {
    const i = this.entries.findIndex((e) => e.id === id)
    if (i === -1) return false
    this.entries.splice(i, 1)
    return true
  }

  /** The `k` nearest entries by cosine similarity, best first. */
  search(query: ArrayLike<number>, k = 5): Hit<M>[] {
    const q = normalise(query)
    return this.entries
      .map((e) => ({ id: e.id, meta: e.meta, score: cosine(q, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }
}
