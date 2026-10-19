// ZIP archive read/write (zero dependency) for .xmind workbook containers.
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const SIG_LOCAL_FILE = 0x04034b50
const SIG_CENTRAL_FILE = 0x02014b50
const SIG_END_OF_CENTRAL = 0x06054b50
const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22
const UTF8_FLAG = 0x0800
const DOS_TIME_MIDNIGHT = 0
const DOS_DATE_1980_01_01 = 0x0021 // 1980-01-01
const MAX_ENTRIES = 0xffff

/** Build the CRC-32 (ISO-HDLC) lookup table once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** @param {unknown} value @param {string} label @returns {Buffer} */
function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError(`${label} 必须是 Buffer 或 Uint8Array`)
}

/** @param {unknown} value @returns {Buffer} */
function entryDataToBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return asBuffer(value, 'ZIP 条目 data')
}

/**
 * Reject unsafe/ambiguous entry names so a malicious archive cannot smuggle
 * absolute or traversal paths into downstream readers.
 * @param {unknown} name
 * @returns {string}
 */
function validateEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('ZIP 条目名称必须是非空字符串')
  }
  if (name.includes('\u0000')) {
    throw new Error(`ZIP 条目名称非法（包含 NUL）: ${JSON.stringify(name)}`)
  }
  if (name.startsWith('/')) {
    throw new Error(`ZIP 条目名称非法（绝对路径）: ${name}`)
  }
  if (name.split('/').includes('..')) {
    throw new Error(`ZIP 条目名称非法（包含 ..）: ${name}`)
  }
  return name
}

/**
 * Compute the unsigned CRC-32 of a buffer.
 * @param {Buffer|Uint8Array} buffer
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(buffer) {
  const buf = asBuffer(buffer, 'crc32 输入')
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Find the End Of Central Directory record. The signature may also appear in a
 * trailing archive comment, so candidates are accepted only when the recorded
 * comment length places the end exactly at the end of the buffer.
 * @param {Buffer} buf
 * @returns {number} offset of the EOCD record
 */
function findEndOfCentralDirectory(buf) {
  if (buf.length < EOCD_SIZE) {
    throw new Error('ZIP 文件过短，不是有效的 .xmind 文件')
  }
  const firstPossible = buf.length - EOCD_SIZE
  const lastPossible = Math.max(0, buf.length - EOCD_SIZE - 0xffff)
  for (let offset = firstPossible; offset >= lastPossible; offset -= 1) {
    if (buf.readUInt32LE(offset) !== SIG_END_OF_CENTRAL) continue
    const commentLength = buf.readUInt16LE(offset + 20)
    if (offset + EOCD_SIZE + commentLength === buf.length) return offset
  }
  throw new Error('不是有效的 ZIP 文件：找不到中央目录结尾记录')
}

/**
 * Read a ZIP archive into a Map of entry name -> uncompressed data.
 * Supports stored (method 0) and deflate (method 8) entries; rejects ZIP64,
 * encrypted, split, truncated and CRC/size-mismatched archives with Chinese
 * error messages.
 * @param {Buffer|Uint8Array} buffer
 * @returns {Map<string, Buffer>}
 */
export function readZip(buffer) {
  const buf = asBuffer(buffer, 'readZip 输入')
  const eocd = findEndOfCentralDirectory(buf)

  const diskNumber = buf.readUInt16LE(eocd + 4)
  const centralDisk = buf.readUInt16LE(eocd + 6)
  const entriesOnDisk = buf.readUInt16LE(eocd + 8)
  const totalEntries = buf.readUInt16LE(eocd + 10)
  const centralSize = buf.readUInt32LE(eocd + 12)
  const centralOffset = buf.readUInt32LE(eocd + 16)

  if (
    entriesOnDisk === 0xffff ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('暂不支持 ZIP64 格式的 .xmind 文件')
  }
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new Error('不支持分卷 ZIP 文件')
  }
  if (entriesOnDisk !== totalEntries) {
    throw new Error('ZIP 中央目录条目数量不一致')
  }
  if (centralOffset + centralSize > buf.length) {
    throw new Error('ZIP 文件被截断：中央目录超出文件范围')
  }

  const entries = new Map()
  let cursor = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > buf.length) {
      throw new Error('ZIP 中央目录损坏：条目头超出文件范围')
    }
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL_FILE) {
      throw new Error('ZIP 中央目录损坏：条目签名错误')
    }

    const flags = buf.readUInt16LE(cursor + 8)
    const method = buf.readUInt16LE(cursor + 10)
    const expectedCrc = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLength = buf.readUInt16LE(cursor + 28)
    const extraLength = buf.readUInt16LE(cursor + 30)
    const commentLength = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)

    const nameStart = cursor + CENTRAL_HEADER_SIZE
    const nameEnd = nameStart + nameLength
    if (nameEnd > buf.length) {
      throw new Error('ZIP 中央目录损坏：条目名称超出文件范围')
    }
    const nameBytes = buf.subarray(nameStart, nameEnd)
    if (nameBytes.includes(0)) {
      throw new Error('ZIP 条目名称非法：包含 NUL')
    }
    let name
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    } catch {
      throw new Error('ZIP 条目名称不是有效的 UTF-8')
    }
    validateEntryName(name)

    if ((flags & 0x0001) !== 0) {
      throw new Error(`不支持加密的 ZIP 文件: ${name}`)
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`不支持的 ZIP 压缩方法 (${method}): ${name}`)
    }

    if (localOffset + LOCAL_HEADER_SIZE > buf.length) {
      throw new Error(`ZIP 本地文件头损坏: ${name}`)
    }
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL_FILE) {
      throw new Error(`ZIP 本地文件头签名错误: ${name}`)
    }
    const localMethod = buf.readUInt16LE(localOffset + 8)
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const localNameStart = localOffset + LOCAL_HEADER_SIZE
    const localNameEnd = localNameStart + localNameLength
    if (localNameEnd > buf.length) {
      throw new Error(`ZIP 本地文件头损坏：条目名称超出文件范围: ${name}`)
    }
    let localName
    try {
      localName = new TextDecoder('utf-8', { fatal: true }).decode(
        buf.subarray(localNameStart, localNameEnd),
      )
    } catch {
      throw new Error(`ZIP 本地文件头中的条目名称不是有效的 UTF-8: ${name}`)
    }
    if (localName !== name) {
      throw new Error(`ZIP 本地文件头与中央目录不一致: ${name} <-> ${localName}`)
    }
    if (localMethod !== method) {
      throw new Error(`ZIP 本地文件头压缩方法与中央目录不一致: ${name}`)
    }

    const dataStart = localNameEnd + localExtraLength
    if (dataStart > buf.length || compressedSize > buf.length - dataStart) {
      throw new Error(`ZIP 文件被截断：条目数据不完整: ${name}`)
    }
    const compressed = buf.subarray(dataStart, dataStart + compressedSize)

    let data
    if (method === 0) {
      data = Buffer.from(compressed)
    } else {
      try {
        data = inflateRawSync(compressed, {
          maxOutputLength: Math.max(uncompressedSize, 1),
        })
      } catch {
        throw new Error(`ZIP 条目解压失败: ${name}`)
      }
    }

    if (data.length !== uncompressedSize) {
      throw new Error(
        `ZIP 条目大小校验失败: ${name}（期望 ${uncompressedSize}，实际 ${data.length}）`,
      )
    }
    if (crc32(data) !== expectedCrc) {
      throw new Error(`ZIP 条目 CRC 校验失败: ${name}`)
    }

    entries.set(name, data)
    cursor = nameEnd + extraLength + commentLength
  }

  return entries
}

