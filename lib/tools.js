/** Host-side tool definitions (schemas, renderers, client meta, execute logic) for the mindmap plugin. */
import { basename, extname } from 'node:path'

/** Version stamped into every client card payload; bumped on incompatible payload changes. */
export const TOOL_PAYLOAD_VERSION = 1

const TOOL_TIMEOUT_MS = 30000
const MAX_MERMAID_CHARS = 8000
const MAX_OUTLINE_LINES = 40
const MD_RESERIALIZE_WARNING = '已按结构化规则重新序列化 Markdown'
const EDIT_ACTIONS = ['update_title', 'add_child', 'delete_node', 'move_node']

const MODULE_KEYS = ['tree', 'markdown', 'mermaid', 'xmind', 'fsio']
const DEFAULT_MODULE_LOADERS = {
  tree: () => import('./tree.js'),
  markdown: () => import('./markdown.js'),
  mermaid: () => import('./mermaid.js'),
  xmind: () => import('./xmind.js'),
  fsio: () => import('./fsio.js'),
}

/**
 * Build the dependency resolver. Injected modules win; only still-missing modules
 * are loaded through a dynamic import on first use, so unit tests can run with
 * fakes before the real modules exist.
 */
function createDepsResolver(injected) {
  const provided = injected && typeof injected === 'object' ? injected : undefined
  let pending
  return {
    sync: provided,
    get() {
      if (pending === undefined) {
        const missing = MODULE_KEYS.filter(key => !provided || provided[key] === undefined)
        pending = missing.length === 0
          ? Promise.resolve({ ...provided })
          : Promise.all(missing.map(key => DEFAULT_MODULE_LOADERS[key]())).then(loaded => {
            const deps = provided ? { ...provided } : {}
            missing.forEach((key, index) => {
              deps[key] = loaded[index]
            })
            return deps
          })
      }
      return pending
    },
  }
}

/** Throw the cooperative abort reason when the signal is already aborted. */
function checkAbort(signal) {
  if (!signal) return
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted()
    return
  }
  if (signal.aborted !== true) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error(typeof reason === 'string' && reason !== '' ? reason : '操作已取消')
  error.name = 'AbortError'
  throw error
}

/** Children array of a canonical tree node, tolerating malformed input. */
function childrenOf(node) {
  if (!node || typeof node !== 'object') return []
  const children = node.children
  return children && Array.isArray(children.attached) ? children.attached : []
}

/** Display title with the contract's "Untitled" fallback. */
function titleOf(node) {
  if (node && typeof node.title === 'string' && node.title.trim() !== '') return node.title
  return 'Untitled'
}

/** Pre-order walk without recursion; `visit(node, depth)`. */
function walkLocal(root, visit) {
  const stack = [[root, 1]]
  let guard = 0
  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) continue
    const [node, depth] = entry
    if (!node || typeof node !== 'object') continue
    visit(node, depth)
    if ((guard += 1) > 100000) break
    const attached = childrenOf(node)
    for (let index = attached.length - 1; index >= 0; index -= 1) {
      stack.push([attached[index], depth + 1])
    }
  }
}

/** Node count plus notes count for card/render summaries. */
function countTree(root) {
  let nodes = 0
  let notes = 0
  walkLocal(root, node => {
    nodes += 1
    if (typeof node.notes === 'string' && node.notes.trim() !== '') notes += 1
  })
  return { nodes, notes }
}

/** Find one node by id without depending on the injected tree module (render fallback). */
function findNodeLocal(root, id) {
  let found = null
  walkLocal(root, node => {
    if (found === null && node.id === id) found = node
  })
  return found
}

/** Compact text outline used by the edit tool renderer. */
function outlineTree(root, maxLines = MAX_OUTLINE_LINES) {
  const lines = []
  let truncated = false
  const stack = [[root, 1]]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) continue
    const [node, depth] = entry
    if (!node || typeof node !== 'object') continue
    if (lines.length >= maxLines) {
      truncated = true
      break
    }
    lines.push(`${'  '.repeat(Math.max(0, depth - 1))}- ${titleOf(node)}`)
    const attached = childrenOf(node)
    for (let index = attached.length - 1; index >= 0; index -= 1) {
      stack.push([attached[index], depth + 1])
    }
  }
  if (truncated) lines.push('… (大纲已截断)')
  return lines
}

