/** Path validation plus abort-aware, baseline-guarded filesystem I/O for the mindmap host tools. */
import { createHash } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path'

const DEFAULT_LABEL = '路径'
let tempSequence = 0

/**
 * Normalize one user/model supplied path without touching the filesystem.
 * Rejects non-strings, empty strings, relative paths, raw `..` segments and
 * (for files) any extension outside `opts.ext`, always with a Chinese message.
 * @param {unknown} input candidate path.
 * @param {{ ext?: string[], kind?: 'file'|'dir', label?: string }} [opts] validation options.
 * @returns {string} normalized absolute path.
 */
export function resolveAbsolute(input, opts = {}) {
  const { ext, kind = 'file', label = DEFAULT_LABEL } = opts
  if (typeof input !== 'string') throw new TypeError('路径必须是字符串')
  if (input.trim() === '') throw new TypeError('路径不能为空')
  if (input.includes('\0')) throw new TypeError(`${label}包含非法字符`)
  if (!isAbsolute(input)) throw new TypeError(`${label}必须是绝对路径: ${input}`)
  const segments = input.split(/[\\/]+/)
  if (segments.includes('..')) throw new TypeError(`${label}不能包含 '..' 路径片段: ${input}`)
  if (kind === 'file' && Array.isArray(ext) && ext.length > 0) {
    const actual = extname(input).toLowerCase()
    const allowed = ext.map(item => String(item).toLowerCase())
    if (!allowed.includes(actual)) {
      throw new TypeError(`${label}扩展名必须是 ${allowed.join(' 或 ')}: ${input}`)
    }
  }
  return normalize(input)
}

/** Throw the signal's abort reason (Chinese fallback message) when it is already aborted. */
export function throwIfAborted(signal) {
  if (!signal || typeof signal.aborted !== 'boolean' || !signal.aborted) return
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted()
    return
  }
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error(typeof reason === 'string' && reason !== '' ? reason : '操作已取消')
  error.name = 'AbortError'
  throw error
}

/** Coerce supported write payloads to a Buffer for hashing/comparison. */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  throw new TypeError('写入内容必须是字符串或 Buffer')
}

/** SHA-256 hex digest of a string or Buffer. */
export function sha256(data) {
  return createHash('sha256').update(toBuffer(data)).digest('hex')
}

/**
 * Read a file as a Buffer. Checks the abort signal before and after the read.
 * @param {string} filePath absolute path.
 * @param {AbortSignal} [signal] cooperative abort signal.
 * @returns {Promise<Buffer>} file contents.
 */
export async function readBuffer(filePath, signal) {
  throwIfAborted(signal)
  const data = await readFile(filePath, signal ? { signal } : undefined)
  throwIfAborted(signal)
  return data
}

/**
 * Read a UTF-8 text file. Checks the abort signal before and after the read.
 * @param {string} filePath absolute path.
 * @param {AbortSignal} [signal] cooperative abort signal.
 * @returns {Promise<string>} decoded text.
 */
export async function readUtf8(filePath, signal) {
  return (await readBuffer(filePath, signal)).toString('utf8')
}

/**
 * Capture the read-baseline used to detect concurrent modification before a write.
 * @param {string} filePath absolute path.
 * @param {AbortSignal} [signal] cooperative abort signal.
 * @returns {Promise<{ sha256: string, size: number, mtimeMs: number }>} baseline facts.
 */
export async function readBaseline(filePath, signal) {
  throwIfAborted(signal)
  const [data, stats] = await Promise.all([
    readFile(filePath, signal ? { signal } : undefined),
    stat(filePath),
  ])
  throwIfAborted(signal)
  return { sha256: sha256(data), size: data.length, mtimeMs: stats.mtimeMs }
}

/**
 * Fail with the standard Chinese message when the file is missing or its content
 * no longer matches the baseline captured earlier.
 * @param {string} filePath absolute path.
 * @param {{ sha256: string, size?: number }} baseline baseline captured by readBaseline.
 * @param {AbortSignal} [signal] cooperative abort signal.
 * @returns {Promise<void>} resolves only when the file is unchanged.
 */
export async function assertBaseline(filePath, baseline, signal) {
  throwIfAborted(signal)
  if (!baseline || typeof baseline.sha256 !== 'string') {
    throw new TypeError('写入基线无效，已拒绝覆盖: ' + filePath)
  }
  let current = null
  try {
    current = await readBaseline(filePath, signal)
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  throwIfAborted(signal)
  const unchanged = current !== null
    && current.sha256 === baseline.sha256
    && current.size === baseline.size
  if (!unchanged) throw new Error(`目标文件在读取后已被修改，已拒绝覆盖: ${filePath}`)
}

/** Write through a temp file in the target directory, then rename into place. */
async function writeAtomic(filePath, data, signal) {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${(tempSequence += 1)}.tmp`)
  try {
    throwIfAborted(signal)
    await writeFile(tempPath, data, signal ? { signal } : undefined)
    throwIfAborted(signal)
    await rename(tempPath, filePath)
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {
      // Best-effort cleanup only: the original error is what matters.
    }
    throw error
  }
}

/**
 * Write a new file, but never silently overwrite a different existing file.
 * Identical content is treated as success without rewriting.
 * @param {string} filePath absolute path.
 * @param {string|Buffer} data content to write.
 * @param {AbortSignal} [signal] cooperative abort signal.
 * @returns {Promise<{ written: boolean, existed: boolean }>} write outcome.
 */
export async function writeIfAbsentOrSame(filePath, data, signal) {
  throwIfAborted(signal)
  const buffer = toBuffer(data)
  let existing = null
  try {
    existing = await readFile(filePath, signal ? { signal } : undefined)
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  throwIfAborted(signal)
  if (existing !== null) {
    if (existing.length === buffer.length && existing.equals(buffer)) {
      return { written: false, existed: true }
    }
    throw new Error(`目标文件已存在且内容不同，已拒绝覆盖: ${filePath}`)
  }
  await writeAtomic(filePath, buffer, signal)
  throwIfAborted(signal)
  return { written: true, existed: false }
}

/**
 * Write only when the target still matches the read-baseline captured before
 * loading it (read-before-write guard), using temp file + rename.
 * @param {string} filePath absolute path.
 * @param {string|Buffer} data content to write.
 * @param {{ sha256: string, size?: number }} baseline baseline captured by readBaseline.
 * @param {AbortSignal} [signal] cooperative abort signal.
 * @returns {Promise<{ written: boolean, existed: boolean }>} write outcome.
 */
export async function writeGuarded(filePath, data, baseline, signal) {
  throwIfAborted(signal)
  if (!baseline || typeof baseline.sha256 !== 'string') {
    throw new TypeError('缺少写入基线，已拒绝覆盖: ' + filePath)
  }
  await assertBaseline(filePath, baseline, signal)
  throwIfAborted(signal)
  await writeAtomic(filePath, toBuffer(data), signal)
  throwIfAborted(signal)
  return { written: true, existed: true }
}
