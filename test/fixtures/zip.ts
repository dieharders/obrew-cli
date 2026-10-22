/**
 * A minimal zip WRITER, so the unzip tests can build exactly the archive they need: stored or
 * deflated entries, directories, Unix modes, symlinks and, on request, ZIP64 records. The
 * system `zip` is missing from Windows and slim Linux images, and neither it nor bsdtar takes
 * a mode or a link target as input. The archive is built in memory, which is fine at test sizes.
 */
import { writeFile } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** Path inside the archive. A trailing `/` makes it a directory. */
  name: string
  data?: Uint8Array
  /** Unix permission bits, e.g. 0o755. The file-type bits are added from the entry's kind. */
  mode?: number
  /** Make this entry a symlink to this target, which is then the entry's data. */
  symlink?: string
  /** 0 = stored, 8 = deflate (the default). Directories are always stored. */
  method?: 0 | 8
}

export interface ZipOptions {
  /** Write ZIP64 extra fields and end records although nothing here needs them. */
  zip64?: boolean
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 1 Jan 2025, 00:00, in MS-DOS format, so the same entries always make the same bytes. */
const DOS_DATE = ((2025 - 1980) << 9) | (1 << 5) | 1
const DOS_TIME = 0
/** Flag bit 11: the name is UTF-8. */
const UTF8_FLAG = 0x0800
const MARK32 = 0xffffffff
const encoder = new TextEncoder()

function record(length: number, fill: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(length)
  fill(new DataView(bytes.buffer))
  return bytes
}

/** A ZIP64 extended-information extra field (0x0001) holding these 8-byte values. */
const zip64Extra = (values: number[]) =>
  record(4 + 8 * values.length, (v) => {
    v.setUint16(0, 0x0001, true)
    v.setUint16(2, 8 * values.length, true)
    values.forEach((value, i) => v.setBigUint64(4 + 8 * i, BigInt(value), true))
  })

export async function writeZip(
  path: string,
  entries: ZipEntry[],
  opts: ZipOptions = {},
): Promise<void> {
  const zip64 = opts.zip64 ?? false
  const version = zip64 ? 45 : 20
  /** "Version made by": the high byte says Unix, so readers trust the mode in the attributes. */
  const madeBy = (3 << 8) | version
  const out: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const emit = (...chunks: Uint8Array[]) => {
    for (const chunk of chunks) {
      out.push(chunk)
      offset += chunk.byteLength
    }
  }

  for (const entry of entries) {
    const dir = entry.name.endsWith('/')
    const link = entry.symlink !== undefined
    const raw = link ? encoder.encode(entry.symlink) : (entry.data ?? new Uint8Array(0))
    const method = dir ? 0 : (entry.method ?? 8)
    const body = method === 8 ? deflateRawSync(raw) : raw
    const crc = crc32(raw)
    const name = encoder.encode(entry.name)
    const type = dir ? 0o040000 : link ? 0o120000 : 0o100000
    const perms = (entry.mode ?? (dir ? 0o755 : link ? 0o777 : 0o644)) & 0o7777
    // Unix mode in the high half; in the low byte only the MS-DOS "directory" attribute.
    const external = (((type | perms) << 16) | (dir ? 0x10 : 0)) >>> 0
    const localOffset = offset

    // The local ZIP64 field must carry both sizes; the central one only what is saturated.
    const localExtra = zip64 ? zip64Extra([raw.byteLength, body.byteLength]) : new Uint8Array(0)
    const local = record(30, (v) => {
      v.setUint32(0, 0x04034b50, true)
      v.setUint16(4, version, true)
      v.setUint16(6, UTF8_FLAG, true)
      v.setUint16(8, method, true)
      v.setUint16(10, DOS_TIME, true)
      v.setUint16(12, DOS_DATE, true)
      v.setUint32(14, crc, true)
      v.setUint32(18, zip64 ? MARK32 : body.byteLength, true)
      v.setUint32(22, zip64 ? MARK32 : raw.byteLength, true)
      v.setUint16(26, name.byteLength, true)
      v.setUint16(28, localExtra.byteLength, true)
    })
    emit(local, name, localExtra, body)

    const centralExtra = zip64
      ? zip64Extra([raw.byteLength, body.byteLength, localOffset])
      : new Uint8Array(0)
    const header = record(46, (v) => {
      v.setUint32(0, 0x02014b50, true)
      v.setUint16(4, madeBy, true)
      v.setUint16(6, version, true)
      v.setUint16(8, UTF8_FLAG, true)
      v.setUint16(10, method, true)
      v.setUint16(12, DOS_TIME, true)
      v.setUint16(14, DOS_DATE, true)
      v.setUint32(16, crc, true)
      v.setUint32(20, zip64 ? MARK32 : body.byteLength, true)
      v.setUint32(24, zip64 ? MARK32 : raw.byteLength, true)
      v.setUint16(28, name.byteLength, true)
      v.setUint16(30, centralExtra.byteLength, true)
      // 32 comment length, 34 disk number, 36 internal attributes: all zero.
      v.setUint32(38, external, true)
      v.setUint32(42, zip64 ? MARK32 : localOffset, true)
    })
    central.push(header, name, centralExtra)
  }

  const cdOffset = offset
  emit(...central)
  const cdSize = offset - cdOffset

  if (zip64) {
    const end64Offset = offset
    emit(
      record(56, (v) => {
        v.setUint32(0, 0x06064b50, true)
        v.setBigUint64(4, 44n, true) // size of the rest of this record
        v.setUint16(12, madeBy, true)
        v.setUint16(14, version, true)
        // 16 this disk, 20 the central directory's disk: both zero.
        v.setBigUint64(24, BigInt(entries.length), true)
        v.setBigUint64(32, BigInt(entries.length), true)
        v.setBigUint64(40, BigInt(cdSize), true)
        v.setBigUint64(48, BigInt(cdOffset), true)
      }),
      record(20, (v) => {
        v.setUint32(0, 0x07064b50, true)
        v.setBigUint64(8, BigInt(end64Offset), true)
        v.setUint32(16, 1, true) // total disks
      }),
    )
  }
  // With ZIP64 every field the 64-bit record covers is saturated, so a reader must use it.
  emit(
    record(22, (v) => {
      v.setUint32(0, 0x06054b50, true)
      v.setUint16(8, zip64 ? 0xffff : entries.length, true)
      v.setUint16(10, zip64 ? 0xffff : entries.length, true)
      v.setUint32(12, zip64 ? MARK32 : cdSize, true)
      v.setUint32(16, zip64 ? MARK32 : cdOffset, true)
    }),
  )
  await writeFile(path, Buffer.concat(out))
}