/**
 * Write a deterministic ZIP archive.
 * Contract: `entries[0]` must be `mimetype` and is always stored (method 0,
 * uncompressed, first in the archive); every other entry is deflated (method 8)
 * unless it explicitly asks for `store: true`. All DOS timestamps are fixed to
 * 1980-01-01 00:00 so equal inputs always produce byte-identical archives.
 * @param {Array<{ name: string, data: Buffer|Uint8Array|string, store?: boolean }>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('ZIP 条目列表必须是非空数组')
  }
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP 条目数量超出上限 (${MAX_ENTRIES})`)
  }
  if (!entries[0] || entries[0].name !== 'mimetype') {
    throw new Error('ZIP 写入约定：第一个条目必须是 mimetype')
  }

  const names = new Set()
  const prepared = entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError(`ZIP 条目 #${index} 必须是对象`)
    }
    const name = validateEntryName(entry.name)
    if (names.has(name)) {
      throw new Error(`ZIP 条目名称重复: ${name}`)
    }
    names.add(name)
    const data = entryDataToBuffer(entry.data)
    if (data.length > 0xffffffff) {
      throw new Error(`ZIP 条目过大: ${name}`)
    }
    const store = name === 'mimetype' ? true : entry.store === true
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = store ? data : deflateRawSync(data)
    return {
      name,
      nameBytes,
      data,
      compressed,
      method: store ? 0 : 8,
      crc: crc32(data),
    }
  })

  const chunks = []
  const centralChunks = []
  let offset = 0

  for (const item of prepared) {
    const header = Buffer.alloc(LOCAL_HEADER_SIZE)
    header.writeUInt32LE(SIG_LOCAL_FILE, 0)
    header.writeUInt16LE(item.method === 8 ? 20 : 10, 4)
    header.writeUInt16LE(UTF8_FLAG, 6)
    header.writeUInt16LE(item.method, 8)
    header.writeUInt16LE(DOS_TIME_MIDNIGHT, 10)
    header.writeUInt16LE(DOS_DATE_1980_01_01, 12)
    header.writeUInt32LE(item.crc, 14)
    header.writeUInt32LE(item.compressed.length, 18)
    header.writeUInt32LE(item.data.length, 22)
    header.writeUInt16LE(item.nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, item.nameBytes, item.compressed)

    const central = Buffer.alloc(CENTRAL_HEADER_SIZE)
    central.writeUInt32LE(SIG_CENTRAL_FILE, 0)
    central.writeUInt16LE(20, 4) // version made by: MS-DOS, 2.0
    central.writeUInt16LE(item.method === 8 ? 20 : 10, 6)
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(item.method, 10)
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12)
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14)
    central.writeUInt32LE(item.crc, 16)
    central.writeUInt32LE(item.compressed.length, 20)
    central.writeUInt32LE(item.data.length, 24)
    central.writeUInt16LE(item.nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, item.nameBytes)

    offset += LOCAL_HEADER_SIZE + item.nameBytes.length + item.compressed.length
  }

  const centralDirectory = Buffer.concat(centralChunks)
  const end = Buffer.alloc(EOCD_SIZE)
  end.writeUInt32LE(SIG_END_OF_CENTRAL, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(prepared.length, 8)
  end.writeUInt16LE(prepared.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralDirectory, end])
}
