// Minimal, dependency-free XML DOM parser tailored to XMind content.xml.
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
})

const XML_WS = /\s/

/**
 * @typedef {{ name: string, attrs: Record<string, string>, children: XmlNode[], text: string, parent?: XmlNode }} XmlNode
 */

/**
 * Create a node. `parent` and the internal document-order text parts are
 * non-enumerable so the public shape stays JSON-serializable and cycle-free.
 * @param {string} name
 * @param {Record<string, string>} attrs
 * @param {XmlNode|null} parent
 * @returns {XmlNode}
 */
function makeNode(name, attrs, parent) {
  const node = { name, attrs, children: [], text: '' }
  Object.defineProperty(node, 'parent', {
    value: parent,
    enumerable: false,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(node, '_textParts', {
    value: [],
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return node
}

/**
 * Append raw (already decoded) text to a node while remembering document order.
 * @param {XmlNode} node
 * @param {string} chunk
 */
function appendText(node, chunk) {
  if (chunk.length === 0) return
  node.text += chunk
  node._textParts.push(chunk)
}

/**
 * Append a child element while remembering document order.
 * @param {XmlNode} node
 * @param {XmlNode} child
 */
function appendChild(node, child) {
  node.children.push(child)
  node._textParts.push(child)
}

/**
 * Safe attribute assignment (avoids `__proto__` prototype pollution).
 * @param {Record<string, string>} attrs
 * @param {string} name
 * @param {string} value
 */
function setAttr(attrs, name, value) {
  Object.defineProperty(attrs, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * Decode the five predefined XML entities plus decimal/hex character refs.
 * Unknown or malformed references are kept verbatim (tolerant parsing).
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  if (!text.includes('&')) return text
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body) => {
      if (body.charCodeAt(0) === 35 /* # */) {
        const hex = body[1] === 'x' || body[1] === 'X'
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
        ? NAMED_ENTITIES[body]
        : match
    },
  )
}

/**
 * Locate the '>' that closes a start tag, skipping quoted attribute values.
 * @param {string} src
 * @param {number} start index just after '<'
 * @returns {number} index of '>' or -1
 */
function findTagEnd(src, start) {
  let quote = ''
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i
    }
  }
  return -1
}

/**
 * Locate the '>' that closes a <!DOCTYPE ...> declaration, including internal
 * subsets written as `[ ... ]` (which may themselves contain '>').
 * @param {string} src
 * @param {number} start index just after '<!'
 * @returns {number} index of '>' or -1
 */
function findDeclarationEnd(src, start) {
  let bracketDepth = 0
  let quote = ''
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '[') {
      bracketDepth += 1
    } else if (ch === ']') {
      if (bracketDepth > 0) bracketDepth -= 1
    } else if (ch === '>' && bracketDepth === 0) {
      return i
    }
  }
  return -1
}

/**
 * Parse the inside of a start tag into a name and attributes.
 * @param {string} content e.g. `topic id="a" href='b'`
 * @returns {{ name: string, attrs: Record<string, string> }}
 */
function parseTagContent(content) {
  let pos = 0
  const end = content.length
  while (pos < end && XML_WS.test(content[pos])) pos += 1
  if (pos >= end) throw new Error('XML 解析失败：起始标签为空')

  const nameStart = pos
  while (pos < end && !/[\s=/>]/.test(content[pos])) pos += 1
  const name = content.slice(nameStart, pos)
  if (!name) throw new Error('XML 解析失败：起始标签缺少名称')

  const attrs = {}
  while (pos < end) {
    while (pos < end && XML_WS.test(content[pos])) pos += 1
    if (pos >= end) break
    if (content[pos] === '/') {
      pos += 1
      continue
    }

    const attrStart = pos
    while (pos < end && !/[\s=/>]/.test(content[pos])) pos += 1
    const attrName = content.slice(attrStart, pos)
    if (!attrName) throw new Error('XML 解析失败：属性名称缺失')

    while (pos < end && XML_WS.test(content[pos])) pos += 1
    if (content[pos] !== '=') {
      throw new Error(`XML 解析失败：属性 "${attrName}" 缺少 "="`)
    }
    pos += 1
    while (pos < end && XML_WS.test(content[pos])) pos += 1

    let value
    const quote = content[pos]
    if (quote === '"' || quote === "'") {
      pos += 1
      const valueStart = pos
      while (pos < end && content[pos] !== quote) pos += 1
      if (pos >= end) {
        throw new Error(`XML 解析失败：属性 "${attrName}" 的引号未闭合`)
      }
      value = content.slice(valueStart, pos)
      pos += 1
    } else {
      // Tolerant fallback: unquoted attribute values are accepted.
      const valueStart = pos
      while (pos < end && !/[\s/>]/.test(content[pos])) pos += 1
      value = content.slice(valueStart, pos)
    }
    setAttr(attrs, attrName, decodeEntities(value))
  }

  return { name, attrs }
}

