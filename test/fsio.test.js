/** Tests for path validation and abort-aware, baseline-guarded filesystem I/O. */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertBaseline,
  readBaseline,
  readBuffer,
  readUtf8,
  resolveAbsolute,
  sha256,
  throwIfAborted,
  writeGuarded,
  writeIfAbsentOrSame,
} from '../lib/fsio.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = join(TEST_DIR, '.tmp', 'fsio')
let caseSequence = 0

/** Create one isolated directory for a single test case. */
async function tempDir() {
  caseSequence += 1
  const dir = join(TMP_ROOT, `case-${caseSequence}`)
  await mkdir(dir, { recursive: true })
  return dir
}

after(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
})

test('resolveAbsolute accepts absolute paths and normalizes them', () => {
  const xmind = join(TMP_ROOT, 'one.xmind')
  assert.equal(resolveAbsolute(xmind, { ext: ['.xmind'], kind: 'file', label: 'xmindPath' }), xmind)
  assert.equal(resolveAbsolute(join(TMP_ROOT, 'upper.XMIND'), { ext: ['.xmind'], kind: 'file' }), join(TMP_ROOT, 'upper.XMIND'))
  assert.equal(resolveAbsolute(join(TMP_ROOT, 'dir'), { kind: 'dir' }), join(TMP_ROOT, 'dir'))
})

test('resolveAbsolute rejects invalid inputs with Chinese messages', () => {
  const opts = { ext: ['.xmind'], kind: 'file', label: 'xmindPath' }
  assert.throws(() => resolveAbsolute(null, opts), { name: 'TypeError', message: '路径必须是字符串' })
  assert.throws(() => resolveAbsolute(42, opts), { name: 'TypeError', message: '路径必须是字符串' })
  assert.throws(() => resolveAbsolute('', opts), { name: 'TypeError', message: '路径不能为空' })
  assert.throws(() => resolveAbsolute('   ', opts), { name: 'TypeError', message: '路径不能为空' })
  assert.throws(() => resolveAbsolute('relative/one.xmind', opts), {
    name: 'TypeError',
    message: `xmindPath必须是绝对路径: relative/one.xmind`,
  })
  assert.throws(() => resolveAbsolute(`${TMP_ROOT}\\..\\escape.xmind`, opts), /不能包含 '\.\.' 路径片段/)
  assert.throws(() => resolveAbsolute(join(TMP_ROOT, 'note.md'), opts), { name: 'TypeError', message: `xmindPath扩展名必须是 .xmind: ${join(TMP_ROOT, 'note.md')}` })
  assert.throws(() => resolveAbsolute(`${TMP_ROOT}\\nul\0.xmind`, opts), /包含非法字符/)
  assert.throws(() => resolveAbsolute(`${TMP_ROOT}\\dir\\`, { kind: 'file', ext: ['.xmind'] }), /扩展名必须是 \.xmind/)
})

test('readBuffer/readUtf8/readBaseline expose the file bytes and hashes', async () => {
  const dir = await tempDir()
  const file = join(dir, 'note.txt')
  await writeFile(file, 'hello 世界', 'utf8')

  const buffer = await readBuffer(file)
  assert.equal(buffer.toString('utf8'), 'hello 世界')
  assert.equal(await readUtf8(file), 'hello 世界')

  const baseline = await readBaseline(file)
  assert.equal(baseline.size, Buffer.byteLength('hello 世界', 'utf8'))
  assert.equal(baseline.sha256, sha256('hello 世界'))
  assert.match(baseline.sha256, /^[0-9a-f]{64}$/)
  assert.equal(typeof baseline.mtimeMs, 'number')
})

test('assertBaseline passes unchanged files and rejects changed or missing ones', async () => {
  const dir = await tempDir()
  const file = join(dir, 'guarded.txt')
  await writeFile(file, 'v1', 'utf8')
  const baseline = await readBaseline(file)

  await assertBaseline(file, baseline)

  await writeFile(file, 'v2', 'utf8')
  await assert.rejects(assertBaseline(file, baseline), {
    message: `目标文件在读取后已被修改，已拒绝覆盖: ${file}`,
  })

  await rm(file)
  await assert.rejects(assertBaseline(file, baseline), /目标文件在读取后已被修改，已拒绝覆盖/)

  await writeFile(file, 'v1', 'utf8')
  await assert.rejects(assertBaseline(file, null), /写入基线无效/)
})

