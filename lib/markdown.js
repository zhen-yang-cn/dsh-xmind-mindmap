// Markdown <-> tree mapping: headings/lists/paragraphs into canonical nodes, degradation for unsupported blocks.

const UNSUPPORTED_MARKER = '该内容类型暂不支持 XMind 结构映射:'
const EMPTY_WARNING = '文件为空或只包含空白字符'
const MAX_DEPTH = 512

const KIND_TITLES = {
  code: '代码块',
  table: '表格',
  image: '图片',
  blockquote: '引用块',
}

/** `# ATX` heading; more than 6 hashes is tolerated for XMind-origin depth recovery. */
const HEADING_RE = /^ {0,3}(#{1,})\s+(.*)$/
/** Exactly one `#` at the start of the line: the document root candidate. */
const ROOT_HEADING_RE = /^ {0,3}#\s+(.*)$/
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const LIST_EMPTY_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const BLOCKQUOTE_RE = /^ {0,3}>/
const IMAGE_ONLY_RE = /^ {0,3}!\[[^\]]*\]\([^)]*\)\s*$/
const TABLE_DELIMITER_RE = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Collapse a single line to display text.
 * @param {string} text
 * @returns {string}
 */
function collapseWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * File-name stem used as the synthetic root title.
 * @param {unknown} fileName
 * @returns {string}
 */
function titleFromFileName(fileName) {
  if (!nonEmptyString(fileName)) return 'Untitled'
  const base = String(fileName)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.trim() || 'Untitled'
}

/**
 * Strip a trailing ATX closing sequence (`## Title ##`).
 * @param {string} text
 * @returns {string}
 */