/** Last-resort Mermaid mindmap source used only when lib/mermaid.js is unavailable. */
function fallbackMermaid(root) {
  const lines = ['mindmap']
  let count = 0
  walkLocal(root, (node, depth) => {
    if (count >= 800) {
      if (lines[lines.length - 1] !== '  ... (truncated)') lines.push('  ... (truncated)')
      return
    }
    const labels = Array.isArray(node.labels) ? node.labels.map(label => ` #${label}`).join('') : ''
    const suffix = `${node.notes ? ' [备注]' : ''}${labels}`
    const label = `${titleOf(node)}${suffix}`
      .replace(/[\r\n]+/g, ' ')
      .replace(/[()[\]{}<>"':;#]/g, ' ')
      .trim()
    lines.push(`${' '.repeat(Math.max(1, depth))}${label}`)
    count += 1
  })
  return lines.join('\n')
}

/** Mermaid source via the real module, falling back to a minimal local serializer. */
function mermaidOf(deps, root) {
  if (deps && deps.mermaid && typeof deps.mermaid.treeToMermaid === 'function') {
    try {
      const source = deps.mermaid.treeToMermaid(root)
      if (typeof source === 'string') return source
    } catch {
      // Degrade to the local serializer below.
    }
  }
  return fallbackMermaid(root)
}

/** Cap the Mermaid source embedded in model-facing text blocks. */
function truncateMermaid(source) {
  const value = typeof source === 'string' ? source : ''
  if (value.length <= MAX_MERMAID_CHARS) return value
  return `${value.slice(0, MAX_MERMAID_CHARS)}\n… [mermaid truncated]`
}

/** Client meta cache keyed by the returned value object (replay-safe fallbacks apply). */
const objectMeta = new WeakMap()
/** Client meta cache for the string-valued xmind_to_markdown result, bounded FIFO. */
const markdownMeta = new Map()
const MAX_MARKDOWN_META = 8

/** Attach in-process presentation facts to an object result. */
function rememberObjectMeta(value, meta) {
  if (value && typeof value === 'object') objectMeta.set(value, meta)
}

/** Attach in-process presentation facts to a markdown string result. */
function rememberMarkdownMeta(markdown, meta) {
  if (typeof markdown !== 'string') return
  markdownMeta.delete(markdown)
  markdownMeta.set(markdown, meta)
  while (markdownMeta.size > MAX_MARKDOWN_META) {
    const oldest = markdownMeta.keys().next().value
    markdownMeta.delete(oldest)
  }
}

/** Coerce a value to a string with a fallback. */
function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Coerce a value to a safe integer with a fallback. */
function asInteger(value, fallback = 0) {
  return Number.isInteger(value) ? value : fallback
}

/** Normalize a warnings array to strings only. */
function normalizeWarnings(input) {
  if (!Array.isArray(input)) return []
  return input.map(item => (typeof item === 'string' ? item : String(item)))
}

/** Sheet count from a parseXmindBuffer result, tolerating partial fakes. */
function sheetCountOf(parsed) {
  if (!parsed) return 0
  if (Number.isInteger(parsed.sheetCount) && parsed.sheetCount > 0) return parsed.sheetCount
  if (Array.isArray(parsed.sheets)) return parsed.sheets.length
  return parsed.rootTopic ? 1 : 0
}

/** File name without its extension (used as the Markdown root fallback title). */
function baseNameWithoutExtension(filePath) {
  const name = basename(filePath)
  const extension = extname(name)
  return extension === '' ? name : name.slice(0, -extension.length)
}

/** One Chinese error for an empty action title (shared by update_title/add_child). */
function requireTitle(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('标题不能为空或纯空白')
  return input.trim()
}

/** Insertion index for add_child/move_node: null means append. */
function insertionIndex(rawIndex, length) {
  if (!Number.isInteger(rawIndex)) return null
  if (rawIndex < 0 || rawIndex > length) return null
  return rawIndex
}

/** Ensure `children.attached` exists and return it. */
function ensureAttached(node) {
  if (!node.children || typeof node.children !== 'object') node.children = { attached: [] }
  if (!Array.isArray(node.children.attached)) node.children.attached = []
  return node.children.attached
}

// ---------------------------------------------------------------------------
// Schemas

const ROOT_TOPIC_SCHEMA = { type: 'json', required: true, description: 'Normalized TreeNode of the sheet root topic.' }
const ROOT_TOPIC_SCHEMA_GENERIC = { type: 'json', required: true, description: 'Normalized TreeNode of the resulting root topic.' }
const WARNINGS_SCHEMA = { type: 'array', required: true, items: { type: 'string' } }

/** Output schema shared by markdown_to_mindmap and edit_mindmap_node. */
function treeOutputSchema(rootTopicSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      rootTopic: rootTopicSchema,
      warnings: WARNINGS_SCHEMA,
    },
  }
}

