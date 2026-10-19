// XMind 2020 content.json / XMind 8 content.xml read and write over ZIP.
import { readZip, writeZip } from './zip.js'
import { parseXml, findChild, findChildren, textOf, childrenOf } from './xml.js'

const MIMETYPE_VALUE = 'application/vnd.xmind.workbook'
const MAX_DEPTH = 512

/** Fields understood on an XMind 2020 topic; anything else is dropped with a warning. */
const KNOWN_TOPIC_KEYS = new Set([
  'id',
  'class',
  'title',
  'children',
  'notes',
  'href',
  'labels',
  'image',
  'attachment',
  'attachments',
  'summaries',
  'summary',
  'structureClass',
  'style',
  'markers',
  'markerRefs',
  'extensions',
  'customWidth',
  'customHeight',
  'width',
  'height',
  'position',
  'branch',
  'collapsed',
  'numbering',
  'attributes',
  'theme',
  'topicPositioning',
  'titleUnedited',
  'rootTopic',
])

/** Canonical TreeNode fields understood by buildXmindBuffer. */
const CANONICAL_NODE_KEYS = new Set(['id', 'title', 'children', 'notes', 'href', 'labels'])

/** Element names understood under an XMind 8 <topic>; anything else warns. */
const KNOWN_XML_TOPIC_CHILDREN = new Set([
  'title',
  'notes',
  'href',
  'labels',
  'children',
  'marker-refs',
  'extensions',
  'style',
  'position',
  'summary',
  'summaries',
  'image',
  'attachment',
  'attachments',
  'numbering',
  'attributes',
  'theme',
  'branch',
  'custom-width',
  'custom-height',
  'width',
  'height',
])

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {string} text @returns {string} */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Push a warning once (identical messages are de-duplicated). */
function pushWarning(warnings, message) {
  if (!warnings.includes(message)) warnings.push(message)
}

/** True when a raw XMind field carries any meaningful content. */
function hasContent(value) {
  if (value === undefined || value === null || value === false) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return true
}

/** @returns {{ warnings: string[], usedIds: Set<string>, counter: number, seen: WeakSet<object> }} */
function createContext(warnings) {
  return { warnings, usedIds: new Set(), counter: 0, seen: new WeakSet() }
}

/** Allocate a stable, collision-free node id (preserving valid raw ids). */
function allocateId(ctx, rawId) {
  if (typeof rawId === 'string') {
    const id = rawId.trim()
    if (id && !ctx.usedIds.has(id)) {
      ctx.usedIds.add(id)
      return id
    }
  }
  let candidate
  do {
    ctx.counter += 1
    candidate = `n-${ctx.counter}`
  } while (ctx.usedIds.has(candidate))
  ctx.usedIds.add(candidate)
  pushWarning(ctx.warnings, '存在缺少或重复 id 的节点，已生成稳定 id')
  return candidate
}

/* ------------------------------------------------------------------ */
/* Shared value readers (canonical TreeNode and XMind 2020 topic fields) */
/* ------------------------------------------------------------------ */

function readTitleValue(raw, ctx) {
  if (typeof raw.title === 'string') {
    const title = raw.title.trim()
    if (title) return title
  }
  pushWarning(ctx.warnings, '存在缺少标题的节点，已使用 "Untitled"')
  return 'Untitled'
}

/** Accepts `notes` as string, `notes.plain.content`, `notes.plain` or `notes.content`. */
function readNotesValue(raw, ctx) {
  const notes = raw.notes
  if (notes === undefined || notes === null) return undefined
  let text
  if (typeof notes === 'string') {
    text = notes
  } else if (isPlainObject(notes)) {
    if (typeof notes.plain === 'string') text = notes.plain
    else if (isPlainObject(notes.plain) && typeof notes.plain.content === 'string') {
      text = notes.plain.content
    } else if (typeof notes.content === 'string') text = notes.content
  }
  if (typeof text === 'string') {
    const trimmed = text.trim()
    return trimmed || undefined
  }
  pushWarning(ctx.warnings, '存在无法识别的备注格式，已忽略')
  return undefined
}

function readHrefValue(raw, ctx) {
  const href = raw.href
  if (href === undefined || href === null) return undefined
  if (typeof href === 'string') {
    const trimmed = href.trim()
    return trimmed || undefined
  }
  pushWarning(ctx.warnings, '存在无法识别的链接格式，已忽略')
  return undefined
}

