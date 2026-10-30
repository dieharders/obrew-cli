/**
 * Unpack a .zip in-process, for hosts whose `tar` cannot.
 *
 * GNU tar, the `tar` on Linux, reads only tar formats and fails on a .zip outright; bsdtar on
 * macOS and Windows reads both. stable-diffusion.cpp publishes its Linux builds as .zip, and
 * the ROCm one holds a 1.3 GB shared library inside a 282 MB archive, so this reader STREAMS:
 * each entry's bytes go from a slice of the file, through inflate when deflated, into a write
 * stream that pushes back when the disk falls behind. No entry is ever held in memory whole.
 *
 * Scope is what release archives use: stored and deflated entries, ZIP64, directories, Unix
 * modes and symlinks. Encrypted entries and other methods are refused, by name, before the
 * first byte is written. Sizes and offsets come from the central directory. A local header is
 * read only for its name and extra lengths, because a writer that streams (a data descriptor,
 * flag bit 3) leaves zeros where the local sizes would be.
 *
 * Nothing lands outside `intoDir`: names that would escape it (zip-slip) and symlinks whose
 * targets lead out of it are refused, and nothing is written through a symlink already on
 * disk. CRC-32 is not checked, because callers SHA-256-verify the whole archive before it is
 * extracted; unpacked sizes are, which catches a misread offset or a short stream.
 */
import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, rm, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, inflateRawSync } from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50
const END64_SIG = 0x06064b50
const LOCATOR64_SIG = 0x07064b50
const LOCAL_LEN = 30
const CENTRAL_LEN = 46
const END_LEN = 22
const END64_LEN = 56
const LOCATOR64_LEN = 20
/** A 32-bit size or offset saturated to this has its real value in the ZIP64 extra field. */
const ZIP64_MARK = 0xffffffff
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
/** PATH_MAX on Linux: no real symlink target is longer. */
const MAX_LINK = 4096
const METHOD_NAMES: Record<number, string> = {
  9: 'deflate64',
  12: 'bzip2',
  14: 'LZMA',
  93: 'zstd',
  95: 'xz',
}

const utf8 = new TextDecoder()

interface Archive {
  path: string
  size: number
}

interface Entry {
  /** As stored, for messages. */
  name: string
  /** Path segments below the destination, already checked for zip-slip. */
  parts: string[]
  dir: boolean
  method: number
  compressedSize: number
  size: number
  localOffset: number
  /** The Unix mode from the high half of the external attributes; 0 when none was recorded. */
  mode: number
}

type Zip64Fields = Pick<Entry, 'size' | 'compressedSize' | 'localOffset'>

export async function extractZip(archive: string, intoDir: string): Promise<void> {
  const zip: Archive = { path: archive, size: (await stat(archive)).size }
  // Every entry is parsed and checked before anything is written, so a bad name or method
  // fails the archive up front rather than halfway through it.
  const entries = await readEntries(zip)
  const root = resolve(intoDir)
  await mkdir(root, { recursive: true })

  const posix = process.platform !== 'win32'
  const madeDirs = new Set<string>([root])
  const dirModes: Array<[string, number]> = []
  for (const entry of entries) {
    const dest = resolve(root, ...entry.parts)
    if (!inside(root, dest)) throw unsafeName(entry.name)
    const perms = entry.mode & 0o777
    if (entry.dir) {
      await makeDirs(madeDirs, root, entry.parts)
      if (posix && perms) dirModes.push([dest, perms])
      continue
    }
    await makeDirs(madeDirs, root, entry.parts.slice(0, -1))
    const start = await dataStart(zip, entry)
    if (posix && (entry.mode & S_IFMT) === S_IFLNK) {
      await writeSymlink(zip, entry, start, root, dest)
      continue
    }
    // Replace, never write through: a symlink already at `dest` must not redirect the bytes.
    await rm(dest, { force: true })
    await writeData(zip, entry, start, dest)
    if (posix && perms) await chmod(dest, perms)
  }
  // Directory modes go last and deepest first, so a read-only directory cannot lock out its
  // own contents, or the chmod of a directory below it.
  dirModes.sort((a, b) => b[0].length - a[0].length)
  for (const [dir, mode] of dirModes) await chmod(dir, mode)
}