const VIEW_XMIND_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rootTopic: ROOT_TOPIC_SCHEMA,
    sheetTitle: { type: 'string', required: true },
    sheetCount: { type: 'integer', required: true },
    warnings: WARNINGS_SCHEMA,
  },
}

// ---------------------------------------------------------------------------
// Metadata projections (render + presentationMeta read the same facts)

/** Presentation facts for view_xmind. */
function viewMeta(args, value, syncDeps) {
  const supplied = value && typeof value === 'object' ? value : {}
  const cached = value && typeof value === 'object' ? objectMeta.get(value) : undefined
  const root = supplied.rootTopic ?? (cached ? cached.rootTopic : null) ?? null
  const counts = countTree(root)
  const sheetCount = Math.max(1, asInteger(supplied.sheetCount ?? (cached ? cached.sheetCount : undefined), 1))
  const rawIndex = asInteger(cached ? cached.sheetIndex : (args ? args.sheetIndex : undefined), 0)
  return {
    root,
    nodes: counts.nodes,
    notes: counts.notes,
    warnings: normalizeWarnings(supplied.warnings ?? (cached ? cached.warnings : undefined)),
    mermaid: cached && typeof cached.mermaid === 'string' ? cached.mermaid : mermaidOf(syncDeps, root),
    sourcePath: asString(cached ? cached.sourcePath : undefined, asString(args ? args.xmindPath : undefined)),
    format: asString(cached ? cached.format : undefined, 'json'),
    sheetTitle: asString(supplied.sheetTitle ?? (cached ? cached.sheetTitle : undefined), ''),
    sheetCount,
    sheetIndex: Math.min(Math.max(0, rawIndex), sheetCount - 1),
  }
}

/** Presentation facts for markdown_to_mindmap. */
function markdownToolMeta(args, value, syncDeps) {
  const supplied = value && typeof value === 'object' ? value : {}
  const cached = value && typeof value === 'object' ? objectMeta.get(value) : undefined
  const root = supplied.rootTopic ?? (cached ? cached.rootTopic : null) ?? null
  const counts = countTree(root)
  return {
    root,
    nodes: counts.nodes,
    notes: counts.notes,
    warnings: normalizeWarnings(supplied.warnings ?? (cached ? cached.warnings : undefined)),
    mermaid: cached && typeof cached.mermaid === 'string' ? cached.mermaid : mermaidOf(syncDeps, root),
    sourcePath: asString(cached ? cached.sourcePath : undefined, asString(args ? args.mdPath : undefined)),
    writtenPath: asString(cached ? cached.writtenPath : undefined, ''),
    format: 'markdown',
    sheetTitle: asString(cached ? cached.sheetTitle : undefined, titleOf(root)),
    sheetCount: asInteger(cached ? cached.sheetCount : undefined, 1),
    sheetIndex: 0,
  }
}

/** Presentation facts for edit_mindmap_node. */
function editToolMeta(args, value, syncDeps) {
  const supplied = value && typeof value === 'object' ? value : {}
  const cached = value && typeof value === 'object' ? objectMeta.get(value) : undefined
  const root = supplied.rootTopic ?? (cached ? cached.rootTopic : null) ?? null
  const counts = countTree(root)
  const nodeId = asString(cached ? cached.nodeId : undefined, asString(args ? args.nodeId : undefined))
  let nodeTitle = asString(cached ? cached.nodeTitle : undefined, '')
  if (nodeTitle === '' && nodeId !== '' && root) {
    const node = findNodeLocal(root, nodeId)
    if (node) nodeTitle = titleOf(node)
  }
  return {
    root,
    nodes: counts.nodes,
    notes: counts.notes,
    warnings: normalizeWarnings(supplied.warnings ?? (cached ? cached.warnings : undefined)),
    mermaid: cached && typeof cached.mermaid === 'string' ? cached.mermaid : mermaidOf(syncDeps, root),
    sourcePath: asString(cached ? cached.sourcePath : undefined, asString(args ? args.sourcePath : undefined)),
    writtenPath: asString(cached ? cached.writtenPath : undefined, ''),
    format: asString(cached ? cached.format : undefined, ''),
    sheetTitle: asString(cached ? cached.sheetTitle : undefined, titleOf(root)),
    sheetCount: asInteger(cached ? cached.sheetCount : undefined, 1),
    sheetIndex: 0,
    action: asString(cached ? cached.action : undefined, asString(args ? args.action : undefined)),
    nodeId,
    nodeTitle,
  }
}