function readLabelsValue(raw, ctx) {
  const labels = raw.labels
  if (labels === undefined || labels === null) return undefined
  if (!Array.isArray(labels)) {
    pushWarning(ctx.warnings, '存在无法识别的标签格式，已忽略')
    return undefined
  }
  const out = []
  const seen = new Set()
  for (const item of labels) {
    if (typeof item !== 'string') {
      pushWarning(ctx.warnings, '标签中存在非字符串项，已忽略')
      continue
    }
    const label = item.trim()
    if (label && !seen.has(label)) {
      seen.add(label)
      out.push(label)
    }
  }
  return out.length > 0 ? out : undefined
}

function warnMedia(raw, ctx) {
  if (hasContent(raw.image) || hasContent(raw.attachment) || hasContent(raw.attachments)) {
    pushWarning(ctx.warnings, '存在图片或附件内容，暂不支持，已忽略')
  }
}

function warnUnknownKeys(raw, ctx, knownKeys) {
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      pushWarning(ctx.warnings, `存在暂不支持的节点字段 "${key}"，已忽略`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* XMind 2020 content.json -> canonical tree                           */
/* ------------------------------------------------------------------ */

function readJsonChildren(raw, ctx, depth) {
  const source = raw.children
  if (source === undefined || source === null) return []
  let list
  if (Array.isArray(source)) {
    list = source
  } else if (isPlainObject(source)) {
    if (hasContent(source.detached)) {
      pushWarning(ctx.warnings, '存在浮动主题（detached），暂不支持，已忽略')
    }
    if (hasContent(source.summary) || hasContent(source.summaries)) {
      pushWarning(ctx.warnings, '存在摘要主题（summary），暂不支持，已忽略')
    }
    const attached = source.attached
    if (attached === undefined || attached === null) return []
    if (!Array.isArray(attached)) {
      pushWarning(ctx.warnings, '子主题 attached 字段格式不正确，已忽略')
      return []
    }
    list = attached
  } else {
    pushWarning(ctx.warnings, '子主题字段格式不正确，已忽略')
    return []
  }

  const out = []
  for (const child of list) {
    if (!isPlainObject(child)) {
      pushWarning(ctx.warnings, '存在无法识别的子主题，已忽略')
      continue
    }
    const node = convertJsonTopic(child, ctx, depth + 1)
    if (node) out.push(node)
  }
  return out
}

function convertJsonTopic(raw, ctx, depth) {
  if (depth > MAX_DEPTH) {
    pushWarning(ctx.warnings, `导图层级超过 ${MAX_DEPTH}，已截断`)
    return null
  }
  const node = {
    id: allocateId(ctx, raw.id),
    title: readTitleValue(raw, ctx),
    children: { attached: [] },
  }
  const notes = readNotesValue(raw, ctx)
  if (notes) node.notes = notes
  const href = readHrefValue(raw, ctx)
  if (href) node.href = href
  const labels = readLabelsValue(raw, ctx)
  if (labels) node.labels = labels
  warnMedia(raw, ctx)
  warnUnknownKeys(raw, ctx, KNOWN_TOPIC_KEYS)
  node.children.attached = readJsonChildren(raw, ctx, depth)
  return node
}

function readJsonSheets(buffer) {
  let value
  try {
    value = JSON.parse(stripBom(buffer.toString('utf8')))
  } catch {
    return null
  }
  if (!Array.isArray(value) || value.length === 0) return null
  const hasRootTopic = value.some(
    (sheet) => isPlainObject(sheet) && isPlainObject(sheet.rootTopic),
  )
  return hasRootTopic ? value : null
}

/* ------------------------------------------------------------------ */
/* XMind 8 content.xml -> canonical tree                               */
/* ------------------------------------------------------------------ */

function readXmlTitle(element, ctx) {
  const titleElement = findChild(element, 'title')
  if (titleElement) {
    const title = textOf(titleElement)
    if (title) return title
  }
  pushWarning(ctx.warnings, '存在缺少标题的节点，已使用 "Untitled"')
  return 'Untitled'
}

function readXmlNotes(element, ctx) {
  const notesElement = findChild(element, 'notes')
  if (!notesElement) return undefined
  const plainElement = findChild(notesElement, 'plain')
  if (plainElement) {
    const text = textOf(plainElement)
    return text || undefined
  }
  pushWarning(ctx.warnings, '存在仅包含富文本的备注，暂不支持，已忽略')
  return undefined
}

function readXmlHref(element) {
  const hrefElement = findChild(element, 'href')
  if (!hrefElement) return undefined
  const href = textOf(hrefElement)
  return href || undefined
}

function readXmlLabels(element) {
  const labelsElement = findChild(element, 'labels')
  if (!labelsElement) return undefined
  const out = []
  const seen = new Set()
  for (const labelElement of findChildren(labelsElement, 'label')) {
    const label = textOf(labelElement)
    if (label && !seen.has(label)) {
      seen.add(label)
      out.push(label)
    }
  }
  return out.length > 0 ? out : undefined
}

function warnXmlMedia(element, ctx) {
  if (
    findChildren(element, 'image').length > 0 ||
    findChildren(element, 'attachment').length > 0 ||
    findChildren(element, 'attachments').length > 0
  ) {
    pushWarning(ctx.warnings, '存在图片或附件内容，暂不支持，已忽略')
  }
}

function warnXmlSummary(element, ctx) {
  if (
    findChildren(element, 'summary').length > 0 ||
    findChildren(element, 'summaries').length > 0
  ) {
    pushWarning(ctx.warnings, '存在摘要主题（summary），暂不支持，已忽略')
  }
}

function warnXmlUnknownChildren(element, ctx) {
  for (const child of childrenOf(element)) {
    if (!KNOWN_XML_TOPIC_CHILDREN.has(child.name)) {
      pushWarning(ctx.warnings, `存在暂不支持的节点字段 "${child.name}"，已忽略`)
    }
  }
}

function readXmlChildren(element, ctx, depth) {
  const childrenElement = findChild(element, 'children')
  if (!childrenElement) return []
  const out = []

  for (const topicElement of findChildren(childrenElement, 'topic')) {
    const node = convertXmlTopic(topicElement, ctx, depth + 1)
    if (node) out.push(node)
  }

  for (const topicsElement of findChildren(childrenElement, 'topics')) {
    const type = String(topicsElement.attrs.type || 'attached').trim()
    if (type === 'attached') {
      for (const topicElement of findChildren(topicsElement, 'topic')) {
        const node = convertXmlTopic(topicElement, ctx, depth + 1)
        if (node) out.push(node)
      }
    } else if (type === 'detached') {
      pushWarning(ctx.warnings, '存在浮动主题（detached），暂不支持，已忽略')
    } else if (type === 'summary') {
      pushWarning(ctx.warnings, '存在摘要主题（summary），暂不支持，已忽略')
    } else {
      pushWarning(ctx.warnings, `存在暂不支持的主题类型 "${type}"，已忽略`)
    }
  }

  return out
}

function convertXmlTopic(element, ctx, depth) {
  if (depth > MAX_DEPTH) {
    pushWarning(ctx.warnings, `导图层级超过 ${MAX_DEPTH}，已截断`)
    return null
  }
  const node = {
    id: allocateId(ctx, element.attrs.id),
    title: readXmlTitle(element, ctx),
    children: { attached: [] },
  }
  const notes = readXmlNotes(element, ctx)
  if (notes) node.notes = notes
  const href = readXmlHref(element)
  if (href) node.href = href
  const labels = readXmlLabels(element)
  if (labels) node.labels = labels
  warnXmlMedia(element, ctx)
  warnXmlSummary(element, ctx)
  warnXmlUnknownChildren(element, ctx)
  node.children.attached = readXmlChildren(element, ctx, depth)
  return node
}

function readXmlSheets(buffer) {
  let document
  try {
    document = parseXml(buffer.toString('utf8'))
  } catch (error) {
    throw new Error(`无法解析 XMind content.xml：${error.message}`)
  }
  const contentElement = findChild(document, 'xmap-content')
  if (!contentElement) {
    throw new Error('无法解析 XMind content.xml：缺少 xmap-content 根元素')
  }
  const sheets = findChildren(contentElement, 'sheet')
  if (sheets.length === 0) {
    throw new Error('无法解析 XMind content.xml：缺少 sheet')
  }
  return sheets
}

/* ------------------------------------------------------------------ */
/* Sheet metadata                                                      */
/* ------------------------------------------------------------------ */

function describeJsonSheet(sheet, index, warnings) {
  const source = isPlainObject(sheet) ? sheet : {}
  const rawId = typeof source.id === 'string' ? source.id.trim() : ''
  const rawTitle = typeof source.title === 'string' ? source.title.trim() : ''
  if (!rawTitle) {
    pushWarning(warnings, `第 ${index + 1} 个 Sheet 缺少标题，已使用默认标题`)
  }
  return { id: rawId || `sheet-${index + 1}`, title: rawTitle || `Sheet ${index + 1}` }
}

function describeXmlSheet(sheet, index, warnings) {
  const rawId = typeof sheet.attrs.id === 'string' ? sheet.attrs.id.trim() : ''
  const titleElement = findChild(sheet, 'title')
  const rawTitle = titleElement ? textOf(titleElement) : ''
  if (!rawTitle) {
    pushWarning(warnings, `第 ${index + 1} 个 Sheet 缺少标题，已使用默认标题`)
  }
  return { id: rawId || `sheet-${index + 1}`, title: rawTitle || `Sheet ${index + 1}` }
}

/* ------------------------------------------------------------------ */
/* parseXmindBuffer                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse an .xmind workbook buffer (XMind 2020 content.json preferred, XMind 8
 * content.xml as fallback) into the canonical tree of the selected sheet.
 * @param {Buffer|Uint8Array} buffer raw .xmind bytes
 * @param {{ sheetIndex?: number, warnings?: string[] }} [opts]
 * @returns {{ rootTopic: object, sheetTitle: string, sheetCount: number,
 *   sheets: Array<{ id: string, title: string }>, format: 'json'|'xml', warnings: string[] }}
 */
export function parseXmindBuffer(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new TypeError('XMind 文件内容必须是 Buffer 或 Uint8Array')
  }
  const bytes = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (bytes.length === 0) throw new Error('XMind 文件内容为空')

  const options = isPlainObject(opts) ? opts : {}
  const rawIndex = options.sheetIndex === undefined ? 0 : options.sheetIndex
  if (!Number.isInteger(rawIndex) || rawIndex < 0) {
    throw new TypeError('sheetIndex 必须是非负整数')
  }
  const sheetIndex = rawIndex
  const warnings = Array.isArray(options.warnings) ? options.warnings : []

  const zip = readZip(bytes)

  let sheets = null
  let format = null
  if (zip.has('content.json')) {
    sheets = readJsonSheets(zip.get('content.json'))
  }
  if (sheets) {
    format = 'json'
  } else if (zip.has('content.xml')) {
    format = 'xml'
    if (zip.has('content.json')) {
      pushWarning(warnings, 'content.json 为空或格式无效，已回退到 content.xml 解析')
    }
    sheets = readXmlSheets(zip.get('content.xml'))
  } else if (zip.has('content.json')) {
    throw new Error('不是有效的 XMind 文件：content.json 为空或格式无效，且缺少 content.xml')
  } else {
    throw new Error('不是有效的 XMind 文件：缺少 content.json 与 content.xml')
  }

  const sheetCount = sheets.length
  if (sheetIndex >= sheetCount) {
    throw new Error(`sheetIndex 超出范围：该文件共有 ${sheetCount} 个 Sheet`)
  }
  if (sheetCount > 1) {
    pushWarning(
      warnings,
      `该文件包含 ${sheetCount} 个 Sheet，仅解析第 ${sheetIndex + 1} 个，其余已忽略`,
    )
  }

  const sheetInfos =
    format === 'json'
      ? sheets.map((sheet, index) => describeJsonSheet(sheet, index, warnings))
      : sheets.map((sheet, index) => describeXmlSheet(sheet, index, warnings))

  const ctx = createContext(warnings)
  let rootTopic
  if (format === 'json') {
    const selected = sheets[sheetIndex]
    if (!isPlainObject(selected) || !isPlainObject(selected.rootTopic)) {
      throw new Error(`第 ${sheetIndex + 1} 个 Sheet 缺少根主题，无法解析`)
    }
    rootTopic = convertJsonTopic(selected.rootTopic, ctx, 0)
  } else {
    const selected = sheets[sheetIndex]
    const topicElement = findChild(selected, 'topic')
    if (!topicElement) {
      throw new Error(`第 ${sheetIndex + 1} 个 Sheet 缺少根主题，无法解析`)
    }
    rootTopic = convertXmlTopic(topicElement, ctx, 0)
  }

  return {
    rootTopic,
    sheetTitle: sheetInfos[sheetIndex].title,
    sheetCount,
    sheets: sheetInfos,
    format,
    warnings,
  }
}

/* ------------------------------------------------------------------ */
/* Canonical tree -> XMind serialization                               */
/* ------------------------------------------------------------------ */

function resolveBuildSheetTitle(value, warnings) {
  if (typeof value === 'string') {
    const title = value.trim()
    if (title) return title
    return 'Sheet 1'
  }
  if (value !== undefined && value !== null) {
    pushWarning(warnings, 'sheetTitle 不是字符串，已使用默认值 "Sheet 1"')
  }
  return 'Sheet 1'
}

function prepareCanonicalTopic(raw, ctx, depth) {
  if (!isPlainObject(raw)) throw new TypeError('rootTopic 必须是普通对象')
  if (depth > MAX_DEPTH) throw new Error(`rootTopic 层级超过上限 ${MAX_DEPTH}`)
  if (ctx.seen.has(raw)) throw new Error('rootTopic 存在循环引用')
  ctx.seen.add(raw)

  const node = {
    id: allocateId(ctx, raw.id),
    title: readTitleValue(raw, ctx),
    children: [],
  }
  const notes = readNotesValue(raw, ctx)
  if (notes) node.notes = notes
  const href = readHrefValue(raw, ctx)
  if (href) node.href = href
  const labels = readLabelsValue(raw, ctx)
  if (labels) node.labels = labels
  warnMedia(raw, ctx)
  warnUnknownKeys(raw, ctx, CANONICAL_NODE_KEYS)

  let attached
  const children = raw.children
  if (children === undefined || children === null) {
    attached = []
  } else if (Array.isArray(children)) {
    attached = children
  } else if (isPlainObject(children)) {
    if (hasContent(children.detached)) {
      pushWarning(ctx.warnings, '存在浮动主题（detached），暂不支持，已忽略')
    }
    if (hasContent(children.summary) || hasContent(children.summaries)) {
      pushWarning(ctx.warnings, '存在摘要主题（summary），暂不支持，已忽略')
    }
    if (children.attached === undefined || children.attached === null) {
      attached = []
    } else if (Array.isArray(children.attached)) {
      attached = children.attached
    } else {
      throw new TypeError('rootTopic.children.attached 必须是数组')
    }
  } else {
    throw new TypeError('rootTopic.children 格式不正确')
  }

  for (const child of attached) {
    if (!isPlainObject(child)) {
      throw new TypeError('rootTopic.children.attached 中存在非对象节点')
    }
    node.children.push(prepareCanonicalTopic(child, ctx, depth + 1))
  }
  return node
}

function prepareTopic(rootTopic, warnings) {
  return prepareCanonicalTopic(rootTopic, createContext(warnings), 0)
}

function topicToJson(node) {
  const topic = { id: node.id, class: 'topic', title: node.title }
  if (node.children.length > 0) {
    topic.children = { attached: node.children.map((child) => topicToJson(child)) }
  }
  if (node.notes) topic.notes = { plain: { content: node.notes } }
  if (node.href) topic.href = node.href
  if (node.labels && node.labels.length > 0) topic.labels = node.labels.slice()
  return topic
}

function escapeXmlText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeXmlAttr(text) {
  return escapeXmlText(text).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function renderTopicXml(node, indent, lines) {
  const pad = '  '.repeat(indent)
  lines.push(`${pad}<topic id="${escapeXmlAttr(node.id)}">`)
  lines.push(`${pad}  <title>${escapeXmlText(node.title)}</title>`)
  if (node.href) lines.push(`${pad}  <href>${escapeXmlText(node.href)}</href>`)
  if (node.notes) {
    lines.push(`${pad}  <notes>`)
    lines.push(`${pad}    <plain>${escapeXmlText(node.notes)}</plain>`)
    lines.push(`${pad}  </notes>`)
  }
  if (node.labels && node.labels.length > 0) {
    lines.push(`${pad}  <labels>`)
    for (const label of node.labels) {
      lines.push(`${pad}    <label>${escapeXmlText(label)}</label>`)
    }
    lines.push(`${pad}  </labels>`)
  }
  if (node.children.length > 0) {
    lines.push(`${pad}  <children>`)
    lines.push(`${pad}    <topics type="attached">`)
    for (const child of node.children) {
      renderTopicXml(child, indent + 3, lines)
    }
    lines.push(`${pad}    </topics>`)
    lines.push(`${pad}  </children>`)
  }
  lines.push(`${pad}</topic>`)
}

function renderContentXml(prepared, sheetTitle) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">',
    `  <sheet id="${escapeXmlAttr(`sheet-${prepared.id}`)}">`,
    `    <title>${escapeXmlText(sheetTitle)}</title>`,
  ]
  renderTopicXml(prepared, 2, lines)
  lines.push('  </sheet>', '</xmap-content>', '')
  return lines.join('\n')
}