/**
 * Parse an XML document into a lightweight DOM.
 * Supported: XML declaration, comments, DOCTYPE (skipped), CDATA, self-closing
 * tags, attributes quoted with `"` or `'`, five named entities and numeric refs,
 * UTF-8 BOM, and arbitrary whitespace. The returned wrapper is named
 * `#document` and holds the document's root element(s) in `children`.
 * @param {string} text
 * @returns {XmlNode} root wrapper node (name '#document')
 */
export function parseXml(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseXml 需要字符串输入')
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (source.trim() === '') throw new Error('XML 内容为空')

  const document = makeNode('#document', {}, null)
  /** @type {XmlNode[]} */
  const stack = [document]
  let position = 0

  while (position < source.length) {
    const current = stack[stack.length - 1]
    const nextLt = source.indexOf('<', position)
    if (nextLt === -1) {
      appendText(current, decodeEntities(source.slice(position)))
      break
    }
    if (nextLt > position) {
      appendText(current, decodeEntities(source.slice(position, nextLt)))
    }

    if (source.startsWith('<!--', nextLt)) {
      const close = source.indexOf('-->', nextLt + 4)
      if (close === -1) throw new Error('XML 解析失败：注释未闭合')
      position = close + 3
      continue
    }

    if (source.startsWith('<![CDATA[', nextLt)) {
      const close = source.indexOf(']]>', nextLt + 9)
      if (close === -1) throw new Error('XML 解析失败：CDATA 未闭合')
      appendText(current, source.slice(nextLt + 9, close))
      position = close + 3
      continue
    }

    if (source.startsWith('<?', nextLt)) {
      const close = source.indexOf('?>', nextLt + 2)
      if (close === -1) throw new Error('XML 解析失败：处理指令未闭合')
      position = close + 2
      continue
    }

    if (source.startsWith('<!', nextLt)) {
      const close = findDeclarationEnd(source, nextLt + 2)
      if (close === -1) throw new Error('XML 解析失败：声明未闭合')
      position = close + 1
      continue
    }

    if (source.startsWith('</', nextLt)) {
      const close = source.indexOf('>', nextLt + 2)
      if (close === -1) throw new Error('XML 解析失败：结束标签未闭合')
      const name = source.slice(nextLt + 2, close).trim()
      if (!name) throw new Error('XML 解析失败：结束标签缺少名称')
      if (stack.length <= 1) {
        throw new Error(`XML 解析失败：多余的结束标签 </${name}>`)
      }
      const top = stack.pop()
      if (!top || top.name !== name) {
        throw new Error(
          `XML 解析失败：标签不匹配（</${name}> 与 <${top ? top.name : '?'}>）`,
        )
      }
      position = close + 1
      continue
    }

    const close = findTagEnd(source, nextLt + 1)
    if (close === -1) throw new Error('XML 解析失败：起始标签未闭合')
    const rawTag = source.slice(nextLt + 1, close)
    const selfClosing = rawTag.endsWith('/')
    const { name, attrs } = parseTagContent(
      selfClosing ? rawTag.slice(0, -1) : rawTag,
    )
    const node = makeNode(name, attrs, current)
    appendChild(current, node)
    if (!selfClosing) stack.push(node)
    position = close + 1
  }

  if (stack.length !== 1) {
    const unclosed = stack[stack.length - 1]
    throw new Error(`XML 解析失败：标签 <${unclosed.name}> 未闭合`)
  }
  if (document.children.length === 0) {
    throw new Error('XML 解析失败：未找到根元素')
  }
  return document
}

/**
 * @param {XmlNode|null|undefined} node
 * @param {string} name
 * @returns {XmlNode|null} first direct child with that name
 */
export function findChild(node, name) {
  for (const child of childrenOf(node)) {
    if (child.name === name) return child
  }
  return null
}

/**
 * @param {XmlNode|null|undefined} node
 * @param {string} name
 * @returns {XmlNode[]} all direct children with that name
 */
export function findChildren(node, name) {
  return childrenOf(node).filter((child) => child.name === name)
}

/**
 * @param {XmlNode|null|undefined} node
 * @returns {XmlNode[]} direct children, tolerating malformed nodes
 */
export function childrenOf(node) {
  if (!node || !Array.isArray(node.children)) return []
  return node.children
}

/**
 * Concatenate direct and descendant text in document order, then trim.
 * @param {XmlNode|null|undefined} node
 * @returns {string}
 */
export function textOf(node) {
  if (!node) return ''
  const parts = []
  /**
   * @param {XmlNode} current
   */
  function collect(current) {
    const ordered = current._textParts
    if (Array.isArray(ordered) && ordered.length > 0) {
      for (const part of ordered) {
        if (typeof part === 'string') parts.push(part)
        else collect(part)
      }
      return
    }
    // Fallback for manually constructed nodes: text first, then children.
    parts.push(current.text || '')
    for (const child of childrenOf(current)) collect(child)
  }
  collect(node)
  return parts.join('').trim()
}