// ---------------------------------------------------------------------------
// Tool definitions

/** view_xmind: read a workbook and return its normalized tree. */
function viewXmindDefinition(resolver) {
  return {
    name: 'view_xmind',
    description: 'Read an .xmind workbook (XMind 2020+ content.json or XMind 8 content.xml) and render its topic tree as an interactive read-only mindmap card in the chat. 读取 .xmind 文件并在聊天中直接渲染可交互导图卡片。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      xmindPath: { type: 'string', required: true, description: 'Absolute path to the .xmind file.' },
      sheetIndex: { type: 'integer', description: '0-based sheet index; default 0.' },
    },
    output: {
      schema: VIEW_XMIND_OUTPUT,
      render(args, value) {
        const meta = viewMeta(args, value, resolver.sync)
        const lines = [`XMind: ${meta.sheetTitle} (sheet ${meta.sheetIndex + 1}/${meta.sheetCount}) · ${meta.nodes} nodes · ${meta.notes} notes`]
        if (meta.warnings.length > 0) lines.push(...meta.warnings.map(warning => `- ${warning}`))
        const text = `${lines.join('\n')}\n\n\`\`\`mermaid\n${truncateMermaid(meta.mermaid)}\n\`\`\``
        const blocks = [{ type: 'text', text }]
        if (meta.sheetCount > 1) {
          blocks.push({ type: 'text', text: `提示：该文件共有 ${meta.sheetCount} 个 Sheet；调用 view_xmind 并传 sheetIndex 可切换。` })
        }
        return blocks
      },
      presentationMeta(args, value) {
        const meta = viewMeta(args, value, resolver.sync)
        return {
          v: TOOL_PAYLOAD_VERSION,
          kind: 'tree',
          sourcePath: meta.sourcePath,
          format: meta.format,
          sheetTitle: meta.sheetTitle,
          sheetCount: meta.sheetCount,
          sheetIndex: meta.sheetIndex,
          rootTopic: meta.root,
          mermaid: meta.mermaid,
          warnings: meta.warnings,
        }
      },
    },
    async execute(args, exec) {
      const deps = await resolver.get()
      const fsio = deps.fsio
      const signal = exec ? exec.signal : undefined
      checkAbort(signal)
      const xmindPath = fsio.resolveAbsolute(args.xmindPath, { ext: ['.xmind'], kind: 'file', label: 'xmindPath' })
      const requested = args.sheetIndex === undefined ? 0 : args.sheetIndex
      if (!Number.isInteger(requested) || requested < 0) throw new Error('sheetIndex 必须是非负整数')
      checkAbort(signal)
      const buffer = await fsio.readBuffer(xmindPath, signal)
      checkAbort(signal)
      if (requested > 0) {
        const probe = await deps.xmind.parseXmindBuffer(buffer, { sheetIndex: 0, warnings: [] })
        checkAbort(signal)
        const total = sheetCountOf(probe)
        if (requested >= total) {
          throw new Error(`sheetIndex 超出范围：该文件只有 ${total} 个 Sheet（有效范围 0..${Math.max(0, total - 1)}）`)
        }
      }
      const warnings = []
      const parsed = await deps.xmind.parseXmindBuffer(buffer, { sheetIndex: requested, warnings })
      checkAbort(signal)
      if (!parsed || !parsed.rootTopic) throw new Error('该 .xmind 文件不包含任何 Sheet')
      const sheetCount = Math.max(sheetCountOf(parsed), requested + 1)
      const value = {
        rootTopic: parsed.rootTopic,
        sheetTitle: asString(parsed.sheetTitle, ''),
        sheetCount,
        warnings: normalizeWarnings(warnings.length > 0 ? warnings : parsed.warnings),
      }
      checkAbort(signal)
      rememberObjectMeta(value, {
        sourcePath: xmindPath,
        format: asString(parsed.format, 'json'),
        sheetTitle: value.sheetTitle,
        sheetCount,
        sheetIndex: requested,
        rootTopic: value.rootTopic,
        mermaid: mermaidOf(deps, value.rootTopic),
        warnings: value.warnings,
      })
      return value
    },
  }
}