function buildSheetJson(prepared, sheetTitle) {
  return {
    id: `sheet-${prepared.id}`,
    class: 'sheet',
    title: sheetTitle,
    rootTopic: topicToJson(prepared),
  }
}

function buildMetadataJson(sheetId) {
  return JSON.stringify({
    creator: { name: 'dsh-xmind-mindmap', version: '1.0.0' },
    activeSheetId: sheetId,
  })
}

function buildManifestJson() {
  return JSON.stringify({
    'file-entries': {
      'content.json': {},
      'content.xml': {},
      'metadata.json': {},
      'manifest.json': {},
      'META-INF/manifest.xml': {},
    },
  })
}

function buildMetaInfManifestXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">',
    '  <file-entry full-path="content.xml" media-type="text/xml"/>',
    '  <file-entry full-path="META-INF/manifest.xml" media-type="text/xml"/>',
    '  <file-entry full-path="content.json" media-type="application/json"/>',
    '  <file-entry full-path="metadata.json" media-type="application/json"/>',
    '  <file-entry full-path="manifest.json" media-type="application/json"/>',
    '</manifest>',
    '',
  ].join('\n')
}

function buildContentJsonInternal(prepared, sheetTitle) {
  return [buildSheetJson(prepared, sheetTitle)]
}

/**
 * Build the XMind 2020 content.json value: a one-element sheet array.
 * @param {object} rootTopic canonical tree root
 * @param {string} [sheetTitle]
 * @returns {Array<object>}
 */
