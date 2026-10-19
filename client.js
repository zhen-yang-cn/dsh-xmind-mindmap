/* dsh-xmind-mindmap client card: self-contained read-only SVG mindmap, outline, notes and markdown preview. */
window.__ModuleLoader__.load({
  id: 'dsh-xmind-mindmap',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef
    const useMemo = React.useMemo

    /*
     * Optional host primitive: the "original format" view of a Markdown document renders through
     * the platform's own Markdown component, so it looks exactly like the built-in preview. The
     * module id is a platform seed word (the same one dshmarket and modlens require); the request
     * is guarded so the plugin still loads — with the raw-source view only — on a host that does
     * not expose it.
     */
    let hostMarkdownText = null
    try {
      const hostPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (hostPrimitives && typeof hostPrimitives.MarkdownText === 'function') hostMarkdownText = hostPrimitives.MarkdownText
    } catch (error) {
      hostMarkdownText = null
    }

    /**
     * Error boundary around the host Markdown renderer: a host-side render failure must degrade to
     * the verbatim source instead of blanking the panel.
     */
    const MarkdownBoundaryBase = React && typeof React.Component === 'function' ? React.Component : function () {}
    class HostMarkdownBoundary extends MarkdownBoundaryBase {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    const TOOL_KEYS = ['view_xmind', 'markdown_to_mindmap', 'edit_mindmap_node', 'xmind_to_markdown']
    const LOCALE_NAMESPACE = 'xmind'
    const MIN_ZOOM = 0.3
    const MAX_ZOOM = 3
    const MAX_DEPTH = 512
    const MAX_NODES = 5000
    const MAX_LABEL = 120

    /* ------------------------------------------------------------------ *
     * Pure helpers (exported through __internals, unit-tested from node) *
     * ------------------------------------------------------------------ */

    /** Convert arbitrary text to a single-line, HTML-safe label. */
    function escapeLabel(text) {
      return String(text == null ? '' : text)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/[ \t]+/g, ' ')
        .trim()
    }

    /** Truncate to at most `max` characters, appending an ellipsis. */
    function truncate(text, max) {
      const value = String(text == null ? '' : text)
      const limit = typeof max === 'number' && max > 0 ? Math.floor(max) : 40
      if (value.length <= limit) return value
      if (limit <= 1) return '…'
      return value.slice(0, limit - 1).replace(/\s+$/, '') + '…'
    }

    /** Children of a loose tree node (canonical or XMind-ish shapes). */
    function asChildren(node) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return []
      const kids = node.children
      if (Array.isArray(kids)) return kids
      if (kids && typeof kids === 'object') {
        if (Array.isArray(kids.attached)) return kids.attached
        if (Array.isArray(kids.topics)) return kids.topics
      }
      return []
    }

    /** Tolerant normalisation of an untrusted loose tree into the canonical schema. */
    function normalizeLoose(raw) {
      const state = { count: 0, seq: 0, ids: new Set() }
      function walk(node, depth) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return null
        if (depth > MAX_DEPTH || state.count >= MAX_NODES) return null
        let title = ''
        const titleKeys = ['title', 'topic', 'text', 'name']
        for (let i = 0; i < titleKeys.length; i += 1) {
          const candidate = node[titleKeys[i]]
          if (typeof candidate === 'string' && candidate.trim()) {
            title = candidate.trim()
            break
          }
        }
        if (!title) title = 'Untitled'
        let id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : ''
        if (!id || state.ids.has(id)) {
          do {
            state.seq += 1
            id = 'n' + state.seq
          } while (state.ids.has(id))
        }
        state.ids.add(id)
        state.count += 1
        const out = { id: id, title: title, children: { attached: [] } }
        if (typeof node.notes === 'string' && node.notes.trim()) out.notes = node.notes.trim()
        if (typeof node.href === 'string' && node.href.trim()) out.href = node.href.trim()
        if (Array.isArray(node.labels)) {
          const seen = new Set()
          const labels = []
          for (let i = 0; i < node.labels.length; i += 1) {
            const label = node.labels[i]
            if (typeof label !== 'string') continue
            const trimmed = label.trim()
            if (!trimmed || seen.has(trimmed)) continue
            seen.add(trimmed)
            labels.push(trimmed)
          }
          if (labels.length) out.labels = labels
        }
        const kids = asChildren(node)
        for (let i = 0; i < kids.length; i += 1) {
          const child = walk(kids[i], depth + 1)
          if (child) out.children.attached.push(child)
        }
        return out
      }
      return walk(raw, 1)
    }

    /** Count every node of a (canonical) tree. */
    function countNodes(root) {
      let count = 0
      const stack = root ? [root] : []
      while (stack.length) {
        const node = stack.pop()
        if (!node || typeof node !== 'object') continue
        count += 1
        if (count > MAX_NODES) break
        const kids = asChildren(node)
        for (let i = 0; i < kids.length; i += 1) stack.push(kids[i])
      }
      return count
    }

    const EMPTY_META = {
      ok: false,
      v: 0,
      kind: 'tree',
      sourcePath: '',
      format: '',
      sheetTitle: '',
      sheetCount: 0,
      sheetIndex: 0,
      rootTopic: null,
      mermaid: '',
      warnings: [],
      writtenPath: '',
      action: '',
      nodeId: '',
      markdown: '',
      nodeCount: 0,
      warningCount: 0,
    }

    /** Tolerant parser of `block.meta`; never throws, never returns null. */
    function parseMeta(block) {
      const out = Object.assign({}, EMPTY_META, { warnings: [] })
      let meta = null
      try {
        if (block && typeof block === 'object' && !Array.isArray(block)) {
          const candidate = block.meta
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) meta = candidate
        }
      } catch (error) {
        meta = null
      }
      if (!meta) return out

      function text(value) {
        return typeof value === 'string' ? value : ''
      }
      function number(value) {
        return typeof value === 'number' && isFinite(value) ? value : 0
      }

      out.v = number(meta.v)
      out.kind = meta.kind === 'markdown' ? 'markdown' : 'tree'
      out.sourcePath = text(meta.sourcePath)
      out.format = text(meta.format)
      out.sheetTitle = text(meta.sheetTitle)
      out.sheetCount = Math.max(0, Math.floor(number(meta.sheetCount)))
      out.sheetIndex = Math.max(0, Math.floor(number(meta.sheetIndex)))
      out.writtenPath = text(meta.writtenPath)
      out.action = text(meta.action)
      out.nodeId = text(meta.nodeId)
      out.markdown = text(meta.markdown)
      out.mermaid = text(meta.mermaid)
      if (Array.isArray(meta.warnings)) {
        for (let i = 0; i < meta.warnings.length; i += 1) {
          const warning = meta.warnings[i]
          if (typeof warning === 'string' && warning.trim()) out.warnings.push(warning.trim())
        }
      }
      out.warningCount = out.warnings.length
      out.rootTopic = normalizeLoose(meta.rootTopic)
      out.nodeCount = out.rootTopic ? countNodes(out.rootTopic) : 0
      out.ok = out.kind === 'markdown' ? out.markdown.length > 0 || !!out.rootTopic : !!out.rootTopic
      return out
    }

    /* --------------------------- layout --------------------------- */

    const LAYOUT = {
      charWidth: 7.6,
      padX: 22,
      minW: 96,
      maxW: 260,
      nodeH: 34,
      gapX: 56,
      gapY: 14,
      pad: 24,
    }

    function round2(value) {
      return Math.round(value * 100) / 100
    }

    function nodeWidth(title, depth) {
      const length = String(title == null ? '' : title).length
      let width = LAYOUT.padX * 2 + length * LAYOUT.charWidth
      width = Math.min(LAYOUT.maxW, Math.max(LAYOUT.minW, width))
      if (depth === 1) width = Math.max(width, 120)
      return Math.round(width)
    }

    function normalizeCollapsed(collapsed) {
      const set = new Set()
      if (!collapsed) return set
      if (typeof collapsed.forEach === 'function') {
        collapsed.forEach(function (value) {
          if (value != null) set.add(String(value))
        })
        return set
      }
      if (typeof collapsed === 'object') {
        Object.keys(collapsed).forEach(function (key) {
          if (collapsed[key]) set.add(key)
        })
      }
      return set
    }

    /**
     * Deterministic horizontal tidy-tree layout.
     * @param {object} root canonical (or loose) tree root
     * @param {{collapsed?: Set<string>|string[]|object}} [options]
     * @returns {{nodes: Array<object>, links: Array<object>, width: number, height: number}}
     */
    function layoutTree(root, options) {
      const opts = options && typeof options === 'object' ? options : {}
      const collapsed = normalizeCollapsed(opts.collapsed)
      const nodes = []
      const links = []
      if (!root || typeof root !== 'object' || Array.isArray(root)) {
        return { nodes: nodes, links: links, width: 0, height: 0 }
      }

      let synthetic = 0
      const columnWidths = []
      function buildVisible(node, depth) {
        synthetic += 1
        const rawTitle = typeof node.title === 'string' ? node.title : ''
        const title = rawTitle.trim() || 'Untitled'
        let id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : ''
        if (!id) id = 'n' + synthetic
        const kids = asChildren(node)
        const isCollapsed = kids.length > 0 && collapsed.has(id)
        const visible = {
          id: id,
          title: title,
          depth: depth,
          notes: typeof node.notes === 'string' ? node.notes : '',
          href: typeof node.href === 'string' ? node.href : '',
          labels: Array.isArray(node.labels) ? node.labels : [],
          hasNotes: typeof node.notes === 'string' && node.notes.trim().length > 0,
          childCount: kids.length,
          collapsed: isCollapsed,
          w: nodeWidth(title, depth),
          h: LAYOUT.nodeH,
          x: 0,
          y: 0,
          subH: LAYOUT.nodeH,
          children: [],
        }
        columnWidths[depth - 1] = Math.max(columnWidths[depth - 1] || 0, visible.w)
        if (!isCollapsed) {
          for (let i = 0; i < kids.length; i += 1) {
            const child = buildVisible(kids[i], depth + 1)
            visible.children.push(child)
          }
        }
        return visible
      }

      const visibleRoot = buildVisible(root, 1)

      function measure(node) {
        if (!node.children.length) {
          node.subH = node.h
          return node.subH
        }
        let total = 0
        for (let i = 0; i < node.children.length; i += 1) {
          if (i > 0) total += LAYOUT.gapY
          total += measure(node.children[i])
        }
        node.subH = Math.max(node.h, total)
        return node.subH
      }
      measure(visibleRoot)

      const columnX = []
      let cursor = LAYOUT.pad
      for (let depth = 0; depth < columnWidths.length; depth += 1) {
        columnX[depth] = cursor
        cursor += (columnWidths[depth] || 0) + LAYOUT.gapX
      }

      let maxRight = 0
      let maxBottom = 0
      function place(node, top) {
        node.x = columnX[node.depth - 1]
        node.y = top + (node.subH - node.h) / 2
        maxRight = Math.max(maxRight, node.x + node.w)
        maxBottom = Math.max(maxBottom, node.y + node.h)
        if (!node.children.length) return
        let childTop = top + (node.subH - childrenTotal(node)) / 2
        for (let i = 0; i < node.children.length; i += 1) {
          place(node.children[i], childTop)
          childTop += node.children[i].subH + LAYOUT.gapY
        }
      }
      function childrenTotal(node) {
        let total = 0
        for (let i = 0; i < node.children.length; i += 1) {
          if (i > 0) total += LAYOUT.gapY
          total += node.children[i].subH
        }
        return total
      }
      place(visibleRoot, LAYOUT.pad)

      function collect(node) {
        const record = {
          id: node.id,
          x: round2(node.x),
          y: round2(node.y),
          w: node.w,
          h: node.h,
          depth: node.depth,
          title: node.title,
          hasNotes: node.hasNotes,
          collapsed: node.collapsed,
          childCount: node.childCount,
          children: node.children.map(function (child) {
            return child.id
          }),
        }
        if (node.notes) record.notes = node.notes
        if (node.href) record.href = node.href
        if (node.labels && node.labels.length) record.labels = node.labels.slice()
        nodes.push(record)
        for (let i = 0; i < node.children.length; i += 1) {
          links.push({ from: node.id, to: node.children[i].id })
          collect(node.children[i])
        }
      }
      collect(visibleRoot)

      return {
        nodes: nodes,
        links: links,
        width: round2(maxRight + LAYOUT.pad),
        height: round2(maxBottom + LAYOUT.pad),
      }
    }

    /** Flat pre-order rows used by the outline view. */
    function outlineRows(root) {
      const rows = []
      if (!root || typeof root !== 'object') return rows
      const stack = [{ node: root, depth: 1, parentId: '' }]
      while (stack.length) {
        const item = stack.pop()
        const node = item.node
        if (!node || typeof node !== 'object') continue
        const kids = asChildren(node)
        const id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : 'row-' + rows.length
        const title = typeof node.title === 'string' && node.title.trim() ? node.title.trim() : 'Untitled'
        const notes = typeof node.notes === 'string' ? node.notes : ''
        const href = typeof node.href === 'string' ? node.href : ''
        const labels = Array.isArray(node.labels)
          ? node.labels.filter(function (label) {
              return typeof label === 'string' && label.trim().length > 0
            })
          : []
        rows.push({
          id: id,
          title: title,
          depth: item.depth,
          parentId: item.parentId,
          hasChildren: kids.length > 0,
          hasNotes: notes.trim().length > 0,
          notes: notes,
          href: href,
          labels: labels,
        })
        for (let i = kids.length - 1; i >= 0; i -= 1) {
          stack.push({ node: kids[i], depth: item.depth + 1, parentId: id })
        }
      }
      return rows
    }

    /* ------------------- sidebar preview: XMind parsing ------------------- */

    const PREVIEW_ID = 'dsh-xmind-mindmap.preview'
    const MARKDOWN_PREVIEW_ID = 'dsh-xmind-mindmap.preview.markdown'
    const PREVIEW_MAX_BYTES = 64 * 1024 * 1024
    const PREVIEW_MAX_NODES = 5000
    /** Beyond this size a Markdown file is not turned into a mindmap in the sidebar. */
    const MARKDOWN_MAX_BYTES = 8 * 1024 * 1024

    function previewBytesOf(content) {
      if (!content || typeof content !== 'object' || content.kind !== 'bytes') return null
      const data = content.data
      if (data instanceof Uint8Array) return data
      if (data instanceof ArrayBuffer) return new Uint8Array(data)
      return null
    }

    function decodeUtf8(bytes) {
      return new TextDecoder('utf-8').decode(bytes)
    }

    /**
     * Text of a `text-pages` preview body; `null` for any other loading mode.
     * @param {{kind?: string, text?: string}} content
     * @returns {string|null}
     */
    function previewTextOf(content) {
      if (!content || typeof content !== 'object' || content.kind !== 'text') return null
      return typeof content.text === 'string' ? content.text : ''
    }

    function u16(bytes, offset) {
      return bytes[offset] | (bytes[offset + 1] << 8)
    }

    function u32(bytes, offset) {
      return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
    }

    async function inflateRawPreview(bytes) {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('当前环境不支持 DecompressionStream，无法解压 .xmind')
      }
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      const buffer = await new Response(stream).arrayBuffer()
      return new Uint8Array(buffer)
    }

    /**
     * Read the ZIP entries of an .xmind workbook in the browser.
     * @param {Uint8Array} bytes complete file bytes
     * @returns {Promise<{names: string[], has: Function, get: Function}>} lazy entry reader
     */
    async function readZipEntries(bytes) {
      if (!bytes || bytes.length < 22) throw new Error('不是有效的 ZIP 文件（.xmind 为空或过小）')
      let eocd = -1
      const start = Math.max(0, bytes.length - 65557)
      for (let i = bytes.length - 22; i >= start; i -= 1) {
        if (u32(bytes, i) === 0x06054b50) {
          eocd = i
          break
        }
      }
      if (eocd < 0) throw new Error('不是有效的 ZIP 文件（缺少中央目录）')
      const count = u16(bytes, eocd + 10)
      let offset = u32(bytes, eocd + 16)
      const entries = new Map()
      for (let index = 0; index < count; index += 1) {
        if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) {
          throw new Error('ZIP 中央目录损坏')
        }
        const method = u16(bytes, offset + 10)
        const compressedSize = u32(bytes, offset + 20)
        const nameLength = u16(bytes, offset + 28)
        const extraLength = u16(bytes, offset + 30)
        const commentLength = u16(bytes, offset + 32)
        const localOffset = u32(bytes, offset + 42)
        const name = decodeUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength))
        if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) {
          throw new Error('ZIP 本地文件头损坏')
        }
        const localNameLength = u16(bytes, localOffset + 26)
        const localExtraLength = u16(bytes, localOffset + 28)
        const dataStart = localOffset + 30 + localNameLength + localExtraLength
        entries.set(name, { method: method, raw: bytes.subarray(dataStart, dataStart + compressedSize) })
        offset += 46 + nameLength + extraLength + commentLength
      }
      return {
        names: Array.from(entries.keys()),
        has(name) {
          return entries.has(name)
        },
        async get(name) {
          const entry = entries.get(name)
          if (!entry) return null
          if (entry.method === 0) return entry.raw
          if (entry.method === 8) return inflateRawPreview(entry.raw)
          throw new Error('不支持的 ZIP 压缩方式: ' + entry.method)
        },
      }
    }

    const XML_NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

    function decodeXmlEntities(value) {
      if (value.indexOf('&') < 0) return value
      return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (match, body) {
        if (body.charAt(0) === '#') {
          const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
          const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
          if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
          try {
            return String.fromCodePoint(code)
          } catch (error) {
            return match
          }
        }
        return Object.prototype.hasOwnProperty.call(XML_NAMED_ENTITIES, body) ? XML_NAMED_ENTITIES[body] : match
      })
    }

    function xmlText(node) {
      if (!node || typeof node !== 'object') return ''
      let out = node.text || ''
      const children = node.children || []
      for (let i = 0; i < children.length; i += 1) out += xmlText(children[i])
      return out.trim()
    }

    function xmlChildren(node, name) {
      if (!node || !Array.isArray(node.children)) return []
      return node.children.filter(function (child) {
        return child && child.name === name
      })
    }

    function xmlChild(node, name) {
      return xmlChildren(node, name)[0] || null
    }

    /** Minimal tolerant XML DOM parser for the XMind 8 content.xml shape. */
    function parseXmlLite(source) {
      const text = String(source || '').replace(/^\uFEFF/, '')
      const document = { name: '#document', attrs: {}, children: [], text: '' }
      const stack = [document]
      let index = 0
      function appendText(chunk) {
        if (!chunk) return
        const current = stack[stack.length - 1]
        current.text = (current.text || '') + chunk
      }
      while (index < text.length) {
        const lt = text.indexOf('<', index)
        if (lt < 0) {
          appendText(decodeXmlEntities(text.slice(index)))
          break
        }
        if (lt > index) appendText(decodeXmlEntities(text.slice(index, lt)))
        if (text.startsWith('<!--', lt)) {
          const end = text.indexOf('-->', lt + 4)
          index = end < 0 ? text.length : end + 3
          continue
        }
        if (text.startsWith('<![CDATA[', lt)) {
          const end = text.indexOf(']]>', lt + 9)
          appendText(text.slice(lt + 9, end < 0 ? text.length : end))
          index = end < 0 ? text.length : end + 3
          continue
        }
        if (text.startsWith('<?', lt)) {
          const end = text.indexOf('?>', lt + 2)
          index = end < 0 ? text.length : end + 2
          continue
        }
        if (text.startsWith('<!', lt)) {
          let end = text.indexOf('>', lt + 2)
          const bracket = text.indexOf('[', lt + 2)
          if (bracket >= 0 && (end < 0 || bracket < end)) {
            const close = text.indexOf(']', bracket)
            end = close < 0 ? text.indexOf('>', bracket) : text.indexOf('>', close)
          }
          index = end < 0 ? text.length : end + 1
          continue
        }
        if (text.charAt(lt + 1) === '/') {
          const end = text.indexOf('>', lt + 2)
          if (end < 0) throw new Error('XML 解析失败：结束标签未闭合')
          const name = text.slice(lt + 2, end).trim().split(/\s+/)[0]
          while (stack.length > 1) {
            const popped = stack.pop()
            if (popped.name === name) break
          }
          index = end + 1
          continue
        }
        let end = lt + 1
        let quote = ''
        for (; end < text.length; end += 1) {
          const ch = text.charAt(end)
          if (quote) {
            if (ch === quote) quote = ''
          } else if (ch === '"' || ch === "'") {
            quote = ch
          } else if (ch === '>') {
            break
          }
        }
        if (end >= text.length) throw new Error('XML 解析失败：起始标签未闭合')
        let inner = text.slice(lt + 1, end)
        const selfClosing = inner.charAt(inner.length - 1) === '/'
        if (selfClosing) inner = inner.slice(0, -1)
        const space = inner.search(/\s/)
        const name = (space < 0 ? inner : inner.slice(0, space)).trim()
        if (!name) throw new Error('XML 解析失败：标签名称为空')
        const node = { name: name, attrs: {}, children: [], text: '' }
        if (space >= 0) {
          const attrText = inner.slice(space)
          const regex = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g
          let match
          while ((match = regex.exec(attrText)) !== null) {
            const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5] || ''
            node.attrs[match[1]] = decodeXmlEntities(value)
          }
        }
        stack[stack.length - 1].children.push(node)
        if (!selfClosing) stack.push(node)
        index = end + 1
      }
      return document
    }

    function previewNode(raw, state) {
      const node = { id: '', title: '', children: { attached: [] } }
      const source = raw && typeof raw === 'object' ? raw : {}
      let id = typeof source.id === 'string' ? source.id.trim() : ''
      if (!id || state.ids.has(id)) {
        do {
          state.counter += 1
          id = 'n-' + state.counter
        } while (state.ids.has(id))
      }
      state.ids.add(id)
      node.id = id
      const title = typeof source.title === 'string' ? source.title.trim() : ''
      node.title = title || '未命名'
      if (!title) state.warnings.push('存在缺少标题的节点，已显示为“未命名”')
      if (typeof source.notes === 'string' && source.notes.trim()) node.notes = source.notes.trim()
      if (typeof source.href === 'string' && source.href.trim()) node.href = source.href.trim()
      if (Array.isArray(source.labels)) {
        const labels = []
        for (let i = 0; i < source.labels.length; i += 1) {
          const label = source.labels[i]
          if (typeof label === 'string' && label.trim() && labels.indexOf(label.trim()) < 0) labels.push(label.trim())
        }
        if (labels.length) node.labels = labels
      }
      state.nodes += 1
      if (state.nodes > PREVIEW_MAX_NODES) return node
      const children = source.children
      const attached = children && Array.isArray(children.attached) ? children.attached : Array.isArray(children) ? children : []
      for (let i = 0; i < attached.length && state.nodes <= PREVIEW_MAX_NODES; i += 1) {
        node.children.attached.push(previewNode(attached[i], state))
      }
      return node
    }

    function jsonTopicNotes(topic) {
      const notes = topic && topic.notes
      if (typeof notes === 'string') return notes
      if (notes && typeof notes === 'object') {
        if (typeof notes.plain === 'string') return notes.plain
        if (notes.plain && typeof notes.plain.content === 'string') return notes.plain.content
        if (typeof notes.content === 'string') return notes.content
      }
      return ''
    }

    function jsonTopicToRaw(topic, warnings) {
      if (!topic || typeof topic !== 'object') return { title: '未命名' }
      const out = {
        id: typeof topic.id === 'string' ? topic.id : '',
        title: typeof topic.title === 'string' ? topic.title : '',
        notes: jsonTopicNotes(topic),
        href: typeof topic.href === 'string' ? topic.href : '',
        labels: Array.isArray(topic.labels) ? topic.labels : [],
        children: { attached: [] },
      }
      const children = topic.children
      const attached = children && Array.isArray(children.attached) ? children.attached : []
      for (let i = 0; i < attached.length; i += 1) out.children.attached.push(jsonTopicToRaw(attached[i], warnings))
      return out
    }

    function parseXmindJsonContent(text) {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.sheets) ? parsed.sheets : null
      if (!list) throw new Error('content.json 不是 Sheet 数组')
      const warnings = []
      const sheets = []
      for (let i = 0; i < list.length; i += 1) {
        const sheet = list[i]
        if (!sheet || typeof sheet !== 'object' || !sheet.rootTopic) continue
        sheets.push({
          id: typeof sheet.id === 'string' ? sheet.id : 'sheet-' + (i + 1),
          title: typeof sheet.title === 'string' && sheet.title.trim() ? sheet.title.trim() : 'Sheet ' + (i + 1),
          rootTopic: jsonTopicToRaw(sheet.rootTopic, warnings),
        })
      }
      return { sheets: sheets, warnings: warnings }
    }

    function xmlTopicToRaw(topic, warnings) {
      if (!topic) return { title: '未命名' }
      const titleNode = xmlChild(topic, 'title')
      const notesNode = xmlChild(topic, 'notes')
      const plain = notesNode ? xmlChild(notesNode, 'plain') : null
      const labelsNode = xmlChild(topic, 'labels')
      const labels = labelsNode
        ? xmlChildren(labelsNode, 'label').map(function (label) {
            return xmlText(label)
          }).filter(Boolean)
        : []
      const out = {
        id: topic.attrs && typeof topic.attrs.id === 'string' ? topic.attrs.id : '',
        title: xmlText(titleNode),
        notes: plain ? xmlText(plain) : '',
        href: topic.attrs && typeof topic.attrs.href === 'string' ? topic.attrs.href : '',
        labels: labels,
        children: { attached: [] },
      }
      const childrenNode = xmlChild(topic, 'children')
      if (childrenNode) {
        const groups = xmlChildren(childrenNode, 'topics')
        for (let i = 0; i < groups.length; i += 1) {
          const type = groups[i].attrs && groups[i].attrs.type
          if (type && type !== 'attached') continue
          const topics = xmlChildren(groups[i], 'topic')
          for (let j = 0; j < topics.length; j += 1) out.children.attached.push(xmlTopicToRaw(topics[j], warnings))
        }
      }
      return out
    }

    function parseXmindXmlContent(text) {
      const document = parseXmlLite(text)
      const content = document.children.find(function (child) {
        return child && child.name === 'xmap-content'
      }) || document
      const sheets = []
      const warnings = []
      const sheetNodes = xmlChildren(content, 'sheet')
      for (let i = 0; i < sheetNodes.length; i += 1) {
        const sheet = sheetNodes[i]
        const topic = xmlChild(sheet, 'topic')
        if (!topic) continue
        const titleNode = xmlChild(sheet, 'title')
        sheets.push({
          id: sheet.attrs && typeof sheet.attrs.id === 'string' ? sheet.attrs.id : 'sheet-' + (i + 1),
          title: xmlText(titleNode) || 'Sheet ' + (i + 1),
          rootTopic: xmlTopicToRaw(topic, warnings),
        })
      }
      return { sheets: sheets, warnings: warnings }
    }

    /**
     * Parse a complete .xmind workbook in the browser (content.json, else content.xml).
     * @param {Uint8Array} bytes complete workbook bytes
     * @returns {Promise<{sheets: Array<object>, format: string, warnings: string[]}>} parsed workbook
     */
    async function parseXmindBytes(bytes) {
      if (!bytes || typeof bytes.length !== 'number') throw new Error('没有可读取的文件内容')
      if (bytes.length > PREVIEW_MAX_BYTES) throw new Error('文件过大，无法在预览中打开')
      const zip = await readZipEntries(bytes)
      const warnings = []
      if (zip.has('content.json')) {
        try {
          const text = decodeUtf8(await zip.get('content.json')).replace(/^\uFEFF/, '')
          const parsed = parseXmindJsonContent(text)
          if (parsed.sheets.length > 0) return { sheets: parsed.sheets, format: 'json', warnings: parsed.warnings }
          warnings.push('content.json 没有可用的 Sheet，已回退到 content.xml')
        } catch (error) {
          warnings.push('content.json 解析失败，已回退到 content.xml: ' + (error && error.message ? error.message : String(error)))
        }
      }
      if (zip.has('content.xml')) {
        const text = decodeUtf8(await zip.get('content.xml')).replace(/^\uFEFF/, '')
        const parsed = parseXmindXmlContent(text)
        if (parsed.sheets.length > 0) {
          return { sheets: parsed.sheets, format: 'xml', warnings: warnings.concat(parsed.warnings) }
        }
        warnings.push('content.xml 中没有可用的 Sheet')
      }
      throw new Error('该 .xmind 不包含可解析的 content.json 或 content.xml')
    }

    /** Build the chat-card payload for one parsed sheet. */
    function previewPayload(sheets, sheetIndex, warnings, sourcePath) {
      const index = Math.max(0, Math.min(sheets.length - 1, Math.floor(sheetIndex) || 0))
      const sheet = sheets[index] || null
      return {
        v: 1,
        kind: 'tree',
        sourcePath: sourcePath || '',
        format: 'xmind',
        sheetTitle: sheet ? sheet.title : '',
        sheetCount: sheets.length,
        sheetIndex: index,
        rootTopic: sheet ? sheet.rootTopic : null,
        mermaid: '',
        warnings: Array.isArray(warnings) ? warnings : [],
      }
    }

    function previewSourcePath(address) {
      if (typeof address === 'string') return address
      if (!address || typeof address !== 'object') return ''
      if (typeof address.path === 'string') return address.path
      if (typeof address.absolutePath === 'string') return address.absolutePath
      if (address.file && typeof address.file === 'object' && typeof address.file.path === 'string') return address.file.path
      return ''
    }

    /**
     * Build the chat-card payload for a Markdown document rendered as a mindmap.
     * @param {string} markdown document text
     * @param {string} sourcePath path used for the fallback root title
     * @returns {object} payload in the same shape as {@link previewPayload}
     */
    function markdownPreviewPayload(markdown, sourcePath) {
      const text = typeof markdown === 'string' ? markdown : ''
      let parsed
      try {
        parsed = parseMarkdownText(text, { fileName: baseName(sourcePath) })
      } catch (error) {
        parsed = { root: { id: 'md-1', title: 'Untitled', children: { attached: [] } }, warnings: [] }
      }
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.slice() : []
      return {
        v: 1,
        kind: 'tree',
        sourcePath: sourcePath || '',
        format: 'markdown',
        sheetTitle: '',
        sheetCount: 0,
        sheetIndex: 0,
        rootTopic: parsed.root || null,
        mermaid: '',
        warnings: warnings,
      }
    }

    /* ------- sidebar preview: Markdown -> tree (mirror of lib/markdown.js) ------- *
     * The client bundle cannot import host modules, so `parseMarkdownText` below is a
     * verbatim mirror of `parseMarkdown` in lib/markdown.js (only identifiers are
     * prefixed). test/preview.test.js cross-checks both implementations on the same
     * sources, so any behaviour change must be applied to both files.
     */
    const MD_UNSUPPORTED_MARKER = '该内容类型暂不支持 XMind 结构映射:'
    const MD_EMPTY_WARNING = '文件为空或只包含空白字符'

    const MD_KIND_TITLES = {
      code: '代码块',
      table: '表格',
      image: '图片',
      blockquote: '引用块',
    }

    /** `# ATX` heading; more than 6 hashes is tolerated for XMind-origin depth recovery. */
    const MD_HEADING_RE = /^ {0,3}(#{1,})\s+(.*)$/
    /** Exactly one `#` at the start of the line: the document root candidate. */
    const MD_ROOT_HEADING_RE = /^ {0,3}#\s+(.*)$/
    const MD_LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
    const MD_LIST_EMPTY_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]*$/
    const MD_FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
    const MD_BLOCKQUOTE_RE = /^ {0,3}>/
    const MD_IMAGE_ONLY_RE = /^ {0,3}!\[[^\]]*\]\([^)]*\)\s*$/
    const MD_TABLE_DELIMITER_RE = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

    /** @param {unknown} value */
    function mdIsPlainObject(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
      const proto = Object.getPrototypeOf(value)
      return proto === Object.prototype || proto === null
    }

    /** @param {unknown} value */
    function mdNonEmptyString(value) {
      return typeof value === 'string' && value.trim() !== ''
    }

    /**
     * Collapse a single line to display text.
     * @param {string} text
     * @returns {string}
     */
    function mdCollapseWhitespace(text) {
      return String(text).replace(/\s+/g, ' ').trim()
    }

    /**
     * File-name stem used as the synthetic root title.
     * @param {unknown} fileName
     * @returns {string}
     */
    function mdTitleFromFileName(fileName) {
      if (!mdNonEmptyString(fileName)) return 'Untitled'
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
    function mdStripClosingHashes(text) {
      return text.replace(/\s+#+\s*$/, '').trim()
    }

    /**
     * If the text is exactly one Markdown link `[title](url)`, split it; otherwise keep it literal.
     * @param {string} text
     * @returns {{title: string, href?: string}}
     */
    function mdExtractLink(text) {
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
    function mdCleanParagraph(lines) {
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
    function mdAppendToNotes(node, text) {
      if (!text) return
      const existing = typeof node.notes === 'string' ? node.notes : ''
      node.notes = existing ? `${existing}\n\n${text}` : text
    }

    /**
     * @param {string[]} lines
     * @param {number} index
     * @returns {boolean} whether a new block starts at this line
     */
    function mdIsTableStart(lines, index) {
      const header = lines[index]
      if (typeof header !== 'string' || !header.includes('|')) return false
      const delimiter = lines[index + 1]
      if (typeof delimiter !== 'string' || !delimiter.includes('|')) return false
      return MD_TABLE_DELIMITER_RE.test(delimiter)
    }

    /**
     * @param {string[]} lines
     * @param {number} index
     * @returns {boolean}
     */
    function mdStartsBlock(lines, index) {
      const line = lines[index]
      if (typeof line !== 'string' || line.trim() === '') return true
      if (MD_HEADING_RE.test(line)) return true
      if (MD_FENCE_RE.test(line)) return true
      if (MD_LIST_RE.test(line) || MD_LIST_EMPTY_RE.test(line)) return true
      if (MD_BLOCKQUOTE_RE.test(line)) return true
      if (MD_IMAGE_ONLY_RE.test(line)) return true
      if (mdIsTableStart(lines, index)) return true
      return false
    }

    /**
     * @param {string} line
     * @param {string} fenceCharacter
     * @param {number} fenceLength
     * @returns {boolean}
     */
    function mdIsClosingFence(line, fenceCharacter, fenceLength) {
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
    function parseMarkdownText(markdown, opts = {}) {
      const warnings = Array.isArray(opts.warnings) ? opts.warnings : []
      const source = typeof markdown === 'string' ? markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') : ''
      const lines = source.split('\n')

      let rootTitle = mdTitleFromFileName(opts.fileName)
      let rootHref
      let rootLineIndex = -1
      for (let index = 0; index < lines.length; index += 1) {
        const match = MD_ROOT_HEADING_RE.exec(lines[index])
        if (!match) continue
        const parsed = mdExtractLink(mdStripClosingHashes(match[1]))
        rootTitle = parsed.title
        rootHref = parsed.href
        rootLineIndex = index
        break
      }

      const root = { id: 'md-1', title: rootTitle, children: { attached: [] } }
      if (rootHref) root.href = rootHref

      if (source.trim() === '') {
        warnings.push(MD_EMPTY_WARNING)
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
        const parsed = mdExtractLink(text)
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
        const title = MD_KIND_TITLES[kind] || kind
        if (lastStructural) {
          mdAppendToNotes(lastStructural, `${MD_UNSUPPORTED_MARKER}\n${raw}`)
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
        const node = createNodeFromText(mdStripClosingHashes(rawText))

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

        const fence = MD_FENCE_RE.exec(line)
        if (fence) {
          const character = fence[1][0]
          const length = fence[1].length
          let end = index + 1
          let closed = false
          while (end < lines.length) {
            if (mdIsClosingFence(lines[end], character, length)) {
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

        const heading = MD_HEADING_RE.exec(line)
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

        const listItem = MD_LIST_RE.exec(line) || MD_LIST_EMPTY_RE.exec(line)
        if (listItem) {
          handleListItem(listItem, index + 1)
          index += 1
          continue
        }

        if (MD_BLOCKQUOTE_RE.test(line)) {
          let end = index + 1
          while (end < lines.length && MD_BLOCKQUOTE_RE.test(lines[end])) end += 1
          degrade('blockquote', lines.slice(index, end).join('\n'), index + 1)
          index = end
          continue
        }

        if (MD_IMAGE_ONLY_RE.test(line)) {
          let end = index + 1
          while (end < lines.length && MD_IMAGE_ONLY_RE.test(lines[end])) end += 1
          degrade('image', lines.slice(index, end).join('\n'), index + 1)
          index = end
          continue
        }

        if (mdIsTableStart(lines, index)) {
          let end = index + 2
          while (end < lines.length && lines[end].trim() !== '' && lines[end].includes('|')) end += 1
          degrade('table', lines.slice(index, end).join('\n'), index + 1)
          index = end
          continue
        }

        // Paragraph: consume until the next blank line or block starter.
        let end = index + 1
        while (end < lines.length && !mdStartsBlock(lines, end)) end += 1
        const paragraphLines = lines.slice(index, end)
        const text = mdCleanParagraph(paragraphLines)
        if (text) {
          if (lastStructural) {
            mdAppendToNotes(lastStructural, text)
          } else {
            const firstLine = mdCollapseWhitespace(paragraphLines[0] || '')
            const title = Array.from(firstLine).slice(0, 80).join('') || 'Untitled'
            const node = { id: allocateId(), title, children: { attached: [] }, notes: text }
            root.children.attached.push(node)
          }
        }
        index = end
      }

      return { root, warnings }
    }

    function previewStyles() {
      return {
        root: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' },
        center: {
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 24,
          color: 'var(--dsw-alias-label-secondary, #6b7280)',
          fontSize: 13,
          textAlign: 'center',
        },
        errorTitle: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontWeight: 600 },
        muted: { color: 'var(--dsw-alias-label-tertiary, #9aa1ab)', fontSize: 12, wordBreak: 'break-word' },
        sheetBar: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid var(--dsw-alias-border-l1, #eef0f3)',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          flex: '0 0 auto',
        },
        select: {
          font: 'inherit',
          fontSize: 12,
          color: 'var(--dsw-alias-label-primary, #1f2328)',
          background: 'var(--dsw-alias-bg-layer-2, #f4f6f8)',
          border: '1px solid var(--dsw-alias-border-l2, #e4e6eb)',
          borderRadius: 6,
          padding: '3px 6px',
          maxWidth: 240,
        },
        viewBar: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid var(--dsw-alias-border-l1, #eef0f3)',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          flex: '0 0 auto',
        },
        viewButton: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 24,
          padding: '0 10px',
          border: '1px solid var(--dsw-alias-border-l2, #e4e6eb)',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          color: 'var(--dsw-alias-label-secondary, #6b7280)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: 1,
          cursor: 'pointer',
        },
        viewButtonActive: {
          background: 'var(--dsw-alias-interactive-bg-active, #e8edff)',
          borderColor: 'var(--dsw-alias-brand-primary, #4d6bfe)',
          color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        },
        sourceScroll: {
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'auto',
          padding: '10px 14px',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          color: 'var(--dsw-alias-label-primary, #1f2328)',
          fontSize: 13,
          lineHeight: 1.65,
          wordBreak: 'break-word',
        },
        sourcePre: {
          margin: 0,
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'auto',
          padding: '10px 12px',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          color: 'var(--dsw-alias-label-primary, #1f2328)',
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
      }
    }

    /** Right Sidebar document body for `.xmind` files. */
    function XmindPreviewBody(props) {
      const safe = props && typeof props === 'object' ? props : {}
      const tr = makeT(safe.t)
      const styles = previewStyles()
      const bytes = previewBytesOf(safe.content)
      const sourcePath = previewSourcePath(safe.resourceAddress)
      const [state, setState] = useState({ status: bytes ? 'loading' : 'empty', sheets: [], warnings: [], error: '' })
      const [sheetIndex, setSheetIndex] = useState(0)

      useEffect(
        function () {
          if (!bytes) {
            setState({ status: 'empty', sheets: [], warnings: [], error: '' })
            return undefined
          }
          let cancelled = false
          setState({ status: 'loading', sheets: [], warnings: [], error: '' })
          parseXmindBytes(bytes).then(
            function (book) {
              if (cancelled) return
              setState({ status: 'ready', sheets: book.sheets, warnings: book.warnings, error: '' })
              setSheetIndex(0)
            },
            function (error) {
              if (cancelled) return
              setState({ status: 'error', sheets: [], warnings: [], error: error && error.message ? error.message : String(error) })
            }
          )
          return function () {
            cancelled = true
          }
        },
        [bytes]
      )

      if (state.status === 'loading') {
        return h('div', { style: styles.center }, h('span', { style: { fontSize: 18 }, 'aria-hidden': 'true' }, '…'), h('span', null, tr('preview.loading')))
      }
      if (state.status === 'empty') {
        return h('div', { style: styles.center }, h('div', { style: styles.muted }, tr('preview.noBytes')))
      }
      if (state.status === 'error') {
        return h(
          'div',
          { style: styles.center, role: 'alert' },
          h('div', { style: styles.errorTitle }, tr('preview.failed')),
          h('div', { style: styles.muted }, state.error),
          h('div', { style: styles.muted }, tr('preview.hint'))
        )
      }

      const payload = previewPayload(state.sheets, sheetIndex, state.warnings, sourcePath)
      const sheetBar =
        state.sheets.length > 1
          ? h(
              'div',
              { style: styles.sheetBar },
              h('label', { style: styles.muted, htmlFor: 'xmind-preview-sheet' }, tr('preview.sheet')),
              h(
                'select',
                {
                  id: 'xmind-preview-sheet',
                  style: styles.select,
                  value: String(sheetIndex),
                  onChange: function (event) {
                    const next = Number(event && event.target ? event.target.value : 0)
                    setSheetIndex(Number.isFinite(next) ? next : 0)
                  },
                },
                state.sheets.map(function (sheet, index) {
                  return h('option', { key: 'sheet-' + index, value: String(index) }, sheet.title || 'Sheet ' + (index + 1))
                })
              )
            )
          : null

      return h(
        'div',
        { style: styles.root },
        sheetBar,
        h(MindmapCard, { key: 'xmind-preview-' + sheetIndex, variant: 'preview', block: { meta: payload }, t: safe.t })
      )
    }

    /**
     * Text of a preview body regardless of loading mode: `bytes-complete` bytes are
     * decoded as UTF-8, `text-pages` pages are used verbatim.
     * @param {object} content
     * @returns {{status: 'empty'|'too-large'|'ok', text: string}}
     */
    function previewDocumentText(content) {
      // `bytes-complete` hands the body no content at all until the file is read; treat that as
      // "nothing to show yet" rather than guessing at a file that has not arrived.
      if (content === undefined || content === null) return { status: 'empty', text: '' }
      const bytes = previewBytesOf(content)
      if (bytes) {
        if (bytes.length > MARKDOWN_MAX_BYTES) return { status: 'too-large', text: '' }
        try {
          return { status: 'ok', text: decodeUtf8(bytes) }
        } catch (error) {
          return { status: 'empty', text: '' }
        }
      }
      const text = previewTextOf(content)
      if (text === null) return { status: 'empty', text: '' }
      return { status: 'ok', text: text }
    }

    /** View labels of the Markdown preview: the mindmap, or the file's own Markdown source. */
    const MARKDOWN_VIEWS = {
      MAP: 'map',
      SOURCE: 'source',
    }

    /**
     * Last view chosen per document path, so closing and reopening a tab keeps the reading mode.
     * In-memory only: the client card may not touch storage, and a session-scoped panel keeps the
     * whole session's paths comfortably small.
     */
    const MARKDOWN_VIEW_MEMORY = new Map()

    /** @param {string} key @param {string} view */
    function rememberMarkdownView(key, view) {
      if (!key) return
      if (MARKDOWN_VIEW_MEMORY.size > 50 && !MARKDOWN_VIEW_MEMORY.has(key)) MARKDOWN_VIEW_MEMORY.clear()
      MARKDOWN_VIEW_MEMORY.set(key, view)
    }

    /**
     * Primitive-level labels the host Markdown component asks for (code-block chrome, footnotes).
     * Supplied from this plugin's own dictionary so the host renderer stays language-consistent
     * with the rest of the card without reaching into another locale namespace.
     * @param {(key: string) => string} tr
     */
    function hostMarkdownLabels(tr) {
      return {
        code: {
          copyLabel: tr('preview.mdCodeCopy'),
          copiedLabel: tr('preview.mdCodeCopied'),
          toolbarLabels: {
            codeLabel: tr('preview.mdCodeLabel'),
            wrapLabel: tr('preview.mdCodeWrap'),
            unwrapLabel: tr('preview.mdCodeUnwrap'),
          },
        },
        footnotes: tr('preview.mdFootnotes'),
      }
    }

    /**
     * "Original format" view: the file's own Markdown, rendered. When the host exposes its
     * Markdown primitive the pane looks exactly like the built-in `.md` preview; otherwise (or if
     * that renderer ever throws) the verbatim source stands in, so the view is never empty.
     * @param {string} text @param {object} styles @param {(key: string) => string} tr
     */
    function renderSourceView(text, styles, tr) {
      const verbatim = h(
        'pre',
        { style: styles.sourcePre, 'aria-label': tr('preview.markdownViewSource'), tabIndex: 0 },
        text
      )
      if (!hostMarkdownText) return verbatim
      return h(
        'div',
        { key: 'md-source-scroll', style: styles.sourceScroll },
        h(
          HostMarkdownBoundary,
          { key: 'md-source-boundary', fallback: verbatim },
          h(hostMarkdownText, { key: 'md-source', text: text, labels: hostMarkdownLabels(tr), streaming: false, variant: 'body' })
        )
      )
    }

    /**
     * Right Sidebar document body for `.md` / `.markdown` files.
     *
     * Both views live in this one body so the pane itself offers the choice: the mindmap view
     * named after the original request, and the file's own Markdown rendered as Markdown.
     * Switching renderers in the host header dropdown still works (the host's builtin Markdown
     * renderer stays a candidate), but that entry point is easy to miss, so the toggle lives here.
     */
    function MarkdownPreviewBody(props) {
      const safe = props && typeof props === 'object' ? props : {}
      const tr = makeT(safe.t)
      const styles = previewStyles()
      const sourcePath = previewSourcePath(safe.resourceAddress)
      const document = previewDocumentText(safe.content)
      const [view, setViewState] = useState(MARKDOWN_VIEW_MEMORY.get(sourcePath) || MARKDOWN_VIEWS.MAP)
      const setView = function (next) {
        rememberMarkdownView(sourcePath, next)
        setViewState(next)
      }
      const payload = useMemo(
        function () {
          return document.status === 'ok' ? markdownPreviewPayload(document.text, sourcePath) : null
        },
        [document.status, document.text, sourcePath]
      )

      if (document.status === 'too-large') {
        return h('div', { style: styles.center }, h('div', { style: styles.muted }, tr('preview.markdownTooLarge')))
      }
      if (document.status === 'empty') {
        return h('div', { style: styles.center }, h('div', { style: styles.muted }, tr('preview.noBytes')))
      }
      if (!document.text.trim()) {
        return h('div', { style: styles.center }, h('div', { style: styles.muted }, tr('preview.markdownEmpty')))
      }

      const viewButton = function (key, label, hint) {
        const active = view === key
        return h(
          'button',
          {
            type: 'button',
            key: 'md-view-' + key,
            'aria-label': label,
            'aria-pressed': active ? 'true' : 'false',
            title: hint || label,
            onClick: function () {
              setView(key)
            },
            style: active ? merge(styles.viewButton, styles.viewButtonActive) : styles.viewButton,
          },
          label
        )
      }

      const viewBar = h(
        'div',
        { style: styles.viewBar, role: 'toolbar', 'aria-label': tr('preview.markdownViews') },
        viewButton(MARKDOWN_VIEWS.MAP, tr('preview.markdownViewMap'), tr('preview.markdownViewMapHint')),
        viewButton(MARKDOWN_VIEWS.SOURCE, tr('preview.markdownViewSource'), tr('preview.markdownViewSourceHint'))
      )

      if (view === MARKDOWN_VIEWS.SOURCE) {
        return h(
          'div',
          { style: styles.root },
          viewBar,
          renderSourceView(document.text, styles, tr)
        )
      }

      if (!payload || !payload.rootTopic) {
        return h(
          'div',
          { style: styles.root },
          viewBar,
          h('div', { style: styles.center }, h('div', { style: styles.muted }, tr('preview.markdownFailed')))
        )
      }

      return h(
        'div',
        { style: styles.root },
        viewBar,
        h(MindmapCard, { key: 'markdown-preview', variant: 'preview', block: { meta: payload }, t: safe.t })
      )
    }

    /* --------------------------- locale --------------------------- */

    const ZH = {
      'mindmap.title': 'XMind 导图',
      'mindmap.scanning': '正在解析导图…',
      'mindmap.nodesUnit': '节点',
      'mindmap.warningsUnit': '警告',
      'mindmap.sheet': 'Sheet',
      'mindmap.map': '导图',
      'mindmap.outline': '大纲',
      'mindmap.fit': '适应',
      'mindmap.zoomIn': '放大',
      'mindmap.zoomOut': '缩小',
      'mindmap.expandAll': '全部展开',
      'mindmap.collapseAll': '全部收起',
      'mindmap.mermaid': 'Mermaid 源码',
      'mindmap.mermaidEmpty': '没有 Mermaid 源码',
      'mindmap.copy': '复制',
      'mindmap.copied': '已复制',
      'mindmap.copyFailed': '复制失败',
      'mindmap.notes': '备注',
      'mindmap.href': '链接',
      'mindmap.labels': '标签',
      'mindmap.noDetails': '该节点没有备注、链接或标签',
      'mindmap.details': '节点详情',
      'mindmap.warnings': '警告',
      'mindmap.written': '已写出',
      'mindmap.markdown': 'Markdown 预览',
      'mindmap.empty': '没有可显示的导图数据',
      'mindmap.error': '工具执行失败',
      'mindmap.expandCard': '展开卡片',
      'mindmap.collapseCard': '收起卡片',
      'mindmap.toggleNode': '展开或收起节点',
      'mindmap.readOnly': '只读',
      'mindmap.untitled': '未命名',
      'preview.title': 'XMind 导图',
      'preview.loading': '正在解析 .xmind…',
      'preview.failed': '无法解析这个 .xmind',
      'preview.hint': '请确认文件是完整的 XMind 2020+（content.json）或 XMind 8（content.xml）工作簿。',
      'preview.noBytes': '没有读取到文件内容，可以点击标题栏的刷新重新读取。',
      'preview.sheet': 'Sheet',
      'preview.markdownTitle': 'Markdown 导图',
      'preview.markdownEmpty': '这个 Markdown 文件没有可映射为导图的内容。',
      'preview.markdownTooLarge': 'Markdown 文件过大，暂不在侧边栏生成导图。',
      'preview.markdownFailed': '无法把这个 Markdown 解析为导图',
      'preview.markdownViews': '浏览方式',
      'preview.markdownViewMap': '导图',
      'preview.markdownViewSource': '原文',
      'preview.markdownViewMapHint': '把 Markdown 映射成 XMind 导图浏览',
      'preview.markdownViewSourceHint': '按文件原本的 Markdown 格式浏览',
      'preview.mdCodeCopy': '复制',
      'preview.mdCodeCopied': '已复制',
      'preview.mdCodeLabel': '代码',
      'preview.mdCodeWrap': '自动换行',
      'preview.mdCodeUnwrap': '取消换行',
      'preview.mdFootnotes': '脚注',
    }

    const EN = {
      'mindmap.title': 'XMind mindmap',
      'mindmap.scanning': 'Parsing mindmap…',
      'mindmap.nodesUnit': 'nodes',
      'mindmap.warningsUnit': 'warnings',
      'mindmap.sheet': 'Sheet',
      'mindmap.map': 'Map',
      'mindmap.outline': 'Outline',
      'mindmap.fit': 'Fit',
      'mindmap.zoomIn': 'Zoom in',
      'mindmap.zoomOut': 'Zoom out',
      'mindmap.expandAll': 'Expand all',
      'mindmap.collapseAll': 'Collapse all',
      'mindmap.mermaid': 'Mermaid source',
      'mindmap.mermaidEmpty': 'No Mermaid source',
      'mindmap.copy': 'Copy',
      'mindmap.copied': 'Copied',
      'mindmap.copyFailed': 'Copy failed',
      'mindmap.notes': 'Notes',
      'mindmap.href': 'Link',
      'mindmap.labels': 'Labels',
      'mindmap.noDetails': 'This node has no notes, link or labels',
      'mindmap.details': 'Node details',
      'mindmap.warnings': 'Warnings',
      'mindmap.written': 'Written',
      'mindmap.markdown': 'Markdown preview',
      'mindmap.empty': 'No mindmap data to display',
      'mindmap.error': 'Tool failed',
      'mindmap.expandCard': 'Expand card',
      'mindmap.collapseCard': 'Collapse card',
      'mindmap.toggleNode': 'Toggle node',
      'mindmap.readOnly': 'Read-only',
      'mindmap.untitled': 'Untitled',
      'preview.title': 'XMind mindmap',
      'preview.loading': 'Parsing .xmind…',
      'preview.failed': 'This .xmind cannot be parsed',
      'preview.hint': 'Make sure it is a complete XMind 2020+ (content.json) or XMind 8 (content.xml) workbook.',
      'preview.noBytes': 'No file bytes were read. Use reload in the header to read the file again.',
      'preview.sheet': 'Sheet',
      'preview.markdownTitle': 'Markdown mindmap',
      'preview.markdownEmpty': 'This Markdown file has no content that maps to a mindmap.',
      'preview.markdownTooLarge': 'This Markdown file is too large to render as a mindmap in the sidebar.',
      'preview.markdownFailed': 'This Markdown cannot be parsed into a mindmap',
      'preview.markdownViews': 'View',
      'preview.markdownViewMap': 'Mindmap',
      'preview.markdownViewSource': 'Source',
      'preview.markdownViewMapHint': 'Read the Markdown as an XMind mindmap',
      'preview.markdownViewSourceHint': 'Read the file in its original Markdown format',
      'preview.mdCodeCopy': 'Copy',
      'preview.mdCodeCopied': 'Copied',
      'preview.mdCodeLabel': 'Code',
      'preview.mdCodeWrap': 'Wrap',
      'preview.mdCodeUnwrap': 'Unwrap',
      'preview.mdFootnotes': 'Footnotes',
    }

    function makeT(t) {
      return function tr(key) {
        const candidates = [key, LOCALE_NAMESPACE + '.' + key]
        for (let i = 0; i < candidates.length; i += 1) {
          try {
            if (typeof t === 'function') {
              const value = t(candidates[i])
              if (typeof value === 'string' && value && value !== candidates[i]) return value
            }
          } catch (error) {
            /* ignore translator errors */
          }
        }
        if (Object.prototype.hasOwnProperty.call(ZH, key)) return ZH[key]
        return key
      }
    }

    function baseName(filePath) {
      if (typeof filePath !== 'string' || !filePath) return ''
      const parts = filePath.split(/[\\/]/)
      return parts[parts.length - 1] || ''
    }

    /** Collect plain text blocks from `block.content` for the degraded card. */
    function contentText(block) {
      const pieces = []
      function push(value) {
        if (typeof value === 'string' && value.trim()) pieces.push(value.trim())
      }
      if (block && typeof block === 'object') {
        const content = block.content
        if (typeof content === 'string') push(content)
        else if (Array.isArray(content)) {
          for (let i = 0; i < content.length; i += 1) {
            const item = content[i]
            if (typeof item === 'string') push(item)
            else if (item && typeof item === 'object') push(item.text)
          }
        } else if (content && typeof content === 'object') push(content.text)
        if (!pieces.length) {
          const error = block.error
          if (typeof error === 'string') push(error)
          else if (error && typeof error === 'object' && typeof error.message === 'string') push(error.message)
        }
      }
      return pieces.join('\n\n')
    }

    function copyText(value, done) {
      const finish = typeof done === 'function' ? done : function () {}
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : null
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          const pending = nav.clipboard.writeText(value)
          if (pending && typeof pending.then === 'function') {
            pending.then(
              function () {
                finish(true)
              },
              function () {
                finish(false)
              }
            )
          } else {
            finish(true)
          }
          return
        }
      } catch (error) {
        /* fall through */
      }
      finish(false)
    }

    function merge(base, extra) {
      return Object.assign({}, base, extra || {})
    }

    /* --------------------------- styles --------------------------- */

    const css = {
      card: {
        border: '1px solid var(--dsw-alias-border-l2, #e4e6eb)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        overflow: 'hidden',
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        fontSize: 13,
        lineHeight: 1.5,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        margin: 0,
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      iconBox: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        flex: '0 0 22px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2, #f4f6f8)',
        color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      },
      title: {
        flex: '0 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: 600,
      },
      badge: {
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        padding: '0 7px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2, #f4f6f8)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontSize: 11,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      },
      badgeWarn: {
        background: 'var(--dsw-alias-bg-layer-2, #f4f6f8)',
        color: 'var(--dsw-alias-state-warn-primary, #d97706)',
      },
      chevron: {
        marginLeft: 'auto',
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-tertiary, #9aa1ab)',
        fontSize: 11,
      },
      spinner: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-tertiary, #9aa1ab)',
        fontSize: 12,
      },
      body: {
        borderTop: '1px solid var(--dsw-alias-border-l1, #eef0f3)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      toolbar: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #eef0f3)',
      },
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        height: 24,
        padding: '0 8px',
        border: '1px solid var(--dsw-alias-border-l2, #e4e6eb)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1,
        cursor: 'pointer',
      },
      buttonActive: {
        background: 'var(--dsw-alias-interactive-bg-active, #e8edff)',
        borderColor: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      },
      buttonIcon: {
        padding: '0 6px',
        minWidth: 24,
      },
      zoomLabel: {
        minWidth: 42,
        textAlign: 'center',
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #9aa1ab)',
      },
      spacer: { flex: '1 1 auto' },
      mapWrap: {
        position: 'relative',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      viewport: {
        position: 'relative',
        height: 440,
        overflow: 'hidden',
        background:
          'repeating-linear-gradient(0deg, transparent, transparent 23px, var(--dsw-alias-bg-layer-2, #f7f8fa) 23px, var(--dsw-alias-bg-layer-2, #f7f8fa) 24px), repeating-linear-gradient(90deg, transparent, transparent 23px, var(--dsw-alias-bg-layer-2, #f7f8fa) 23px, var(--dsw-alias-bg-layer-2, #f7f8fa) 24px)',
      },
      svg: {
        display: 'block',
        width: '100%',
        height: '100%',
        touchAction: 'none',
        userSelect: 'none',
      },
      side: {
        position: 'absolute',
        top: 8,
        right: 8,
        bottom: 8,
        width: 224,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        overflow: 'auto',
        border: '1px solid var(--dsw-alias-border-l2, #e4e6eb)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        boxShadow: '0 4px 16px var(--dsw-alias-bg-mask-1, rgba(15, 23, 42, 0.12))',
        fontSize: 12,
      },
      sideTitle: { fontWeight: 600, wordBreak: 'break-word' },
      sideLabel: {
        marginTop: 4,
        color: 'var(--dsw-alias-label-tertiary, #9aa1ab)',
        fontSize: 11,
      },
      sideText: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        maxHeight: 180,
        overflow: 'auto',
      },
      link: {
        color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        wordBreak: 'break-all',
        textDecoration: 'none',
      },
      chipRow: { display: 'flex', flexWrap: 'wrap', gap: 4 },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        padding: '0 6px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-3, #eef0f3)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontSize: 11,
        whiteSpace: 'nowrap',
      },
      muted: { color: 'var(--dsw-alias-label-tertiary, #9aa1ab)', fontSize: 12 },
      outline: {
        maxHeight: 440,
        overflow: 'auto',
        padding: '4px 0',
        outline: 'none',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        cursor: 'pointer',
        outline: 'none',
      },
      rowToggle: {
        flex: '0 0 14px',
        width: 14,
        textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary, #9aa1ab)',
        fontSize: 11,
      },
      rowTitle: {
        flex: '0 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      rowBadge: {
        flex: '0 0 auto',
        fontSize: 10,
        color: 'var(--dsw-alias-state-warn-primary, #d97706)',
      },
      codeBox: {
        borderBottom: '1px solid var(--dsw-alias-border-l1, #eef0f3)',
      },
      codeHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
      },
      pre: {
        margin: 0,
        padding: '8px 10px',
        maxHeight: 260,
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      markdownPre: {
        margin: 0,
        padding: '10px 12px',
        maxHeight: 420,
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      warnings: {
        padding: '6px 10px 8px',
        borderTop: '1px solid var(--dsw-alias-border-l1, #eef0f3)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      warnTitle: {
        color: 'var(--dsw-alias-state-warn-primary, #d97706)',
        fontSize: 11,
        fontWeight: 600,
      },
      warnList: {
        margin: '4px 0 0',
        padding: '0 0 0 18px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontSize: 12,
      },
      footer: {
        padding: '6px 10px',
        borderTop: '1px solid var(--dsw-alias-border-l1, #eef0f3)',
        color: 'var(--dsw-alias-label-tertiary, #9aa1ab)',
        fontSize: 11,
        wordBreak: 'break-all',
      },
      cardPreview: {
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: 'none',
        borderRadius: 0,
        background: 'transparent',
        overflow: 'hidden',
      },
      bodyPreview: {
        flex: '1 1 auto',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderTop: 'none',
        background: 'transparent',
      },
      mapWrapPreview: {
        flex: '1 1 auto',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      },
      viewportPreview: {
        height: '100%',
        minHeight: 240,
        flex: '1 1 auto',
      },
      outlinePreview: {
        maxHeight: 'none',
        flex: '1 1 auto',
        overflow: 'auto',
      },
    }

    /* --------------------------- component --------------------------- */

    function iconNode() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('circle', { cx: 3.5, cy: 8, r: 2, fill: 'currentColor' }),
        h('path', {
          d: 'M5.5 8h3M8.5 8V4h3.5M8.5 8v4h3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      )
    }

    function MindmapCard(props) {
      const safeProps = props && typeof props === 'object' ? props : {}
      const block = safeProps.block && typeof safeProps.block === 'object' ? safeProps.block : {}
      const phase = typeof safeProps.phase === 'string' ? safeProps.phase : 'result'
      const tr = makeT(safeProps.t)
      const isPreview = safeProps.variant === 'preview'
      const meta = useMemo(function () {
        return parseMeta(block)
      }, [block])
      const [expanded, setExpanded] = useState(isPreview ? true : phase !== 'preparing')
      const [view, setView] = useState('map')
      const [collapsedIds, setCollapsedIds] = useState(function () {
        return new Set()
      })
      const [selectedId, setSelectedId] = useState('')
      const [zoom, setZoom] = useState(1)
      const [pan, setPan] = useState({ x: 0, y: 0 })
      const [showMermaid, setShowMermaid] = useState(false)
      const [copied, setCopied] = useState('')
      const wrapRef = useRef(null)
      const dragRef = useRef(null)
      const movedRef = useRef(false)
      const lastFitKeyRef = useRef('')

      const isTree = meta.kind === 'tree' && !!meta.rootTopic
      const layout = useMemo(
        function () {
          return layoutTree(isTree ? meta.rootTopic : null, { collapsed: collapsedIds })
        },
        [isTree, meta.rootTopic, collapsedIds]
      )
      const rows = useMemo(
        function () {
          return outlineRows(isTree ? meta.rootTopic : null)
        },
        [isTree, meta.rootTopic]
      )
      const rowById = useMemo(
        function () {
          const map = {}
          for (let i = 0; i < rows.length; i += 1) map[rows[i].id] = rows[i]
          return map
        },
        [rows]
      )
      const nodeById = useMemo(
        function () {
          const map = {}
          for (let i = 0; i < layout.nodes.length; i += 1) map[layout.nodes[i].id] = layout.nodes[i]
          return map
        },
        [layout]
      )
      const selected = selectedId ? rowById[selectedId] || null : null
      // Stable content signature: refit for a new/edited tree, never for collapse/zoom changes.
      const fitKey = meta.ok
        ? [meta.sourcePath, meta.sheetTitle, meta.nodeCount, meta.action, meta.nodeId, meta.mermaid.length].join('|')
        : ''

      useEffect(
        function () {
          if (!isTree || view !== 'map') return undefined
          const key = view + '|' + fitKey
          if (lastFitKeyRef.current === key) return undefined
          lastFitKeyRef.current = key
          fitView()
          return undefined
        },
        [isTree, view, fitKey]
      )

      useEffect(function () {
        const element = wrapRef.current
        if (!element || typeof element.addEventListener !== 'function') return undefined
        function onWheel(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          const delta = event && typeof event.deltaY === 'number' ? event.deltaY : 0
          setZoom(function (current) {
            return clampZoom(current * (delta > 0 ? 0.9 : 1.1))
          })
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return function () {
          if (typeof element.removeEventListener === 'function') element.removeEventListener('wheel', onWheel)
        }
      }, [])

      useEffect(
        function () {
          if (!isPreview) return undefined
          const element = wrapRef.current
          if (!element || typeof ResizeObserver !== 'function') return undefined
          let timer = null
          const observer = new ResizeObserver(function () {
            if (timer) clearTimeout(timer)
            timer = setTimeout(function () {
              fitView()
            }, 120)
          })
          observer.observe(element)
          return function () {
            if (timer) clearTimeout(timer)
            observer.disconnect()
          }
        },
        [isPreview, layout.width, layout.height]
      )

      function clampZoom(value) {
        const numeric = typeof value === 'number' && isFinite(value) ? value : 1
        return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, numeric))
      }

      function fitView() {
        const element = wrapRef.current
        const width = (element && element.clientWidth) || 720
        const height = (element && element.clientHeight) || 440
        if (!layout.width || !layout.height) {
          setZoom(1)
          setPan({ x: 0, y: 0 })
          return
        }
        const scale = clampZoom(Math.min((width - 24) / layout.width, (height - 24) / layout.height))
        setZoom(scale)
        setPan({
          x: Math.max(8, (width - layout.width * scale) / 2),
          y: Math.max(8, (height - layout.height * scale) / 2),
        })
      }

      function zoomBy(factor) {
        setZoom(function (current) {
          return clampZoom(current * factor)
        })
      }

      function toggleCollapse(id) {
        setCollapsedIds(function (current) {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      function expandAll() {
        setCollapsedIds(new Set())
      }

      function collapseAll() {
        const next = new Set()
        for (let i = 0; i < rows.length; i += 1) {
          if (rows[i].hasChildren && rows[i].depth > 1) next.add(rows[i].id)
        }
        setCollapsedIds(next)
      }

      function onNodeClick(node) {
        if (movedRef.current) return
        setSelectedId(node.id)
        if (node.childCount > 0) toggleCollapse(node.id)
      }

      function onNodeKeyDown(event, node) {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        onNodeClick(node)
      }

      function onRowActivate(row) {
        setSelectedId(row.id)
        if (row.hasChildren) toggleCollapse(row.id)
      }

      function onRowKeyDown(event, row) {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        onRowActivate(row)
      }

      function onDragStart(event) {
        if (event.button != null && event.button !== 0) return
        movedRef.current = false
        dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
        if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function' && event.pointerId != null) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch (error) {
            /* ignore */
          }
        }
      }

      function onDragMove(event) {
        const drag = dragRef.current
        if (!drag) return
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true
        setPan({ x: drag.panX + dx, y: drag.panY + dy })
      }

      function onDragEnd() {
        dragRef.current = null
      }

      function button(label, onClick, options) {
        const opts = options || {}
        return h(
          'button',
          {
            type: 'button',
            'aria-label': opts.ariaLabel || label,
            'aria-pressed': typeof opts.pressed === 'boolean' ? opts.pressed : undefined,
            title: opts.title || opts.ariaLabel || label,
            onClick: onClick,
            style: merge(merge(css.button, opts.iconOnly ? css.buttonIcon : null), opts.active ? css.buttonActive : null),
          },
          label
        )
      }

      function renderHeader() {
        const isPreparing = phase === 'preparing'
        const titleText = isPreparing
          ? tr('mindmap.scanning')
          : meta.sheetTitle || baseName(meta.sourcePath) || tr('mindmap.title')
        const badges = []
        if (isTree) {
          badges.push(
            h('span', { key: 'nodes', style: css.badge, 'aria-label': tr('mindmap.nodesUnit') + ' ' + meta.nodeCount },
              meta.nodeCount + ' ' + tr('mindmap.nodesUnit'))
          )
        }
        if (meta.sheetCount > 0) {
          badges.push(
            h('span', { key: 'sheet', style: css.badge },
              tr('mindmap.sheet') + ' ' + (meta.sheetIndex + 1) + '/' + meta.sheetCount)
          )
        }
        if (meta.warningCount > 0) {
          badges.push(
            h('span', { key: 'warn', style: merge(css.badge, css.badgeWarn), 'aria-label': tr('mindmap.warningsUnit') + ' ' + meta.warningCount },
              tr('mindmap.warningsUnit') + ' ' + meta.warningCount)
          )
        }
        return h(
          'button',
          {
            type: 'button',
            style: css.header,
            'aria-expanded': isPreparing ? undefined : !!expanded,
            'aria-label': isPreparing ? tr('mindmap.scanning') : expanded ? tr('mindmap.collapseCard') : tr('mindmap.expandCard'),
            onClick: isPreparing
              ? undefined
              : function () {
                  setExpanded(function (value) {
                    return !value
                  })
                },
          },
          h('span', { style: css.iconBox, 'aria-hidden': 'true' }, iconNode()),
          h('span', { style: css.title, title: titleText }, titleText),
          badges,
          isPreparing
            ? h('span', { style: css.spinner, 'aria-hidden': 'true' }, '…')
            : h('span', { style: css.chevron, 'aria-hidden': 'true' }, expanded ? '▾' : '▸')
        )
      }

      function renderFallback() {
        const text = contentText(block) || tr('mindmap.empty')
        return h(
          'div',
          { style: css.body },
          h('pre', { style: css.markdownPre, 'aria-label': tr('mindmap.markdown') }, text)
        )
      }

      function renderToolbar() {
        return h(
          'div',
          { style: css.toolbar, role: 'toolbar', 'aria-label': tr('mindmap.title') },
          button(tr('mindmap.map'), function () {
            setView('map')
          }, { pressed: view === 'map', ariaLabel: tr('mindmap.map') }),
          button(tr('mindmap.outline'), function () {
            setView('outline')
          }, { pressed: view === 'outline', ariaLabel: tr('mindmap.outline') }),
          h('span', { style: { width: 1, height: 16, background: 'var(--dsw-alias-border-l2, #e4e6eb)' }, 'aria-hidden': 'true' }),
          button(tr('mindmap.fit'), fitView, { ariaLabel: tr('mindmap.fit') }),
          button('−', function () {
            zoomBy(0.9)
          }, { iconOnly: true, ariaLabel: tr('mindmap.zoomOut') }),
          h('span', { style: css.zoomLabel, 'aria-live': 'polite' }, Math.round(zoom * 100) + '%'),
          button('+', function () {
            zoomBy(1.1)
          }, { iconOnly: true, ariaLabel: tr('mindmap.zoomIn') }),
          button(tr('mindmap.expandAll'), expandAll, { ariaLabel: tr('mindmap.expandAll') }),
          button(tr('mindmap.collapseAll'), collapseAll, { ariaLabel: tr('mindmap.collapseAll') }),
          h('span', { style: css.spacer }),
          isPreview
            ? null
            : button(tr('mindmap.mermaid'), function () {
                setShowMermaid(function (value) {
                  return !value
                })
              }, { pressed: showMermaid, ariaLabel: tr('mindmap.mermaid') })
        )
      }

      function renderLinks() {
        const parts = []
        for (let i = 0; i < layout.links.length; i += 1) {
          const link = layout.links[i]
          const from = nodeById[link.from]
          const to = nodeById[link.to]
          if (!from || !to) continue
          const x1 = from.x + from.w
          const y1 = from.y + from.h / 2
          const x2 = to.x
          const y2 = to.y + to.h / 2
          const dx = Math.max(24, (x2 - x1) * 0.55)
          parts.push(
            h('path', {
              key: 'l-' + link.from + '-' + link.to,
              d:
                'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2,
              fill: 'none',
              stroke: 'var(--dsw-alias-border-l4, #c9cdd4)',
              strokeWidth: 1.4,
            })
          )
        }
        return parts
      }

      function renderNodes() {
        const elements = []
        for (let i = 0; i < layout.nodes.length; i += 1) {
          const node = layout.nodes[i]
          const reserved = node.hasNotes ? 34 : 14
          const chars = Math.max(4, Math.floor((node.w - reserved) / 7.2))
          let label = truncate(node.title, chars)
          if (node.hasNotes) label += ' [备注]'
          const textColor = node.depth === 1
            ? 'var(--dsw-alias-label-primary-foreground, #ffffff)'
            : 'var(--dsw-alias-label-primary, #1f2328)'
          const groupChildren = [
            roundRect(node),
            h(
              'text',
              {
                key: 'label',
                x: 12,
                y: Math.round(node.h / 2) + 1,
                dominantBaseline: 'middle',
                fill: textColor,
                fontSize: 12.5,
                style: { pointerEvents: 'none' },
              },
              label
            ),
          ]
          if (node.hasNotes) {
            groupChildren.push(
              h('circle', {
                key: 'notes-dot',
                cx: node.w - 9,
                cy: node.h - 9,
                r: 3,
                fill: 'var(--dsw-alias-state-warn-primary, #d97706)',
                'aria-hidden': 'true',
              })
            )
          }
          if (node.collapsed && node.childCount > 0) {
            groupChildren.push(
              h(
                'g',
                { key: 'collapsed-badge', transform: 'translate(' + (node.w + 11) + ' ' + node.h / 2 + ')' },
                h('circle', { r: 9, fill: 'var(--dsw-alias-bg-layer-3, #eef0f3)', stroke: 'var(--dsw-alias-border-l2, #e4e6eb)' }),
                h(
                  'text',
                  {
                    textAnchor: 'middle',
                    dominantBaseline: 'middle',
                    fill: 'var(--dsw-alias-label-secondary, #6b7280)',
                    fontSize: 10,
                  },
                  '+' + node.childCount
                )
              )
            )
          }
          elements.push(
            h(
              'g',
              {
                key: 'n-' + node.id,
                transform: 'translate(' + node.x + ' ' + node.y + ')',
                role: 'button',
                tabIndex: 0,
                'aria-label': node.title,
                'aria-expanded': node.childCount > 0 ? !node.collapsed : undefined,
                'data-node-id': node.id,
                style: { cursor: 'pointer', outline: 'none' },
                onClick: function () {
                  onNodeClick(node)
                },
                onKeyDown: function (event) {
                  onNodeKeyDown(event, node)
                },
              },
              groupChildren
            )
          )
        }
        return elements
      }

      function roundRect(node) {
        return h('rect', {
          key: 'rect',
          width: node.w,
          height: node.h,
          rx: 8,
          ry: 8,
          fill: node.depth === 1 ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'var(--dsw-alias-bg-layer-1, #ffffff)',
          stroke:
            node.id === selectedId
              ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
              : node.depth === 1
                ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
                : 'var(--dsw-alias-border-l2, #e4e6eb)',
          strokeWidth: node.id === selectedId ? 2 : 1.2,
        })
      }

      function renderSidePanel(row) {
        const children = [h('div', { key: 'title', style: css.sideTitle }, truncate(row.title, MAX_LABEL))]
        if (row.hasNotes) {
          children.push(
            h('div', { key: 'notes', style: css.sideLabel }, tr('mindmap.notes')),
            h('div', { key: 'notes-body', style: css.sideText }, row.notes)
          )
        }
        if (row.href) {
          children.push(
            h('div', { key: 'href', style: css.sideLabel }, tr('mindmap.href')),
            h(
              'a',
              {
                key: 'href-link',
                href: row.href,
                target: '_blank',
                rel: 'noreferrer noopener',
                style: css.link,
              },
              truncate(row.href, 80)
            )
          )
        }
        if (row.labels && row.labels.length) {
          children.push(
            h('div', { key: 'labels', style: css.sideLabel }, tr('mindmap.labels')),
            h(
              'div',
              { key: 'label-row', style: css.chipRow },
              row.labels.map(function (label, index) {
                return h('span', { key: 'label-' + index, style: css.chip }, label)
              })
            )
          )
        }
        if (!row.hasNotes && !row.href && !(row.labels && row.labels.length)) {
          children.push(h('div', { key: 'empty', style: css.muted }, tr('mindmap.noDetails')))
        }
        return h('aside', { style: css.side, 'aria-label': tr('mindmap.details') }, children)
      }

      function renderMap() {
        return h(
          'div',
          { style: isPreview ? merge(css.mapWrap, css.mapWrapPreview) : css.mapWrap },
          h(
            'div',
            {
              ref: wrapRef,
              style: isPreview ? merge(css.viewport, css.viewportPreview) : css.viewport,
              role: 'application',
              'aria-label': tr('mindmap.map'),
              onPointerDown: onDragStart,
              onPointerMove: onDragMove,
              onPointerUp: onDragEnd,
              onPointerCancel: onDragEnd,
            },
            h(
              'svg',
              { width: '100%', height: '100%', style: css.svg, focusable: 'false' },
              h(
                'g',
                { transform: 'translate(' + pan.x + ' ' + pan.y + ') scale(' + zoom + ')' },
                renderLinks(),
                renderNodes()
              )
            )
          ),
          selected ? renderSidePanel(selected) : null
        )
      }

      function visibleOutlineRows() {
        const out = []
        let skipBelow = Infinity
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]
          if (row.depth > skipBelow) continue
          skipBelow = Infinity
          out.push(row)
          if (row.hasChildren && collapsedIds.has(row.id)) skipBelow = row.depth
        }
        return out
      }

      function renderOutline() {
        const visible = visibleOutlineRows()
        return h(
          'div',
          { role: 'tree', 'aria-label': tr('mindmap.outline'), style: isPreview ? merge(css.outline, css.outlinePreview) : css.outline },
          visible.map(function (row) {
            const hasChildren = row.hasChildren
            const isCollapsed = hasChildren && collapsedIds.has(row.id)
            const isSelected = row.id === selectedId
            const rowChildren = [
              h('span', { key: 'toggle', style: css.rowToggle, 'aria-hidden': 'true' }, hasChildren ? (isCollapsed ? '▸' : '▾') : '·'),
              h('span', { key: 'title', style: css.rowTitle, title: row.title }, row.title),
            ]
            if (row.hasNotes) rowChildren.push(h('span', { key: 'notes', style: css.rowBadge }, '[备注]'))
            if (row.href) rowChildren.push(h('span', { key: 'href', style: css.rowBadge }, '↗'))
            if (row.labels && row.labels.length) {
              rowChildren.push(
                h('span', { key: 'labels', style: css.muted }, row.labels.join(' · '))
              )
            }
            return h(
              'div',
              {
                key: row.id,
                role: 'treeitem',
                'aria-level': row.depth,
                'aria-expanded': hasChildren ? !isCollapsed : undefined,
                'aria-selected': isSelected,
                tabIndex: 0,
                style: merge(css.row, {
                  paddingLeft: 10 + (row.depth - 1) * 16,
                  background: isSelected ? 'var(--dsw-alias-interactive-bg-active, #e8edff)' : 'transparent',
                }),
                onClick: function () {
                  onRowActivate(row)
                },
                onKeyDown: function (event) {
                  onRowKeyDown(event, row)
                },
              },
              rowChildren
            )
          })
        )
      }

      function renderMermaidSource() {
        const source = meta.mermaid || ''
        return h(
          'div',
          { style: css.codeBox },
          h(
            'div',
            { style: css.codeHead },
            h('span', { style: css.muted }, tr('mindmap.mermaid')),
            h('span', { style: css.spacer }),
            h(
              'button',
              {
                type: 'button',
                style: css.button,
                'aria-label': tr('mindmap.copy'),
                onClick: function () {
                  copyText(source, function (ok) {
                    setCopied(ok ? 'mermaid' : 'failed')
                  })
                },
              },
              copied === 'mermaid' ? tr('mindmap.copied') : copied === 'failed' ? tr('mindmap.copyFailed') : tr('mindmap.copy')
            )
          ),
          h('pre', { style: css.pre }, source || tr('mindmap.mermaidEmpty'))
        )
      }

      function renderWarnings() {
        if (!meta.warnings.length) return null
        return h(
          'div',
          { style: css.warnings, role: 'note' },
          h('div', { style: css.warnTitle }, tr('mindmap.warnings') + ' (' + meta.warnings.length + ')'),
          h(
            'ul',
            { style: css.warnList },
            meta.warnings.map(function (warning, index) {
              return h('li', { key: 'warn-' + index, style: { margin: '2px 0' } }, warning)
            })
          )
        )
      }

      function renderMarkdownBody() {
        return h(
          'div',
          null,
          h(
            'div',
            { style: css.toolbar },
            h('span', { style: css.muted }, tr('mindmap.markdown')),
            h('span', { style: css.spacer }),
            h(
              'button',
              {
                type: 'button',
                style: css.button,
                'aria-label': tr('mindmap.copy'),
                onClick: function () {
                  copyText(meta.markdown, function (ok) {
                    setCopied(ok ? 'markdown' : 'failed')
                  })
                },
              },
              copied === 'markdown' ? tr('mindmap.copied') : copied === 'failed' ? tr('mindmap.copyFailed') : tr('mindmap.copy')
            )
          ),
          h('pre', { style: css.markdownPre }, meta.markdown || tr('mindmap.empty'))
        )
      }

      function renderTreeBody() {
        return h(
          'div',
          { style: isPreview ? merge(css.body, css.bodyPreview) : css.body },
          renderToolbar(),
          showMermaid ? renderMermaidSource() : null,
          view === 'outline' ? renderOutline() : renderMap(),
          renderWarnings(),
          meta.writtenPath
            ? h('div', { style: css.footer }, tr('mindmap.written') + ': ' + meta.writtenPath)
            : null
        )
      }

      const isPreparing = phase === 'preparing'
      const header = renderHeader()
      if (isPreparing) return h('div', { style: css.card }, header)

      let body
      if (meta.kind === 'markdown' && meta.ok) {
        body = h('div', { style: isPreview ? merge(css.body, css.bodyPreview) : css.body }, renderMarkdownBody(), renderWarnings())
      } else if (meta.ok && isTree) {
        body = renderTreeBody()
      } else {
        body = renderFallback()
      }

      const errorLine =
        block.isError && (typeof block.error === 'string' || (block.error && typeof block.error.message === 'string'))
          ? h('div', { style: css.footer }, tr('mindmap.error') + ': ' + (typeof block.error === 'string' ? block.error : block.error.message))
          : null

      return h(
        'div',
        { style: isPreview ? merge(css.card, css.cardPreview) : css.card },
        header,
        expanded ? body : null,
        expanded ? errorLine : null
      )
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(LOCALE_NAMESPACE, { zh: ZH, en: EN })
      }, 'dsh-xmind-mindmap: dictionaries')

      ctx.slots.inject('tool.call.toolview', function () {
        return TOOL_KEYS.map(function (key) {
          return ctx.slots.register({ name: 'tool.call.toolview', key: key, locale: 'xmind' }, MindmapCard)
        })
      })

      // Right Sidebar document preview for `.xmind`, in bytes-complete mode.
      const tr = makeT(null)
      ctx.effect(function () {
        return ctx.documentPreviews.register({
          id: PREVIEW_ID,
          extensions: ['xmind'],
          binaryExtensions: ['xmind'],
          priority: 'extension',
          title: function () {
            return tr('preview.title')
          },
          loading: 'bytes-complete',
          wrap: false,
        })
      }, 'dsh-xmind-mindmap: xmind preview registration')

      ctx.slots.inject('sidebar.right.tab.document', function () {
        return ctx.slots.register(
          { name: 'sidebar.right.tab.document', key: PREVIEW_ID, locale: LOCALE_NAMESPACE },
          XmindPreviewBody
        )
      })

      // Right Sidebar document preview for `.md` / `.markdown`, rendered as a mindmap.
      // `priority: 'extension'` outranks the host's builtin Markdown text preview, so this
      // renders by default while the builtin stays selectable in the header dropdown.
      // `bytes-complete` (not `text-pages`) because the whole document is needed for the
      // tree: paged mode only loads the first page and the rest arrives on scroll.
      ctx.effect(function () {
        return ctx.documentPreviews.register({
          id: MARKDOWN_PREVIEW_ID,
          extensions: ['md', 'markdown'],
          priority: 'extension',
          title: function () {
            return tr('preview.markdownTitle')
          },
          loading: 'bytes-complete',
          wrap: false,
        })
      }, 'dsh-xmind-mindmap: markdown preview registration')

      ctx.slots.inject('sidebar.right.tab.document', function () {
        return ctx.slots.register(
          { name: 'sidebar.right.tab.document', key: MARKDOWN_PREVIEW_ID, locale: LOCALE_NAMESPACE },
          MarkdownPreviewBody
        )
      })
    }

    return {
      name: 'dsh-xmind-mindmap',
      inject: ['slots', 'locale', 'documentPreviews'],
      apply: apply,
      __internals: {
        layoutTree: layoutTree,
        parseMeta: parseMeta,
        outlineRows: outlineRows,
        escapeLabel: escapeLabel,
        truncate: truncate,
        normalizeLoose: normalizeLoose,
        countNodes: countNodes,
        TOOL_KEYS: TOOL_KEYS,
        PREVIEW_ID: PREVIEW_ID,
        MARKDOWN_PREVIEW_ID: MARKDOWN_PREVIEW_ID,
        MARKDOWN_MAX_BYTES: MARKDOWN_MAX_BYTES,
        parseMarkdownText: parseMarkdownText,
        markdownPreviewPayload: markdownPreviewPayload,
        previewTextOf: previewTextOf,
        previewDocumentText: previewDocumentText,
        MarkdownPreviewBody: MarkdownPreviewBody,
        MARKDOWN_VIEWS: MARKDOWN_VIEWS,
        MindmapCard: MindmapCard,
        readZipEntries: readZipEntries,
        parseXmlLite: parseXmlLite,
        parseXmindBytes: parseXmindBytes,
        parseXmindJsonContent: parseXmindJsonContent,
        parseXmindXmlContent: parseXmindXmlContent,
        previewPayload: previewPayload,
        previewBytesOf: previewBytesOf,
        XmindPreviewBody: XmindPreviewBody,
      },
    }
  },
})