/** Parse and check the central directory, the one authoritative list of entries. */
async function readEntries(zip: Archive): Promise<Entry[]> {
  const { offset, size, count } = await findCentralDirectory(zip)
  const cd = await readAt(zip, offset, size)
  const bytes = new Uint8Array(cd.buffer, cd.byteOffset, cd.byteLength)
  const entries: Entry[] = []
  for (let i = 0, p = 0; i < count; i++) {
    const damaged = () => invalid(zip, `central directory entry ${i + 1} of ${count} is damaged`)
    if (p + CENTRAL_LEN > cd.byteLength || cd.getUint32(p, true) !== CENTRAL_SIG) throw damaged()
    const nameEnd = p + CENTRAL_LEN + cd.getUint16(p + 28, true)
    const extraEnd = nameEnd + cd.getUint16(p + 30, true)
    const next = extraEnd + cd.getUint16(p + 32, true)
    if (next > cd.byteLength) throw damaged()

    // UTF-8 whatever flag bit 11 says: release archives are ASCII, and `.`, `/` and `\` are
    // the same bytes in every encoding, so the zip-slip checks below hold either way.
    const name = utf8.decode(bytes.subarray(p + CENTRAL_LEN, nameEnd))
    const flags = cd.getUint16(p + 8, true)
    const method = cd.getUint16(p + 10, true)
    const fields: Zip64Fields = {
      compressedSize: cd.getUint32(p + 20, true),
      size: cd.getUint32(p + 24, true),
      localOffset: cd.getUint32(p + 42, true),
    }
    applyZip64(zip, name, cd, nameEnd, extraEnd, fields)
    const mode = cd.getUint32(p + 38, true) >>> 16
    p = next

    const { parts, dir } = entryPath(name)
    if (parts.length === 0) {
      if (dir) continue // `./`: the destination itself
      throw invalid(zip, `entry ${JSON.stringify(name)} has no file name`)
    }
    if (!dir && (flags & 1) !== 0) {
      throw new Error(`zip entry ${name} is encrypted, which is not supported`)
    }
    if (!dir && method !== 0 && method !== 8) {
      const label = METHOD_NAMES[method] ?? 'unknown'
      throw new Error(
        `zip entry ${name} uses compression method ${method} (${label}); ` +
          'only stored (0) and deflate (8) are supported',
      )
    }
    entries.push({ name, parts, dir, method, mode, ...fields })
  }
  return entries
}

/**
 * Find the central directory through the end record: the last 22 bytes, unless a comment of
 * up to 64 KiB follows it. ZIP64 archives put a locator just before that record, pointing at
 * a second end record with 64-bit values, which then win.
 */
async function findCentralDirectory(
  zip: Archive,
): Promise<{ offset: number; size: number; count: number }> {
  const tailStart = Math.max(0, zip.size - (END_LEN + 0xffff))
  const tail = await readAt(zip, tailStart, zip.size - tailStart)
  let at = -1
  for (let i = tail.byteLength - END_LEN; i >= 0; i--) {
    // The comment length must fit in the file, which skips a stray signature inside a comment.
    if (
      tail.getUint32(i, true) === END_SIG &&
      i + END_LEN + tail.getUint16(i + 20, true) <= tail.byteLength
    ) {
      at = i
      break
    }
  }
  if (at < 0) throw invalid(zip, 'no end of central directory record')
  const end = tailStart + at
  let count = tail.getUint16(at + 10, true)
  let size = tail.getUint32(at + 12, true)
  let offset = tail.getUint32(at + 16, true)

  if (end >= LOCATOR64_LEN) {
    const locator = await readAt(zip, end - LOCATOR64_LEN, LOCATOR64_LEN)
    if (locator.getUint32(0, true) === LOCATOR64_SIG) {
      const record = await readAt(zip, u64(locator, 8), END64_LEN)
      if (record.getUint32(0, true) !== END64_SIG) {
        throw invalid(zip, 'its ZIP64 end of central directory record is missing')
      }
      count = u64(record, 32)
      size = u64(record, 40)
      offset = u64(record, 48)
    }
  }
  if (offset + size > end) throw invalid(zip, 'the central directory lies outside the file')
  return { offset, size, count }
}

/**
 * A size or offset saturated at 0xFFFFFFFF has its real value in the ZIP64 extra field
 * (0x0001): 8 bytes each, in this order, for exactly the fields that are saturated.
 */
function applyZip64(
  zip: Archive,
  name: string,
  cd: DataView,
  start: number,
  end: number,
  fields: Zip64Fields,
): void {
  const { size, compressedSize, localOffset } = fields
  if (size !== ZIP64_MARK && compressedSize !== ZIP64_MARK && localOffset !== ZIP64_MARK) return
  for (let p = start; p + 4 <= end; p += 4 + cd.getUint16(p + 2, true)) {
    if (cd.getUint16(p, true) !== 0x0001) continue
    let at = p + 4
    const stop = Math.min(end, at + cd.getUint16(p + 2, true))
    const take = (value: number) => {
      if (value !== ZIP64_MARK) return value
      if (at + 8 > stop) throw invalid(zip, `${name} has a short ZIP64 extra field`)
      at += 8
      return u64(cd, at - 8)
    }
    fields.size = take(size)
    fields.compressedSize = take(compressedSize)
    fields.localOffset = take(localOffset)
    return
  }
  throw invalid(zip, `${name} is missing its ZIP64 extra field`)
}