/** markdown_to_mindmap: parse Markdown into the shared tree, optionally writing .xmind. */
function markdownToMindmapDefinition(resolver) {
  return {
    name: 'markdown_to_mindmap',
    description: 'Convert a Markdown file to the shared tree schema; optionally write an .xmind workbook. 将 Markdown 转换为树形导图；可选写出 .xmind。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      mdPath: { type: 'string', required: true, description: 'Absolute path to the Markdown file.' },
      outputXmindPath: { type: 'string', description: 'Optional absolute path for the .xmind workbook to write.' },
    },
    output: {
      schema: treeOutputSchema(ROOT_TOPIC_SCHEMA_GENERIC),
      render(args, value) {
        const meta = markdownToolMeta(args, value, resolver.sync)
        const lines = [`Markdown 导图: ${titleOf(meta.root)} · ${meta.nodes} nodes`]
        if (meta.warnings.length > 0) lines.push(...meta.warnings.map(warning => `- ${warning}`))
        let text = `${lines.join('\n')}\n\n\`\`\`mermaid\n${truncateMermaid(meta.mermaid)}\n\`\`\``
        if (meta.writtenPath !== '') text += `\n\n已写出: ${meta.writtenPath}`
        return [{ type: 'text', text }]
      },
      presentationMeta(args, value) {
        const meta = markdownToolMeta(args, value, resolver.sync)
        return {
          v: TOOL_PAYLOAD_VERSION,
          kind: 'tree',
          sourcePath: meta.sourcePath,
          format: 'markdown',
          sheetTitle: meta.sheetTitle,
          sheetCount: meta.sheetCount,
          sheetIndex: meta.sheetIndex,
          rootTopic: meta.root,
          mermaid: meta.mermaid,
          warnings: meta.warnings,
          writtenPath: meta.writtenPath,
        }
      },
    },
    async execute(args, exec) {
      const deps = await resolver.get()
      const fsio = deps.fsio
      const signal = exec ? exec.signal : undefined
      checkAbort(signal)
      const mdPath = fsio.resolveAbsolute(args.mdPath, { ext: ['.md'], kind: 'file', label: 'mdPath' })
      checkAbort(signal)
      const buffer = await fsio.readBuffer(mdPath, signal)
      checkAbort(signal)
      const warnings = []
      const parsed = deps.markdown.parseMarkdown(buffer.toString('utf8'), {
        fileName: baseNameWithoutExtension(mdPath),
        warnings,
      })
      checkAbort(signal)
      if (!parsed || !parsed.root) throw new Error('Markdown 解析未返回根节点')
      const rootTopic = parsed.root
      const outWarnings = Array.isArray(parsed.warnings) ? parsed.warnings : warnings
      let writtenPath = ''
      if (typeof args.outputXmindPath === 'string' && args.outputXmindPath.trim() !== '') {
        const outputPath = fsio.resolveAbsolute(args.outputXmindPath, { ext: ['.xmind'], kind: 'file', label: 'outputXmindPath' })
        checkAbort(signal)
        const xmindBuffer = deps.xmind.buildXmindBuffer(rootTopic, { sheetTitle: titleOf(rootTopic), warnings: outWarnings })
        checkAbort(signal)
        await fsio.writeIfAbsentOrSame(outputPath, xmindBuffer, signal)
        checkAbort(signal)
        writtenPath = outputPath
      }
      const value = { rootTopic, warnings: outWarnings }
      checkAbort(signal)
      rememberObjectMeta(value, {
        sourcePath: mdPath,
        writtenPath,
        format: 'markdown',
        sheetTitle: titleOf(rootTopic),
        sheetCount: 1,
        sheetIndex: 0,
        rootTopic,
        mermaid: mermaidOf(deps, rootTopic),
        warnings: outWarnings,
      })
      return value
    },
  }
}