export function buildContentJson(rootTopic, sheetTitle) {
  const warnings = []
  const prepared = prepareTopic(rootTopic, warnings)
  const title = resolveBuildSheetTitle(sheetTitle, warnings)
  return buildContentJsonInternal(prepared, title)
}

/**
 * Build the XMind 8 content.xml compatibility payload for the same tree.
 * @param {object} rootTopic canonical tree root
 * @param {string} [sheetTitle]
 * @returns {string} XML text
 */
export function buildContentXml(rootTopic, sheetTitle) {
  const warnings = []
  const prepared = prepareTopic(rootTopic, warnings)
  const title = resolveBuildSheetTitle(sheetTitle, warnings)
  return renderContentXml(prepared, title)
}

/**
 * Build a complete .xmind workbook buffer (mimetype first + stored, then
 * content.json, content.xml, metadata.json, manifest.json,
 * META-INF/manifest.xml; all other entries deflated).
 * @param {object} rootTopic canonical tree root
 * @param {{ sheetTitle?: string, warnings?: string[] }} [opts]
 * @returns {Buffer}
 */
export function buildXmindBuffer(rootTopic, opts = {}) {
  const options = isPlainObject(opts) ? opts : {}
  const warnings = Array.isArray(options.warnings) ? options.warnings : []
  const prepared = prepareTopic(rootTopic, warnings)
  const sheetTitle = resolveBuildSheetTitle(options.sheetTitle, warnings)
  const sheet = buildSheetJson(prepared, sheetTitle)

  return writeZip([
    { name: 'mimetype', data: Buffer.from(MIMETYPE_VALUE, 'utf8'), store: true },
    { name: 'content.json', data: Buffer.from(JSON.stringify([sheet]), 'utf8') },
    { name: 'content.xml', data: Buffer.from(renderContentXml(prepared, sheetTitle), 'utf8') },
    { name: 'metadata.json', data: Buffer.from(buildMetadataJson(sheet.id), 'utf8') },
    { name: 'manifest.json', data: Buffer.from(buildManifestJson(), 'utf8') },
    {
      name: 'META-INF/manifest.xml',
      data: Buffer.from(buildMetaInfManifestXml(), 'utf8'),
    },
  ])
}
