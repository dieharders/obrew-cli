/**
 * Glob — files matching a pattern, inside the fence. Port of obrew-engine's `file_glob`
 * / `file_scan` on `Bun.Glob`.
 */
import { relative } from 'node:path'
import { resolveInside } from './fence'
import type { Tool } from './types'

const MAX_RESULTS = 2000
const SKIP = /(^|[\\/])(node_modules|\.git)([\\/]|$)/

export const globTool: Tool = {
  name: 'Glob',
  description:
    'List files matching a glob pattern (e.g. "**/*.ts", "src/*.json") under the working ' +
    'directory or a sub-directory. Returns relative paths, sorted.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search, relative to the working directory' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const root = await resolveInside(ctx.cwd, typeof args.path === 'string' ? args.path : '.')
    const glob = new Bun.Glob(String(args.pattern))
    const out: string[] = []
    for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
      if (SKIP.test(rel)) continue
      out.push(relative(ctx.cwd, `${root}/${rel}`).replaceAll('\\', '/'))
      if (out.length >= MAX_RESULTS) break
    }
    out.sort()
    if (out.length === 0) return { content: 'No files matched.' }
    const note = out.length >= MAX_RESULTS ? `\n(stopped at ${MAX_RESULTS} results)` : ''
    return { content: out.join('\n') + note }
  },
}