function stripClosingHashes(text) {
  return text.replace(/\s+#+\s*$/, '').trim()
}

/**
 * If the text is exactly one Markdown link `[title](url)`, split it; otherwise keep it literal.
 * @param {string} text
 * @returns {{title: string, href?: string}}
 */
function extractLink(text) {
  const trimmed = String(text).trim()
  const match = /^\[([^\]]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)$/.exec(trimmed)
  if (match && match[2].trim() !== '') {
    return { title: match[1].trim() || 'Untitled', href: match[2].trim() }
  }
  return { title: trimmed || 'Untitled' }
}

/**
 * Normalize a paragraph's raw lines into stable text (trailing spaces dropped, outer blank lines removed).
 * @param {string[]} lines
 * @returns {string}
 */
function cleanParagraph(lines) {
  return lines
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .trim()
}

/**
 * Append one paragraph/block to a node's notes, separated by a blank line.
 * @param {object} node
 * @param {string} text
 */
function appendToNotes(node, text) {
  if (!text) return
  const existing = typeof node.notes === 'string' ? node.notes : ''
  node.notes = existing ? `${existing}\n\n${text}` : text
}

/**
 * @param {string[]} lines
 * @param {number} index
 * @returns {boolean} whether a new block starts at this line
 */
function isTableStart(lines, index) {
  const header = lines[index]
  if (typeof header !== 'string' || !header.includes('|')) return false
  const delimiter = lines[index + 1]
  if (typeof delimiter !== 'string' || !delimiter.includes('|')) return false
  return TABLE_DELIMITER_RE.test(delimiter)
}

/**
 * @param {string[]} lines
 * @param {number} index
 * @returns {boolean}
 */
function startsBlock(lines, index) {
  const line = lines[index]
  if (typeof line !== 'string' || line.trim() === '') return true
  if (HEADING_RE.test(line)) return true
  if (FENCE_RE.test(line)) return true
  if (LIST_RE.test(line) || LIST_EMPTY_RE.test(line)) return true
  if (BLOCKQUOTE_RE.test(line)) return true
  if (IMAGE_ONLY_RE.test(line)) return true
  if (isTableStart(lines, index)) return true
  return false
}

/**
 * @param {string} line
 * @param {string} fenceCharacter
 * @param {number} fenceLength
 * @returns {boolean}
 */
function isClosingFence(line, fenceCharacter, fenceLength) {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
  return Boolean(match) && match[1][0] === fenceCharacter && match[1].length >= fenceLength
}

/**
 * Parse Markdown into the canonical tree schema (CONTRACT section 3).
 * Never throws for malformed content; degradations append Chinese warnings.
 * @param {string} markdown
 * @param {{fileName?: string, warnings?: string[]}} [opts]
 * @returns {{root: object, warnings: string[]}}
 */
export function parseMarkdown(markdown, opts = {}) {
  const warnings = Array.isArray(opts.warnings) ? opts.warnings : []
  const source = typeof markdown === 'string' ? markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') : ''
  const lines = source.split('\n')

  let rootTitle = titleFromFileName(opts.fileName)
  let rootHref
  let rootLineIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROOT_HEADING_RE.exec(lines[index])
    if (!match) continue
    const parsed = extractLink(stripClosingHashes(match[1]))
    rootTitle = parsed.title
    rootHref = parsed.href
    rootLineIndex = index
    break
  }

  const root = { id: 'md-1', title: rootTitle, children: { attached: [] } }
  if (rootHref) root.href = rootHref

  if (source.trim() === '') {
    warnings.push(EMPTY_WARNING)
    return { root, warnings }
  }

  let nextId = 2
  /** @returns {string} */
  function allocateId() {
    const id = `md-${nextId}`
    nextId += 1
    return id
  }

  /**
   * @param {string} text
   * @returns {object}
   */
  function createNodeFromText(text) {
    const parsed = extractLink(text)
    const node = { id: allocateId(), title: parsed.title, children: { attached: [] } }
    if (parsed.href) node.href = parsed.href
    return node
  }

  let lastStructural = null
  let currentHeading = { node: root, depth: 1 }
  let headingStack = [{ level: 1, node: root, depth: 1 }]
  let listStack = []
  let indentUnit = null
  let indentWarned = false
  let sawSpaceIndent = false
  let sawTabIndent = false

  /**
   * @param {string} whitespace
   * @param {number} lineNumber
   */
  function noteIndentation(whitespace, lineNumber) {
    if (!whitespace) return
    if (whitespace.includes(' ')) sawSpaceIndent = true
    if (whitespace.includes('\t')) sawTabIndent = true
    if (indentUnit === null) indentUnit = whitespace.includes('\t') ? '\t' : '  '
    if (sawSpaceIndent && sawTabIndent && !indentWarned) {
      indentWarned = true
      warnings.push(`第 ${lineNumber} 行：列表缩进混用空格与 Tab，已按首次出现的缩进单位解析`)
    }
  }

  /**
   * @param {string} whitespace
   * @returns {number}
   */
  function indentationLevel(whitespace) {
    if (!whitespace) return 0
    if (indentUnit === '\t') {
      const tabs = (whitespace.match(/\t/g) || []).length
      const spaces = (whitespace.match(/ /g) || []).length
      return tabs + Math.floor(spaces / 2)
    }
    return Math.floor(whitespace.replace(/\t/g, '  ').length / 2)
  }

  /**
   * @param {string} kind
   * @param {string} raw
   * @param {number} lineNumber
   */
  function degrade(kind, raw, lineNumber) {
    const title = KIND_TITLES[kind] || kind
    if (lastStructural) {
      appendToNotes(lastStructural, `${UNSUPPORTED_MARKER}\n${raw}`)
    } else {
      const node = { id: allocateId(), title, children: { attached: [] }, notes: raw }
      root.children.attached.push(node)
    }
    warnings.push(`第 ${lineNumber} 行：暂不支持${title}，已降级为备注`)
  }

  /**
   * @param {string} hashes
   * @param {string} rawText
   */
  function handleHeading(hashes, rawText) {
    const level = hashes.length
    const node = createNodeFromText(stripClosingHashes(rawText))

    if (level === 1) {
      // A later level-1 heading is a child of the root, never the root itself.
      root.children.attached.push(node)
      headingStack = [
        { level: 1, node: root, depth: 1 },
        { level: 1, node, depth: 2 },
      ]
      currentHeading = { node, depth: 2 }
      listStack = []
      lastStructural = node
      return
    }

    while (headingStack.length > 1) {
      const top = headingStack[headingStack.length - 1]
      if (top.depth >= level || top.level >= level) headingStack.pop()
      else break
    }
    const parentEntry = headingStack[headingStack.length - 1]
    let depth
    if (level > 6) {
      const levelSix = [...headingStack].reverse().find((entry) => entry.level === 6)
      depth = levelSix ? Math.max(level, levelSix.depth + (level - 6)) : parentEntry.depth + 1
    } else {
      depth = Math.min(level, parentEntry.depth + 1)
    }
    depth = Math.min(depth, MAX_DEPTH)

    parentEntry.node.children.attached.push(node)
    headingStack.push({ level, node, depth })
    currentHeading = { node, depth }
    listStack = []
    lastStructural = node
  }

  /**
   * @param {RegExpExecArray} match
   * @param {number} lineNumber
   */
  function handleListItem(match, lineNumber) {
    const whitespace = match[1] || ''
    noteIndentation(whitespace, lineNumber)
    const indentLevel = indentationLevel(whitespace)
    while (listStack.length > 0 && listStack[listStack.length - 1].indentLevel >= indentLevel) {
      listStack.pop()
    }

    let parent
    let depth
    if (listStack.length > 0) {
      const top = listStack[listStack.length - 1]
      parent = top.node
      depth = top.depth + 1
    } else {
      parent = currentHeading.node
      depth = currentHeading.depth + 1
    }

    const node = createNodeFromText(match[3] || '')
    parent.children.attached.push(node)
    listStack.push({ node, indentLevel, depth: Math.min(depth, MAX_DEPTH) })
    lastStructural = node
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]

    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const character = fence[1][0]
      const length = fence[1].length
      let end = index + 1
      let closed = false
      while (end < lines.length) {
        if (isClosingFence(lines[end], character, length)) {
          closed = true
          break
        }
        end += 1
      }
      const stop = closed ? end + 1 : Math.min(end, lines.length)
      degrade('code', lines.slice(index, stop).join('\n'), index + 1)
      index = stop
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      if (index === rootLineIndex) {
        currentHeading = { node: root, depth: 1 }
        headingStack = [{ level: 1, node: root, depth: 1 }]
        listStack = []
        lastStructural = root
      } else {
        handleHeading(heading[1], heading[2])
      }
      index += 1
      continue
    }

    const listItem = LIST_RE.exec(line) || LIST_EMPTY_RE.exec(line)
    if (listItem) {
      handleListItem(listItem, index + 1)
      index += 1
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      let end = index + 1
      while (end < lines.length && BLOCKQUOTE_RE.test(lines[end])) end += 1
      degrade('blockquote', lines.slice(index, end).join('\n'), index + 1)
      index = end
      continue
    }

    if (IMAGE_ONLY_RE.test(line)) {
      let end = index + 1
      while (end < lines.length && IMAGE_ONLY_RE.test(lines[end])) end += 1
      degrade('image', lines.slice(index, end).join('\n'), index + 1)
      index = end
      continue
    }

    if (isTableStart(lines, index)) {
      let end = index + 2
      while (end < lines.length && lines[end].trim() !== '' && lines[end].includes('|')) end += 1
      degrade('table', lines.slice(index, end).join('\n'), index + 1)
      index = end
      continue
    }

    // Paragraph: consume until the next blank line or block starter.
    let end = index + 1
    while (end < lines.length && !startsBlock(lines, end)) end += 1
    const paragraphLines = lines.slice(index, end)
    const text = cleanParagraph(paragraphLines)
    if (text) {
      if (lastStructural) {
        appendToNotes(lastStructural, text)
      } else {
        const firstLine = collapseWhitespace(paragraphLines[0] || '')
        const title = Array.from(firstLine).slice(0, 80).join('') || 'Untitled'
        const node = { id: allocateId(), title, children: { attached: [] }, notes: text }
        root.children.attached.push(node)
      }
    }
    index = end
  }

  return { root, warnings }
}

