// Contract tests for lib/zip.js (ZIP read/write, CRC-32, error handling).
import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32, readZip, writeZip } from '../lib/zip.js'

const MIMETYPE = 'application/vnd.xmind.workbook'

function sampleEntries() {
  return [
    { name: 'mimetype', data: Buffer.from(MIMETYPE, 'utf8'), store: true },
    { name: 'content.json', data: Buffer.from('{"title":"世界"}', 'utf8') },
    { name: 'content.xml', data: Buffer.from('<xmap-content/>', 'utf8') },
  ]
}

function readCentralDirectory(buffer) {
  const eocd = buffer.length - 22
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50)
  const count = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  let pos = cdOffset
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(pos), 0x02014b50)
    const nameLength = buffer.readUInt16LE(pos + 28)
    const extraLength = buffer.readUInt16LE(pos + 30)
    const commentLength = buffer.readUInt16LE(pos + 32)
    entries.push({
      name: buffer.subarray(pos + 46, pos + 46 + nameLength).toString('utf8'),
      flags: buffer.readUInt16LE(pos + 8),
      method: buffer.readUInt16LE(pos + 10),
      crc: buffer.readUInt32LE(pos + 16),
      compressedSize: buffer.readUInt32LE(pos + 20),
      uncompressedSize: buffer.readUInt32LE(pos + 24),
      localOffset: buffer.readUInt32LE(pos + 42),
      headerOffset: pos,
    })
    pos += 46 + nameLength + extraLength + commentLength
  }
  return { entries, cdOffset, eocd }
}

test('crc32 matches the standard check vectors and is unsigned', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0)
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926)
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339)
  const asBytes = crc32(new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]))
  assert.equal(asBytes, 0xcbf43926)
  assert.ok(crc32(Buffer.from('x')) >= 0)
  assert.throws(() => crc32('123456789'), /Buffer/)
})

test('writeZip -> readZip round-trips entries, names and order', () => {
  const buffer = writeZip(sampleEntries())
  const map = readZip(buffer)
  assert.deepEqual([...map.keys()], ['mimetype', 'content.json', 'content.xml'])
  assert.equal(map.get('mimetype').toString('utf8'), MIMETYPE)
  assert.equal(map.get('content.json').toString('utf8'), '{"title":"世界"}')
  assert.equal(map.get('content.xml').toString('utf8'), '<xmap-content/>')
  for (const value of map.values()) assert.ok(Buffer.isBuffer(value))
})

test('mimetype is the first entry, stored, with the fixed 1980-01-01 timestamp', () => {
  const buffer = writeZip(sampleEntries())
  const { entries } = readCentralDirectory(buffer)

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['mimetype', 'content.json', 'content.xml'],
  )
  assert.equal(entries[0].method, 0)
  assert.equal(entries[0].compressedSize, Buffer.byteLength(MIMETYPE))
  assert.equal(entries[0].uncompressedSize, Buffer.byteLength(MIMETYPE))
  assert.equal(entries[1].method, 8)
  assert.equal(entries[2].method, 8)

  // Local header of the first entry.
  assert.equal(buffer.readUInt32LE(0), 0x04034b50)
  assert.equal(buffer.readUInt16LE(8), 0) // method 0
  assert.equal(buffer.readUInt16LE(10), 0) // DOS time 00:00:00
  assert.equal(buffer.readUInt16LE(12), 0x0021) // DOS date 1980-01-01
  assert.equal(buffer.subarray(30, 38).toString('utf8'), 'mimetype')
  assert.equal(buffer.subarray(38, 38 + MIMETYPE.length).toString('utf8'), MIMETYPE)
})

test('writeZip is deterministic for the same input', () => {
  const first = writeZip(sampleEntries())
  const second = writeZip(sampleEntries())
  assert.deepEqual(first, second)
})

test('writeZip supports stored entries, empty payloads, strings and UTF-8 names', () => {
  const buffer = writeZip([
    { name: 'mimetype', data: MIMETYPE, store: false }, // forced to store
    { name: '目录/文件.txt', data: '你好，世界', store: true },
    { name: 'empty.bin', data: Buffer.alloc(0) },
    { name: 'binary.bin', data: new Uint8Array([0, 1, 2, 3, 255]) },
  ])
  const map = readZip(buffer)
  assert.deepEqual([...map.keys()], [
    'mimetype',
    '目录/文件.txt',
    'empty.bin',
    'binary.bin',
  ])
  assert.equal(map.get('目录/文件.txt').toString('utf8'), '你好，世界')
  assert.equal(map.get('empty.bin').length, 0)
  assert.deepEqual([...map.get('binary.bin')], [0, 1, 2, 3, 255])

  const { entries } = readCentralDirectory(buffer)
  assert.equal(entries[0].method, 0)
  assert.equal(entries[1].method, 0) // explicit store
  assert.equal(entries[3].method, 8)
  for (const entry of entries) {
    assert.equal(crc32(readZip(buffer).get(entry.name)), entry.crc)
  }
})