/** edit_mindmap_node: load a tree, apply one structural edit, guard-write it back. */
function editMindmapNodeDefinition(resolver) {
  return {
    name: 'edit_mindmap_node',
    description: 'Incrementally edit one node of a tree loaded from .xmind or .md (update_title / add_child / delete_node / move_node) and return the edited full tree. 增量编辑导图节点，不重写整个文件。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      sourcePath: { type: 'string', required: true, description: 'Absolute .xmind or .md path.' },
      nodeId: { type: 'string', required: true, description: 'Id of the node to edit.' },
      action: { type: 'string', required: true, enum: EDIT_ACTIONS, description: 'Edit action to apply.' },
      payload: {
        type: 'object',
        additionalProperties: true,
        description: 'Action payload: title / notes / href / labels / parentId / index.',
        properties: {
          title: { type: 'string' },
          notes: { type: 'string' },
          href: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          parentId: { type: 'string' },
          index: { type: 'integer' },
        },
      },
    },
    output: {
      schema: treeOutputSchema(ROOT_TOPIC_SCHEMA_GENERIC),
      render(args, value) {
        const meta = editToolMeta(args, value, resolver.sync)
        const lines = [`已编辑: ${meta.action} · ${meta.nodeId} → ${meta.nodeTitle}`, ...outlineTree(meta.root)]
        if (meta.warnings.length > 0) lines.push('', ...meta.warnings.map(warning => `- ${warning}`))
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta(args, value) {
        const meta = editToolMeta(args, value, resolver.sync)
        return {
          v: TOOL_PAYLOAD_VERSION,
          kind: 'tree',
          sourcePath: meta.sourcePath,
          format: meta.format,
          sheetTitle: meta.sheetTitle,
          sheetCount: meta.sheetCount,
          sheetIndex: meta.sheetIndex,
          rootTopic: meta.root,
          mermaid: meta.mermaid,
          warnings: meta.warnings,
          action: meta.action,
          nodeId: meta.nodeId,
          writtenPath: meta.writtenPath,
        }
      },
    },
    async execute(args, exec) {
      const deps = await resolver.get()
      const fsio = deps.fsio
      const tree = deps.tree
      const signal = exec ? exec.signal : undefined
      checkAbort(signal)
      const action = args.action
      if (!EDIT_ACTIONS.includes(action)) throw new Error(`不支持的操作: ${action}`)
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId : ''
      if (nodeId === '') throw new Error('节点 id 不能为空')
      const sourcePath = fsio.resolveAbsolute(args.sourcePath, { ext: ['.xmind', '.md'], kind: 'file', label: 'sourcePath' })
      const format = extname(sourcePath).toLowerCase() === '.xmind' ? 'xmind' : 'markdown'
      const payload = args.payload && typeof args.payload === 'object' ? args.payload : {}

      checkAbort(signal)
      const baseline = await fsio.readBaseline(sourcePath, signal)
      checkAbort(signal)
      const raw = await fsio.readBuffer(sourcePath, signal)
      checkAbort(signal)
      if (!baseline || typeof baseline.sha256 !== 'string' || fsio.sha256(raw) !== baseline.sha256) {
        throw new Error(`目标文件在读取后已被修改，已拒绝覆盖: ${sourcePath}`)
      }

      let warnings = []
      let root
      let sheetTitle = ''
      if (format === 'xmind') {
        const parsed = deps.xmind.parseXmindBuffer(raw, { sheetIndex: 0, warnings })
        checkAbort(signal)
        if (!parsed || !parsed.rootTopic) throw new Error('该 .xmind 文件不包含任何 Sheet')
        const totalSheets = Math.max(1, sheetCountOf(parsed))
        if (totalSheets > 1) {
          throw new Error(`该 .xmind 包含 ${totalSheets} 个 Sheet，edit_mindmap_node 目前只支持编辑单 Sheet 文件（避免丢失其他 Sheet）；请先拆分文件或使用 XMind 客户端编辑`)
        }
        root = tree.cloneTree(parsed.rootTopic)
        sheetTitle = asString(parsed.sheetTitle, '') || titleOf(root)
        warnings = Array.isArray(parsed.warnings) ? parsed.warnings : warnings
      } else {
        const parsed = deps.markdown.parseMarkdown(raw.toString('utf8'), {
          fileName: baseNameWithoutExtension(sourcePath),
          warnings,
        })
        checkAbort(signal)
        if (!parsed || !parsed.root) throw new Error('Markdown 解析未返回根节点')
        root = tree.cloneTree(parsed.root)
        sheetTitle = titleOf(root)
        warnings = Array.isArray(parsed.warnings) ? parsed.warnings : warnings
      }

      let reportTitle = ''
      if (action === 'update_title') {
        const found = tree.findNode(root, nodeId)
        if (!found) throw new Error(`未找到节点: ${nodeId}`)
        const title = requireTitle(payload.title)
        found.node.title = title
        reportTitle = title
      } else if (action === 'add_child') {
        const found = tree.findNode(root, nodeId)
        if (!found) throw new Error(`未找到节点: ${nodeId}`)
        const title = requireTitle(payload.title)
        const partial = { id: tree.generateId(tree.collectIds(root), 'n'), title }
        if (typeof payload.notes === 'string' && payload.notes.trim() !== '') partial.notes = payload.notes
        if (typeof payload.href === 'string' && payload.href.trim() !== '') partial.href = payload.href
        if (Array.isArray(payload.labels)) {
          const labels = payload.labels
            .filter(label => typeof label === 'string' && label.trim() !== '')
            .map(label => label.trim())
          if (labels.length > 0) partial.labels = [...new Set(labels)]
        }
        const child = tree.createNode(partial)
        const siblings = ensureAttached(found.node)
        const index = insertionIndex(payload.index, siblings.length)
        if (index === null) siblings.push(child)
        else siblings.splice(index, 0, child)
        reportTitle = title
      } else if (action === 'delete_node') {
        const found = tree.findNode(root, nodeId)
        if (!found) throw new Error(`未找到节点: ${nodeId}`)
        if (found.parent === null || found.node === root || found.node.id === root.id) {
          throw new Error('不能删除根节点')
        }
        reportTitle = titleOf(found.node)
        const siblings = ensureAttached(found.parent)
        const position = siblings.indexOf(found.node)
        if (position >= 0) siblings.splice(position, 1)
        else if (Number.isInteger(found.index) && siblings[found.index] === found.node) siblings.splice(found.index, 1)
        else throw new Error(`未找到节点: ${nodeId}`)
      } else {
        const parentId = typeof payload.parentId === 'string' ? payload.parentId.trim() : ''
        if (parentId === '') throw new Error('move_node 需要提供 payload.parentId')
        const target = tree.findNode(root, nodeId)
        if (!target) throw new Error(`未找到节点: ${nodeId}`)
        if (target.parent === null || target.node === root || target.node.id === root.id) {
          throw new Error('不能移动根节点')
        }
        if (parentId === nodeId) throw new Error('不能把节点移动到它自己的子树下')
        const parent = tree.findNode(root, parentId)
        if (!parent) throw new Error(`未找到目标父节点: ${parentId}`)
        const stack = [target.node]
        let intoOwnSubtree = false
        while (stack.length > 0) {
          checkAbort(signal)
          const current = stack.pop()
          if (!current || typeof current !== 'object') continue
          if (current === parent.node || (typeof current.id === 'string' && current.id === parentId)) {
            intoOwnSubtree = true
            break
          }
          const attached = childrenOf(current)
          for (const child of attached) stack.push(child)
        }
        if (intoOwnSubtree) throw new Error('不能把节点移动到它自己的子树下')
        const oldSiblings = ensureAttached(target.parent)
        const oldPosition = oldSiblings.indexOf(target.node)
        if (oldPosition < 0) throw new Error(`未找到节点: ${nodeId}`)
        oldSiblings.splice(oldPosition, 1)
        const newSiblings = ensureAttached(parent.node)
        const index = insertionIndex(payload.index, newSiblings.length)
        if (index === null) newSiblings.push(target.node)
        else newSiblings.splice(index, 0, target.node)
        reportTitle = titleOf(target.node)
      }

      checkAbort(signal)
      if (typeof tree.assertTree === 'function') tree.assertTree(root)
      if (!root || typeof root.id !== 'string' || root.id === '') throw new Error('编辑后的树缺少根节点')
      if (typeof tree.collectIds === 'function') {
        const total = countTree(root).nodes
        if (tree.collectIds(root).size !== total) throw new Error('编辑后的树存在重复的节点 id')
      }
      if (typeof tree.findNode === 'function' && !tree.findNode(root, root.id)) {
        throw new Error('编辑后的树缺少根节点')
      }

      let data
      if (format === 'xmind') {
        checkAbort(signal)
        data = deps.xmind.buildXmindBuffer(root, { sheetTitle: sheetTitle || titleOf(root), warnings })
        checkAbort(signal)
      } else {
        checkAbort(signal)
        data = deps.markdown.treeToMarkdown(root)
        warnings.push(MD_RESERIALIZE_WARNING)
        checkAbort(signal)
      }
      await fsio.writeGuarded(sourcePath, data, baseline, signal)
      checkAbort(signal)

      const value = { rootTopic: root, warnings }
      rememberObjectMeta(value, {
        sourcePath,
        writtenPath: sourcePath,
        format,
        sheetTitle: sheetTitle || titleOf(root),
        sheetCount: 1,
        sheetIndex: 0,
        rootTopic: root,
        mermaid: mermaidOf(deps, root),
        warnings,
        action,
        nodeId,
        nodeTitle: reportTitle,
      })
      return value
    },
  }
}