/**
 * Serialize the canonical tree as normalized Markdown (CONTRACT section 3 reverse mapping).
 * Blocks are separated by exactly one blank line, output is LF-only and ends with one trailing newline.
 * @param {object} root
 * @returns {string}
 */
export function treeToMarkdown(root) {
  if (!isPlainObject(root)) throw new TypeError('treeToMarkdown 需要有效的根节点')

  /**
   * @param {unknown} title
   * @returns {string}
   */
  function formatTitle(title) {
    let text = typeof title === 'string' ? title.trim() : ''
    text = text.replace(/\r\n?|\n/g, ' ')
    return text || 'Untitled'
  }

  /**
   * @param {object} node
   * @returns {string}
   */
  function headingText(node) {
    let text = formatTitle(node.title)
    if (nonEmptyString(node.href)) text = `[${text}](${node.href.trim()})`
    if (Array.isArray(node.labels)) {
      for (const label of node.labels) {
        if (nonEmptyString(label)) text += ` #${label.trim()}`
      }
    }
    return text
  }

  /**
   * @param {string} notes
   * @returns {string}
   */
  function normalizeNotes(notes) {
    if (typeof notes !== 'string') return ''
    return notes
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/^\n+|\n+$/g, '')
  }

  /**
   * @param {object} node
   * @param {number} depth
   * @returns {string}
   */
  function buildNotes(node, depth) {
    let notes = normalizeNotes(node.notes)
    if (depth > 6) {
      const marker = `原始层级深度: ${depth}`
      if (!notes.startsWith(marker)) notes = notes ? `${marker}\n\n${notes}` : marker
    }
    return notes
  }

  const blocks = []
  const visited = new Set()

  /**
   * @param {object} node
   * @param {number} depth
   */
  function visit(node, depth) {
    if (depth > MAX_DEPTH || visited.has(node)) return
    visited.add(node)
    const hashCount = depth <= 6 ? Math.max(1, depth) : 6
    let block = `${'#'.repeat(hashCount)} ${headingText(node)}`
    const notes = buildNotes(node, depth)
    if (notes) block += `\n\n${notes}`
    blocks.push(block)

    const children = node.children && Array.isArray(node.children.attached) ? node.children.attached : []
    for (const child of children) {
      if (isPlainObject(child)) visit(child, depth + 1)
    }
  }

  visit(root, 1)
  return `${blocks.join('\n\n')}\n`
}

/** @see parseMarkdown */
export const parseMarkdownToTree = parseMarkdown