test('writeZip rejects malformed entry lists with Chinese errors', () => {
  assert.throws(() => writeZip([]), /非空数组/)
  assert.throws(() => writeZip('nope'), /非空数组/)
  assert.throws(
    () => writeZip([{ name: 'content.json', data: Buffer.from('x') }]),
    /mimetype/,
  )
  assert.throws(
    () =>
      writeZip([
        { name: 'mimetype', data: MIMETYPE },
        { name: 'a.txt', data: '1' },
        { name: 'a.txt', data: '2' },
      ]),
    /重复/,
  )
  assert.throws(
    () => writeZip([{ name: 'mimetype', data: MIMETYPE }, { name: '', data: 'x' }]),
    /非空字符串/,
  )
  assert.throws(
    () => writeZip([{ name: 'mimetype', data: MIMETYPE }, { name: '../evil', data: 'x' }]),
    /非法/,
  )
  assert.throws(
    () => writeZip([{ name: 'mimetype', data: MIMETYPE }, { name: 'a.txt', data: 7 }]),
    /Buffer/,
  )
})

test('readZip rejects empty, short, non-ZIP and truncated buffers', () => {
  assert.throws(() => readZip(Buffer.alloc(0)), /过短/)
  assert.throws(() => readZip(Buffer.alloc(21, 0)), /过短/)
  assert.throws(() => readZip(Buffer.alloc(64, 0x41)), /中央目录结尾/)
  assert.throws(() => readZip('not a buffer'), /Buffer/)
  const valid = writeZip(sampleEntries())
  assert.throws(() => readZip(valid.subarray(0, 24)), /过短|中央目录结尾/)
  assert.throws(() => readZip(valid.subarray(0, valid.length - 3)), /中央目录结尾/)
  assert.throws(() => readZip(Buffer.concat([valid, Buffer.from('garbage')])), /中央目录结尾/)
})

test('readZip validates CRC, sizes and data bounds', () => {
  const corruptedCrc = writeZip(sampleEntries())
  const central = readCentralDirectory(corruptedCrc)
  const jsonEntry = central.entries.find((entry) => entry.name === 'content.json')
  corruptedCrc.writeUInt32LE((jsonEntry.crc ^ 0xffff) >>> 0, jsonEntry.headerOffset + 16)
  assert.throws(() => readZip(corruptedCrc), /CRC/)

  const corruptedSize = writeZip(sampleEntries())
  const sizeCentral = readCentralDirectory(corruptedSize)
  const sizeEntry = sizeCentral.entries.find((entry) => entry.name === 'content.json')
  corruptedSize.writeUInt32LE(sizeEntry.uncompressedSize + 1, sizeEntry.headerOffset + 24)
  assert.throws(() => readZip(corruptedSize), /大小校验/)

  const truncatedData = writeZip(sampleEntries())
  const dataCentral = readCentralDirectory(truncatedData)
  const dataEntry = dataCentral.entries.find((entry) => entry.name === 'content.json')
  truncatedData.writeUInt32LE(0xfffffff, dataEntry.headerOffset + 20)
  assert.throws(() => readZip(truncatedData), /截断/)
})

test('readZip rejects unsupported methods, encryption and ZIP64', () => {
  const unsupported = writeZip(sampleEntries())
  const methodCentral = readCentralDirectory(unsupported)
  unsupported.writeUInt16LE(99, methodCentral.entries[0].headerOffset + 10)
  assert.throws(() => readZip(unsupported), /不支持的 ZIP 压缩方法/)

  const encrypted = writeZip(sampleEntries())
  const encryptedCentral = readCentralDirectory(encrypted)
  encrypted.writeUInt16LE(0x0001, encryptedCentral.entries[1].headerOffset + 8)
  assert.throws(() => readZip(encrypted), /加密/)

  const zip64 = writeZip(sampleEntries())
  const zip64Central = readCentralDirectory(zip64)
  zip64.writeUInt16LE(0xffff, zip64Central.eocd + 8)
  zip64.writeUInt16LE(0xffff, zip64Central.eocd + 10)
  assert.throws(() => readZip(zip64), /ZIP64/)

  const zip64Offset = writeZip(sampleEntries())
  const offsetCentral = readCentralDirectory(zip64Offset)
  zip64Offset.writeUInt32LE(0xffffffff, offsetCentral.eocd + 16)
  assert.throws(() => readZip(zip64Offset), /ZIP64/)
})

test('readZip rejects local headers that disagree with the central directory', () => {
  const badSignature = writeZip(sampleEntries())
  const signatureCentral = readCentralDirectory(badSignature)
  badSignature.writeUInt32LE(0xdeadbeef, signatureCentral.entries[1].localOffset)
  assert.throws(() => readZip(badSignature), /本地文件头签名/)

  const badName = writeZip(sampleEntries())
  const nameCentral = readCentralDirectory(badName)
  const nameEntry = nameCentral.entries.find((entry) => entry.name === 'content.json')
  badName[nameEntry.localOffset + 30] = 'x'.charCodeAt(0)
  assert.throws(() => readZip(badName), /本地文件头与中央目录不一致/)

  const badMethod = writeZip(sampleEntries())
  const methodCentral = readCentralDirectory(badMethod)
  const methodEntry = methodCentral.entries.find((entry) => entry.name === 'content.json')
  badMethod.writeUInt16LE(0, methodEntry.localOffset + 8)
  assert.throws(() => readZip(badMethod), /压缩方法与中央目录不一致/)

  const badUtf8 = writeZip(sampleEntries())
  const utf8Central = readCentralDirectory(badUtf8)
  const utf8Entry = utf8Central.entries.find((entry) => entry.name === 'content.json')
  badUtf8[utf8Entry.localOffset + 30] = 0xff
  badUtf8[utf8Entry.headerOffset + 46] = 0xff
  assert.throws(() => readZip(badUtf8), /UTF-8/)
})
