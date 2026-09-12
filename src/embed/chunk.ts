/**
 * Split text into chunks an embedding model can take, on sentence boundaries.
 *
 * The one piece of obrew-engine's text_splitters.py that the in-memory index needs: a large
 * input is cut into pieces of at most `maxChars`, each ending at a sentence boundary found by
 * `Intl.Segmenter` (built in; replaces the pysbd dependency). Paragraph breaks are respected
 * first so a chunk does not straddle unrelated sections. A single sentence longer than the
 * limit is split hard.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })

export interface Chunk {
  text: string
  /** Character offset of the chunk in the original text. */
  start: number
}

export function sentences(text: string): string[] {
  return [...segmenter.segment(text)].map((s) => s.segment)
}

export function chunkText(text: string, maxChars = 1500): Chunk[] {
  if (text.length <= maxChars) return text.trim() ? [{ text, start: 0 }] : []
  const chunks: Chunk[] = []
  let offset = 0
  for (const para of text.split(/\n{2,}/)) {
    const start = text.indexOf(para, offset)
    offset = start + para.length
    if (!para.trim()) continue
    if (para.length <= maxChars) {
      chunks.push({ text: para, start })
      continue
    }
    let buffer = ''
    let bufferStart = start
    let cursor = start
    for (const sentence of sentences(para)) {
      if (sentence.length > maxChars) {
        if (buffer) chunks.push({ text: buffer, start: bufferStart })
        for (let i = 0; i < sentence.length; i += maxChars) chunks.push({ text: sentence.slice(i, i + maxChars), start: cursor + i })
        buffer = ''
        cursor += sentence.length
        bufferStart = cursor
        continue
      }
      if (buffer.length + sentence.length > maxChars) {
        chunks.push({ text: buffer, start: bufferStart })
        buffer = ''
        bufferStart = cursor
      }
      buffer += sentence
      cursor += sentence.length
    }
    if (buffer.trim()) chunks.push({ text: buffer, start: bufferStart })
  }
  return chunks
}
