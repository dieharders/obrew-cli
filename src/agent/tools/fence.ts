/**
 * The cwd fence for the built-in file tools.
 *
 * A path is allowed when its REAL location (symlinks resolved) is inside the real cwd. Checked
 * after resolution rather than by string prefix on the input, because `..`, absolute paths
 * and a symlink out of the tree all look harmless before resolution and are the same escape
 * afterwards. A path that does not exist yet is checked by its nearest existing ancestor.
 */
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class FenceError extends Error {
  constructor(path: string) {
    super(`DENIED: ${path} is outside the working directory`)
    this.name = 'FenceError'
  }
}

async function realOrAncestor(path: string): Promise<string> {
  let probe = path
  for (;;) {
    try {
      const real = await realpath(probe)
      return probe === path ? real : resolve(real, relative(probe, path))
    } catch {
      const parent = dirname(probe)
      if (parent === probe) throw new FenceError(path)
      probe = parent
    }
  }
}

/** Resolve `input` against `cwd` and prove it stays inside; returns the absolute path. */
export async function resolveInside(cwd: string, input: string): Promise<string> {
  const target = isAbsolute(input) ? resolve(input) : resolve(cwd, input)
  const [realRoot, realTarget] = await Promise.all([realpath(cwd), realOrAncestor(target)])
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep
  const same = process.platform === 'win32' ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b
  const inside =
    same(realTarget, realRoot) ||
    same(realTarget.slice(0, rootWithSep.length), rootWithSep)
  if (!inside) throw new FenceError(input)
  return realTarget
}