/**
 * An entry name as path segments below the destination. Backslashes count as separators
 * (Windows tools write them), and any name that could land outside the destination is refused
 * (zip-slip): an absolute path, a drive letter, or a `..` segment anywhere.
 */
function entryPath(name: string): { parts: string[]; dir: boolean } {
  const path = name.replace(/\\/g, '/')
  const parts = path.split('/').filter((part) => part !== '' && part !== '.')
  if (path.startsWith('/') || /^[a-z]:/i.test(parts[0] ?? '') || parts.includes('..')) {
    throw unsafeName(name)
  }
  return { parts, dir: path.endsWith('/') }
}

const unsafeName = (name: string) =>
  new Error(`refusing zip entry ${JSON.stringify(name)}: its path could escape the destination`)

/** Lexically, is `path` the same as `root` or below it? */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * `mkdir -p` below `root` that passes through real directories only. A symlink in the way (from
 * an earlier entry, or an earlier archive unpacked into the same place) is an error, not a
 * redirect. `made` remembers the directories already made or checked.
 */
async function makeDirs(made: Set<string>, root: string, parts: string[]): Promise<void> {
  let dir = root
  for (const part of parts) {
    dir = join(dir, part)
    if (made.has(dir)) continue
    try {
      await mkdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (!(await lstat(dir)).isDirectory()) {
        throw new Error(`cannot unpack into ${dir}: it is a file or a symlink, not a directory`)
      }
    }
    made.add(dir)
  }
}

/** Where an entry's data begins. Only the local header's name and extra lengths are used. */
async function dataStart(zip: Archive, entry: Entry): Promise<number> {
  const local = await readAt(zip, entry.localOffset, LOCAL_LEN)
  if (local.getUint32(0, true) !== LOCAL_SIG) {
    throw invalid(zip, `no local header for ${entry.name}`)
  }
  // The local extra field is often a different length from the central one.
  const nameAndExtra = local.getUint16(26, true) + local.getUint16(28, true)
  const start = entry.localOffset + LOCAL_LEN + nameAndExtra
  if (start + entry.compressedSize > zip.size) {
    throw invalid(zip, `${entry.name} runs past the end of the file`)
  }
  return start
}

/** Stream one entry to `dest`. `pipeline` carries the disk's backpressure back to the read. */
async function writeData(zip: Archive, entry: Entry, start: number, dest: string): Promise<void> {
  const end = start + entry.compressedSize
  const data = Bun.file(zip.path).slice(start, end).stream()
  const out = createWriteStream(dest)
  try {
    if (entry.method === 8) await pipeline(data, createInflateRaw(), out)
    else await pipeline(data, out)
  } catch (err) {
    throw new Error(`unpacking ${entry.name} failed: ${(err as Error).message}`, { cause: err })
  }
  if (out.bytesWritten !== entry.size) {
    throw invalid(zip, `${entry.name} unpacked to ${out.bytesWritten} bytes, not ${entry.size}`)
  }
}

/** An S_IFLNK entry's data is its target, which must not lead out of `root`. */
async function writeSymlink(
  zip: Archive,
  entry: Entry,
  start: number,
  root: string,
  dest: string,
): Promise<void> {
  if (entry.size > MAX_LINK || entry.compressedSize > 2 * MAX_LINK) {
    throw invalid(zip, `symlink ${entry.name} has a ${entry.size}-byte target`)
  }
  const view = await readAt(zip, start, entry.compressedSize)
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  const target = utf8.decode(
    entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_LINK }) : raw,
  )
  if (!target || !inside(root, resolve(dirname(dest), target))) {
    throw new Error(`refusing symlink ${entry.name} -> ${target}: it points outside ${root}`)
  }
  await rm(dest, { force: true })
  await symlink(target, dest)
}

async function readAt(zip: Archive, start: number, length: number): Promise<DataView> {
  const end = start + length
  const buf = await Bun.file(zip.path).slice(start, end).arrayBuffer()
  if (buf.byteLength !== length) throw invalid(zip, `it ends before byte ${end}`)
  return new DataView(buf)
}

/** A ZIP64 field as a Number: exact up to 8 PiB, which no archive approaches. */
function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ZIP64 value ${value} is too large`)
  return Number(value)
}

const invalid = (zip: Archive, why: string) => new Error(`${zip.path} is not a valid zip: ${why}`)