/** xmind_to_markdown: canonical value is the Markdown text itself. */
function xmindToMarkdownDefinition(resolver) {
  return {
    name: 'xmind_to_markdown',
    description: 'Convert an .xmind workbook to Markdown; optionally write the .md file. 将 .xmind 转换为 Markdown；可选写回 .md 文件。',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      xmindPath: { type: 'string', required: true, description: 'Absolute path to the .xmind file.' },
      outputMdPath: { type: 'string', description: 'Optional absolute path for the .md file to write.' },
    },
    output: {
      schema: { type: 'string' },
      render(args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : '' }]
      },
      presentationMeta(args, value) {
        const markdown = typeof value === 'string' ? value : ''
        const cached = markdownMeta.get(markdown)
        return {
          v: TOOL_PAYLOAD_VERSION,
          kind: 'markdown',
          sourcePath: asString(cached ? cached.sourcePath : undefined, asString(args ? args.xmindPath : undefined)),
          writtenPath: asString(cached ? cached.writtenPath : undefined, ''),
          markdown,
          sheetTitle: asString(cached ? cached.sheetTitle : undefined, ''),
          sheetCount: asInteger(cached ? cached.sheetCount : undefined, 1),
          warnings: normalizeWarnings(cached ? cached.warnings : undefined),
        }
      },
    },
    async execute(args, exec) {
      const deps = await resolver.get()
      const fsio = deps.fsio
      const signal = exec ? exec.signal : undefined
      checkAbort(signal)
      const xmindPath = fsio.resolveAbsolute(args.xmindPath, { ext: ['.xmind'], kind: 'file', label: 'xmindPath' })
      checkAbort(signal)
      const buffer = await fsio.readBuffer(xmindPath, signal)
      checkAbort(signal)
      const parsed = await deps.xmind.parseXmindBuffer(buffer, { sheetIndex: 0, warnings: [] })
      checkAbort(signal)
      if (!parsed || !parsed.rootTopic) throw new Error('该 .xmind 文件不包含任何 Sheet')
      checkAbort(signal)
      const markdown = deps.markdown.treeToMarkdown(parsed.rootTopic)
      checkAbort(signal)
      if (typeof markdown !== 'string') throw new Error('Markdown 序列化失败')
      const warnings = normalizeWarnings(parsed.warnings)
      let writtenPath = ''
      if (typeof args.outputMdPath === 'string' && args.outputMdPath.trim() !== '') {
        const outputPath = fsio.resolveAbsolute(args.outputMdPath, { ext: ['.md'], kind: 'file', label: 'outputMdPath' })
        checkAbort(signal)
        await fsio.writeIfAbsentOrSame(outputPath, markdown, signal)
        checkAbort(signal)
        writtenPath = outputPath
      }
      rememberMarkdownMeta(markdown, {
        sourcePath: xmindPath,
        writtenPath,
        sheetTitle: asString(parsed.sheetTitle, ''),
        sheetCount: Math.max(1, sheetCountOf(parsed)),
        warnings,
      })
      return markdown
    },
  }
}

/**
 * Create the four host tool option objects. `deps` may inject fakes; any missing
 * module is loaded on first execute through a cached dynamic import.
 * @param {{ deps?: { tree?: object, markdown?: object, mermaid?: object, xmind?: object, fsio?: object }, config?: object }} [opts]
 * @returns {Array<object>} plain definition objects, ready for defineTool().
 */
export function createToolDefinitions(opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const resolver = createDepsResolver(options.deps)
  return [
    viewXmindDefinition(resolver),
    markdownToMindmapDefinition(resolver),
    editMindmapNodeDefinition(resolver),
    xmindToMarkdownDefinition(resolver),
  ]
}