test('writeIfAbsentOrSame creates, accepts identical content, rejects different content', async () => {
  const dir = await tempDir()
  const file = join(dir, 'out.xmind')

  assert.deepEqual(await writeIfAbsentOrSame(file, 'data-1'), { written: true, existed: false })
  assert.equal(await readUtf8(file), 'data-1')

  assert.deepEqual(await writeIfAbsentOrSame(file, Buffer.from('data-1', 'utf8')), { written: false, existed: true })
  assert.equal(await readUtf8(file), 'data-1')

  await assert.rejects(writeIfAbsentOrSame(file, 'data-2'), {
    message: `目标文件已存在且内容不同，已拒绝覆盖: ${file}`,
  })
  assert.equal(await readUtf8(file), 'data-1')
  assert.deepEqual(await readdir(dir), ['out.xmind'])
})

test('writeIfAbsentOrSame reports a missing parent directory without leaving temp files', async () => {
  const dir = await tempDir()
  const file = join(dir, 'missing-dir', 'out.md')
  await assert.rejects(writeIfAbsentOrSame(file, 'x'))
  assert.deepEqual(await readdir(dir), [])
})

test('writeGuarded writes atomically only when the baseline still matches', async () => {
  const dir = await tempDir()
  const file = join(dir, 'edit.md')
  await writeFile(file, '# Old', 'utf8')
  const baseline = await readBaseline(file)

  assert.deepEqual(await writeGuarded(file, '# New', baseline), { written: true, existed: true })
  assert.equal(await readUtf8(file), '# New')
  assert.deepEqual(await readdir(dir), ['edit.md'])

  await assert.rejects(writeGuarded(file, '# Other', baseline), {
    message: `目标文件在读取后已被修改，已拒绝覆盖: ${file}`,
  })
  assert.equal(await readUtf8(file), '# New')
  assert.deepEqual(await readdir(dir), ['edit.md'])

  const fresh = await readBaseline(file)
  await assert.rejects(writeGuarded(file, 'x', null), /缺少写入基线/)
  await assert.rejects(writeGuarded(file, 42, fresh), /写入内容必须是字符串或 Buffer/)
})

test('readBuffer and write helpers reject an already aborted signal', async () => {
  const dir = await tempDir()
  const file = join(dir, 'abort.md')
  await writeFile(file, 'a', 'utf8')
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(readBuffer(file, controller.signal), error => error.name === 'AbortError')
  await assert.rejects(readBaseline(file, controller.signal), error => error.name === 'AbortError')
  await assert.rejects(writeIfAbsentOrSame(join(dir, 'new.md'), 'x', controller.signal), error => error.name === 'AbortError')
  await assert.rejects(writeGuarded(file, 'x', { sha256: sha256('a'), size: 1 }, controller.signal), error => error.name === 'AbortError')
})

test('sha256 matches the standard vector and accepts Buffers', () => {
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  assert.equal(sha256('abc'), expected)
  assert.equal(sha256(Buffer.from('abc', 'utf8')), expected)
  assert.throws(() => sha256(42), /写入内容必须是字符串或 Buffer/)
})

test('throwIfAborted honors native, reasoned, and plain abort signals', () => {
  throwIfAborted(undefined)
  throwIfAborted(null)
  throwIfAborted({ aborted: false })

  const controller = new AbortController()
  throwIfAborted(controller.signal)
  controller.abort()
  assert.throws(() => throwIfAborted(controller.signal), error => error.name === 'AbortError')

  const reason = new Error('stop now')
  const reasoned = new AbortController()
  reasoned.abort(reason)
  assert.throws(() => throwIfAborted(reasoned.signal), error => error === reason)

  assert.throws(() => throwIfAborted({ aborted: true, reason: '自定义取消' }), /自定义取消/)
  const plainReason = new Error('plain reason')
  assert.throws(() => throwIfAborted({ aborted: true, reason: plainReason }), error => error === plainReason)
  assert.throws(() => throwIfAborted({ aborted: true }), error => error.name === 'AbortError')
})

test('readBaseline reports a missing file with ENOENT', async () => {
  const missing = join(TMP_ROOT, 'no-such-dir', 'x.xmind')
  await assert.rejects(readBaseline(missing), error => error.code === 'ENOENT')
})

test('the same content written from string and Buffer compares equal', async () => {
  const dir = await tempDir()
  const file = join(dir, 'same.md')
  await writeIfAbsentOrSame(file, '内容')
  const bytes = await readFile(file)
  assert.deepEqual(await writeIfAbsentOrSame(file, bytes), { written: false, existed: true })
})
