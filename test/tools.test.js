/** Tests for the four hosted tool definitions: schemas, renderers, client meta, and execute logic. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToolDefinitions, TOOL_PAYLOAD_VERSION } from '../lib/tools.js'
import { resolveAbsolute, sha256, throwIfAborted } from '../lib/fsio.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const VROOT = resolve(TEST_DIR, '.tmp', 'tools-virtual')

/** Absolute virtual .xmind path (the fake fsio never touches the real disk). */
function virtualXmind(name) {
  return resolveAbsolute(join(VROOT, name), { ext: ['.xmind'], kind: 'file', label: 'xmindPath' })
}

/** Absolute virtual .md path (the fake fsio never touches the real disk). */
function virtualMd(name) {
  return resolveAbsolute(join(VROOT, name), { ext: ['.md'], kind: 'file', label: 'mdPath' })
}

/** The canonical sample tree used across tests (4 nodes, 2 notes). */
function sampleRoot() {
  return {
    id: 'root',
    title: 'Root',
    notes: '根备注',
    children: {
      attached: [
        {
          id: 'a',
          title: 'A',
          children: {
            attached: [{ id: 'a1', title: 'A1', notes: 'A1 备注', children: { attached: [] } }],
          },
        },
        { id: 'b', title: 'B', labels: ['x'], children: { attached: [] } },
      ],
    },
  }
}

/** A flat tree big enough to force the edit outline truncation marker. */
function wideRoot() {
  const root = { id: 'root', title: 'Wide', children: { attached: [] } }
  for (let index = 1; index <= 50; index += 1) {
    root.children.attached.push({ id: `n-${index}`, title: `Node ${index}`, children: { attached: [] } })
  }
  return root
}

/** Children array helper for the fakes. */
function childrenOf(node) {
  return node && node.children && Array.isArray(node.children.attached) ? node.children.attached : []
}

/** Pre-order walk helper for the fakes. */
function walkTree(root, visit) {
  const stack = [[root, 1]]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) continue
    const [node, depth] = entry
    if (!node || typeof node !== 'object') continue
    visit(node, depth)
    const attached = childrenOf(node)
    for (let index = attached.length - 1; index >= 0; index -= 1) stack.push([attached[index], depth + 1])
  }
}

/** Minimal tree fake matching the CONTRACT lib/tree.js interface subset used by tools. */
function createFakeTree(overrides = {}) {
  const tree = {
    createNode(partial = {}) {
      const node = { id: partial.id, title: partial.title, children: { attached: [] } }
      if (partial.notes) node.notes = partial.notes
      if (partial.href) node.href = partial.href
      if (Array.isArray(partial.labels) && partial.labels.length > 0) node.labels = partial.labels
      return node
    },
    findNode(root, id) {
      let result = null
      const search = (node, parent, index, depth) => {
        if (result !== null || !node || typeof node !== 'object') return
        if (node.id === id) {
          result = { node, parent, index, depth }
          return
        }
        const attached = childrenOf(node)
        attached.forEach((child, childIndex) => {
          if (result === null) search(child, node, childIndex, depth + 1)
        })
      }
      search(root, null, -1, 1)
      return result
    },
    collectIds(root) {
      const ids = new Set()
      walkTree(root, node => {
        ids.add(node.id)
      })
      return ids
    },
    generateId(existing, prefix = 'n') {
      let index = existing.size + 1
      while (existing.has(`${prefix}-${index}`)) index += 1
      return `${prefix}-${index}`
    },
    cloneTree(root) {
      return structuredClone(root)
    },
    countNodes(root) {
      let count = 0
      walkTree(root, () => {
        count += 1
      })
      return count
    },
    countWithField(root, field) {
      let count = 0
      walkTree(root, node => {
        if (typeof node[field] === 'string' && node[field] !== '') count += 1
      })
      return count
    },
    assertTree(root) {
      if (!root || typeof root.id !== 'string' || root.id === '') throw new Error('invalid tree: missing root id')
      const seen = new Set()
      const walk = node => {
        if (!node || typeof node.id !== 'string' || node.id === '') throw new Error('invalid tree: bad node id')
        if (seen.has(node.id)) throw new Error(`invalid tree: duplicate id ${node.id}`)
        seen.add(node.id)
        if (typeof node.title !== 'string' || node.title.trim() === '') throw new Error('invalid tree: empty title')
        if (!node.children || !Array.isArray(node.children.attached)) throw new Error('invalid tree: children.attached')
        for (const child of node.children.attached) walk(child)
      }
      walk(root)
    },
  }
  return Object.assign(tree, overrides)
}

/** Minimal Markdown fake: one configurable root, deterministic serialization. */
function createFakeMarkdown(root) {
  const markdown = {
    currentRoot: root,
    lastFileName: '',
    lastText: '',
    parseMarkdown(text, opts = {}) {
      markdown.lastText = text
      markdown.lastFileName = opts.fileName
      if (Array.isArray(opts.warnings)) opts.warnings.push('Markdown 降级元素')
      return {
        root: structuredClone(markdown.currentRoot),
        warnings: Array.isArray(opts.warnings) ? opts.warnings : [],
      }
    },
    treeToMarkdown(node) {
      return `# ${node.title}`
    },
  }
  return markdown
}

/** Minimal xmind fake backed by a JSON "workbook" representation. */
function createFakeXmind() {
  const state = { parseCalls: [], built: [] }
  const xmind = {
    state,
    parseXmindBuffer(buffer, opts = {}) {
      const sheetIndex = opts.sheetIndex ?? 0
      state.parseCalls.push(sheetIndex)
      let data
      try {
        data = JSON.parse(Buffer.from(buffer).toString('utf8'))
      } catch {
        throw new Error('损坏的 .xmind 数据')
      }
      if (!data || !Array.isArray(data.sheets) || data.sheets.length === 0) {
        throw new Error('该 .xmind 文件不包含任何 Sheet')
      }
      const sheet = data.sheets[sheetIndex]
      if (!sheet) throw new Error(`Sheet 索引超出范围: ${sheetIndex}`)
      return {
        rootTopic: structuredClone(sheet.root),
        sheetTitle: sheet.title,
        sheetCount: data.sheets.length,
        sheets: data.sheets.map((item, index) => ({ id: `sheet-${index}`, title: item.title })),
        format: 'json',
        warnings: Array.isArray(opts.warnings) ? opts.warnings : [],
      }
    },
    buildXmindBuffer(root, opts = {}) {
      const sheetTitle = typeof opts.sheetTitle === 'string' && opts.sheetTitle !== '' ? opts.sheetTitle : 'Sheet 1'
      const buffer = Buffer.from(JSON.stringify({ sheets: [{ title: sheetTitle, root: structuredClone(root) }] }), 'utf8')
      state.built.push({ sheetTitle, root: structuredClone(root) })
      return buffer
    },
  }
  return xmind
}

/** Coerce fake write payloads to Buffers. */
function toFakeBuffer(data) {
  if (Buffer.isBuffer(data)) return Buffer.from(data)
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  throw new TypeError('写入内容必须是字符串或 Buffer')
}

/** In-memory fsio fake; resolveAbsolute/sha256/throwIfAborted are the real implementations. */
function createFakeFsio(seed = {}) {
  const files = new Map()
  for (const [key, raw] of Object.entries(seed)) {
    files.set(key, Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(String(raw), 'utf8'))
  }
  const state = {
    reads: 0,
    writes: 0,
    writeGuardCalls: 0,
    staleBaseline: false,
    failWriteGuard: false,
  }
  const fake = {
    files,
    state,
    resolveAbsolute(input, opts = {}) {
      return resolveAbsolute(input, opts)
    },
    sha256,
    throwIfAborted,
    async readBuffer(filePath, signal) {
      state.reads += 1
      throwIfAborted(signal)
      if (!files.has(filePath)) {
        const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`)
        error.code = 'ENOENT'
        throw error
      }
      return Buffer.from(files.get(filePath))
    },
    async readUtf8(filePath, signal) {
      return (await fake.readBuffer(filePath, signal)).toString('utf8')
    },
    async readBaseline(filePath, signal) {
      throwIfAborted(signal)
      const data = await fake.readBuffer(filePath, signal)
      return {
        sha256: state.staleBaseline ? 'stale-hash' : sha256(data),
        size: data.length,
        mtimeMs: 1234,
      }
    },
    async assertBaseline(filePath, baseline, signal) {
      throwIfAborted(signal)
      const data = await fake.readBuffer(filePath, signal)
      if (!baseline || baseline.sha256 !== sha256(data)) {
        throw new Error(`目标文件在读取后已被修改，已拒绝覆盖: ${filePath}`)
      }
    },
    async writeIfAbsentOrSame(filePath, data, signal) {
      throwIfAborted(signal)
      const buffer = toFakeBuffer(data)
      if (files.has(filePath)) {
        if (files.get(filePath).equals(buffer)) return { written: false, existed: true }
        throw new Error(`目标文件已存在且内容不同，已拒绝覆盖: ${filePath}`)
      }
      files.set(filePath, buffer)
      state.writes += 1
      return { written: true, existed: false }
    },
    async writeGuarded(filePath, data, baseline, signal) {
      state.writeGuardCalls += 1
      throwIfAborted(signal)
      if (state.failWriteGuard) throw new Error(`目标文件在读取后已被修改，已拒绝覆盖: ${filePath}`)
      await fake.assertBaseline(filePath, baseline, signal)
      files.set(filePath, toFakeBuffer(data))
      state.writes += 1
      return { written: true, existed: true }
    },
  }
  return fake
}

/** Assemble one isolated tool harness with injected fakes. */
function buildHarness(config = {}) {
  const fsio = createFakeFsio(config.seed)
  const tree = createFakeTree(config.treeOverrides)
  const markdown = createFakeMarkdown(config.markdownRoot ?? sampleRoot())
  const mermaid = config.mermaid ?? {
    treeToMermaid(node) {
      return `mindmap\n  ${node.title}`
    },
  }
  const xmind = config.xmind ?? createFakeXmind()
  const deps = { tree, markdown, mermaid, xmind, fsio, ...(config.deps ?? {}) }
  const definitions = createToolDefinitions({ deps })
  return {
    definitions,
    deps,
    fsio,
    tree,
    markdown,
    mermaid,
    xmind,
    definition(name) {
      const found = definitions.find(item => item.name === name)
      assert.ok(found, `missing definition ${name}`)
      return found
    },
    async run(name, args, signal) {
      return this.definition(name).execute(args, signal === undefined ? {} : { signal })
    },
  }
}

/** Seed a JSON-backed virtual .xmind file. */
function seedXmind(harness, filePath, sheets) {
  harness.fsio.files.set(filePath, Buffer.from(JSON.stringify({ sheets }), 'utf8'))
  return filePath
}

/** Parse a written virtual .xmind file through the fake reader. */
function readXmind(harness, filePath) {
  return harness.xmind.parseXmindBuffer(harness.fsio.files.get(filePath), { sheetIndex: 0 })
}

/** Render helper for one definition. */
function render(harness, name, args, value) {
  return harness.definition(name).output.render(args, value)
}

/** presentationMeta helper for one definition. */
function meta(harness, name, args, value) {
  return harness.definition(name).output.presentationMeta(args, value)
}

/** Collect every object-typed node in an author value schema. */
function collectObjectSchemas(node, path = 'schema', out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'object') {
    out.push({ path, node })
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      collectObjectSchemas(child, `${path}.properties.${key}`, out)
    }
  } else if (node.type === 'array') {
    collectObjectSchemas(node.items, `${path}.items`, out)
  } else if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((child, index) => collectObjectSchemas(child, `${path}.oneOf[${index}]`, out))
  }
  return out
}

test('tool definitions expose the frozen names, descriptions, parameters and schemas', () => {
  const harness = buildHarness()
  assert.equal(TOOL_PAYLOAD_VERSION, 1)
  assert.deepEqual(harness.definitions.map(definition => definition.name), [
    'view_xmind',
    'markdown_to_mindmap',
    'edit_mindmap_node',
    'xmind_to_markdown',
  ])

  const expectedDescriptions = {
    view_xmind: 'Read an .xmind workbook (XMind 2020+ content.json or XMind 8 content.xml) and render its topic tree as an interactive read-only mindmap card in the chat. 读取 .xmind 文件并在聊天中直接渲染可交互导图卡片。',
    markdown_to_mindmap: 'Convert a Markdown file to the shared tree schema; optionally write an .xmind workbook. 将 Markdown 转换为树形导图；可选写出 .xmind。',
    edit_mindmap_node: 'Incrementally edit one node of a tree loaded from .xmind or .md (update_title / add_child / delete_node / move_node) and return the edited full tree. 增量编辑导图节点，不重写整个文件。',
    xmind_to_markdown: 'Convert an .xmind workbook to Markdown; optionally write the .md file. 将 .xmind 转换为 Markdown；可选写回 .md 文件。',
  }
  for (const definition of harness.definitions) {
    assert.equal(definition.description, expectedDescriptions[definition.name])
    assert.equal(definition.timeoutMs, 30000)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.output.presentationMeta, 'function')
    assert.equal(typeof definition.execute, 'function')
    for (const [key, spec] of Object.entries(definition.parameters)) {
      assert.ok(['string', 'number', 'integer', 'boolean', 'array', 'object', 'json'].includes(spec.type), `${definition.name}.${key} type`)
      if (spec.required !== undefined) assert.equal(spec.required, true, `${definition.name}.${key} required`)
      if (spec.type === 'object') assert.equal(typeof spec.additionalProperties, 'boolean', `${definition.name}.${key} additionalProperties`)
    }
    const objectSchemas = collectObjectSchemas(definition.output.schema)
    if (definition.output.schema.type === 'object') {
      assert.ok(objectSchemas.length > 0, `${definition.name} has an object output`)
    }
    for (const { path, node } of objectSchemas) {
      assert.equal(typeof node.additionalProperties, 'boolean', `${definition.name} ${path}.additionalProperties must be explicit`)
    }
  }

  const view = harness.definition('view_xmind')
  assert.deepEqual(Object.keys(view.parameters), ['xmindPath', 'sheetIndex'])
  assert.deepEqual(view.parameters.xmindPath, { type: 'string', required: true, description: 'Absolute path to the .xmind file.' })
  assert.deepEqual(view.parameters.sheetIndex, { type: 'integer', description: '0-based sheet index; default 0.' })
  assert.equal(view.output.schema.type, 'object')
  assert.equal(view.output.schema.additionalProperties, false)
  assert.deepEqual(Object.keys(view.output.schema.properties), ['rootTopic', 'sheetTitle', 'sheetCount', 'warnings'])
  assert.equal(view.output.schema.properties.rootTopic.type, 'json')
  assert.deepEqual(view.output.schema.properties.warnings, { type: 'array', required: true, items: { type: 'string' } })
  for (const spec of Object.values(view.output.schema.properties)) assert.equal(spec.required, true)

  const markdown = harness.definition('markdown_to_mindmap')
  assert.deepEqual(Object.keys(markdown.parameters), ['mdPath', 'outputXmindPath'])
  assert.equal(markdown.parameters.mdPath.required, true)
  assert.equal(markdown.parameters.outputXmindPath.required, undefined)
  assert.equal(markdown.output.schema.additionalProperties, false)
  assert.equal(markdown.output.schema.properties.rootTopic.type, 'json')
  assert.equal(markdown.output.schema.properties.warnings.type, 'array')

  const edit = harness.definition('edit_mindmap_node')
  assert.deepEqual(Object.keys(edit.parameters), ['sourcePath', 'nodeId', 'action', 'payload'])
  assert.equal(edit.parameters.sourcePath.description, 'Absolute .xmind or .md path.')
  for (const key of ['sourcePath', 'nodeId', 'action']) assert.equal(edit.parameters[key].required, true)
  assert.deepEqual(edit.parameters.action.enum, ['update_title', 'add_child', 'delete_node', 'move_node'])
  assert.equal(edit.parameters.payload.type, 'object')
  assert.equal(edit.parameters.payload.additionalProperties, true)
  assert.deepEqual(Object.keys(edit.parameters.payload.properties), ['title', 'notes', 'href', 'labels', 'parentId', 'index'])
  assert.equal(edit.output.schema.additionalProperties, false)
  assert.equal(edit.output.schema.properties.rootTopic.type, 'json')
  for (const spec of Object.values(edit.output.schema.properties)) assert.equal(spec.required, true)

  const toMarkdown = harness.definition('xmind_to_markdown')
  assert.deepEqual(Object.keys(toMarkdown.parameters), ['xmindPath', 'outputMdPath'])
  assert.deepEqual(toMarkdown.output.schema, { type: 'string' })
})

test('createToolDefinitions is synchronous and lazily loads default deps', () => {
  const definitions = createToolDefinitions()
  assert.equal(definitions.length, 4)
  for (const definition of definitions) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.output.presentationMeta, 'function')
  }
  assert.deepEqual(createToolDefinitions({ config: { any: true } }).length, 4)
})

test('view_xmind loads the default sheet and returns the frozen value shape', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('book.xmind'), [
    { title: 'S1', root: sampleRoot() },
    { title: 'S2', root: { id: 'root2', title: 'Second', children: { attached: [] } } },
  ])

  const value = await harness.run('view_xmind', { xmindPath: file })
  assert.deepEqual(Object.keys(value).sort(), ['rootTopic', 'sheetCount', 'sheetTitle', 'warnings'])
  assert.equal(value.sheetTitle, 'S1')
  assert.equal(value.sheetCount, 2)
  assert.deepEqual(value.warnings, [])
  assert.equal(value.rootTopic.id, 'root')
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)

  const payload = meta(harness, 'view_xmind', { xmindPath: file }, value)
  assert.equal(payload.v, 1)
  assert.equal(payload.kind, 'tree')
  assert.equal(payload.sourcePath, file)
  assert.equal(payload.format, 'json')
  assert.equal(payload.sheetTitle, 'S1')
  assert.equal(payload.sheetCount, 2)
  assert.equal(payload.sheetIndex, 0)
  assert.deepEqual(payload.rootTopic, value.rootTopic)
  assert.equal(payload.mermaid, 'mindmap\n  Root')
  assert.deepEqual(payload.warnings, [])
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload)

  const blocks = render(harness, 'view_xmind', { xmindPath: file }, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /^XMind: S1 \(sheet 1\/2\) · 4 nodes · 2 notes\n\n```mermaid\nmindmap\n {2}Root\n```$/)
  assert.equal(blocks[1].text, '提示：该文件共有 2 个 Sheet；调用 view_xmind 并传 sheetIndex 可切换。')
})

test('view_xmind switches sheets, clamps metadata, and rejects invalid sheetIndex values', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('two-sheets.xmind'), [
    { title: 'S1', root: sampleRoot() },
    { title: 'S2', root: { id: 'root2', title: 'Second', children: { attached: [] } } },
  ])

  const value = await harness.run('view_xmind', { xmindPath: file, sheetIndex: 1 })
  assert.equal(value.sheetTitle, 'S2')
  assert.equal(value.rootTopic.id, 'root2')
  assert.deepEqual(harness.xmind.state.parseCalls, [0, 1])
  const payload = meta(harness, 'view_xmind', { xmindPath: file, sheetIndex: 1 }, value)
  assert.equal(payload.sheetIndex, 1)
  assert.match(render(harness, 'view_xmind', { xmindPath: file, sheetIndex: 1 }, value)[0].text, /\(sheet 2\/2\)/)

  await assert.rejects(
    harness.run('view_xmind', { xmindPath: file, sheetIndex: 5 }),
    {
      message: 'sheetIndex 超出范围：该文件只有 2 个 Sheet（有效范围 0..1）',
    },
  )
  await assert.rejects(harness.run('view_xmind', { xmindPath: file, sheetIndex: -1 }), /sheetIndex 必须是非负整数/)
  await assert.rejects(harness.run('view_xmind', { xmindPath: file, sheetIndex: 1.5 }), /sheetIndex 必须是非负整数/)

  const single = seedXmind(harness, virtualXmind('single.xmind'), [{ title: 'Only', root: sampleRoot() }])
  const singleValue = await harness.run('view_xmind', { xmindPath: single })
  assert.equal(render(harness, 'view_xmind', { xmindPath: single }, singleValue).length, 1)
})

test('view_xmind surfaces parser warnings and truncates oversized Mermaid source', async () => {
  const xmind = createFakeXmind()
  const parse = xmind.parseXmindBuffer
  xmind.parseXmindBuffer = (buffer, opts = {}) => {
    const result = parse(buffer, opts)
    if (Array.isArray(opts.warnings)) opts.warnings.push('已忽略不支持的字段')
    return result
  }
  const harness = buildHarness({
    xmind,
    mermaid: { treeToMermaid: () => `mindmap\n${'x'.repeat(9000)}` },
  })
  const file = seedXmind(harness, virtualXmind('warn.xmind'), [{ title: 'Warn', root: sampleRoot() }])

  const value = await harness.run('view_xmind', { xmindPath: file })
  assert.deepEqual(value.warnings, ['已忽略不支持的字段'])
  const payload = meta(harness, 'view_xmind', { xmindPath: file }, value)
  assert.deepEqual(payload.warnings, ['已忽略不支持的字段'])
  assert.equal(payload.mermaid.length, 9008)

  const blocks = render(harness, 'view_xmind', { xmindPath: file }, value)
  assert.match(blocks[0].text, /- 已忽略不支持的字段/)
  assert.match(blocks[0].text, /… \[mermaid truncated\]/)
})

test('view_xmind enforces absolute .xmind paths and rejects missing files', async () => {
  const harness = buildHarness()
  await assert.rejects(harness.run('view_xmind', { xmindPath: 'relative.xmind' }), /必须是绝对路径/)
  await assert.rejects(harness.run('view_xmind', { xmindPath: virtualMd('note.md') }), /扩展名必须是 \.xmind/)
  await assert.rejects(harness.run('view_xmind', { xmindPath: `${VROOT}\\..\\escape.xmind` }), /不能包含 '\.\.' 路径片段/)
  await assert.rejects(harness.run('view_xmind', { xmindPath: virtualXmind('missing.xmind') }), /ENOENT/)
})

test('view_xmind aborts before touching the filesystem', async () => {
  const harness = buildHarness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    harness.run('view_xmind', { xmindPath: virtualXmind('a.xmind') }, controller.signal),
    error => error.name === 'AbortError',
  )
  assert.equal(harness.fsio.state.reads, 0)
})

test('markdown_to_mindmap parses Markdown without writing by default', async () => {
  const harness = buildHarness()
  const file = virtualMd('doc.md')
  harness.fsio.files.set(file, Buffer.from('# Doc\n\n- item', 'utf8'))

  const value = await harness.run('markdown_to_mindmap', { mdPath: file })
  assert.deepEqual(Object.keys(value).sort(), ['rootTopic', 'warnings'])
  assert.equal(value.rootTopic.id, 'root')
  assert.deepEqual(value.warnings, ['Markdown 降级元素'])
  assert.equal(harness.markdown.lastFileName, 'doc')
  assert.equal(harness.fsio.files.size, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)

  const payload = meta(harness, 'markdown_to_mindmap', { mdPath: file }, value)
  assert.equal(payload.v, 1)
  assert.equal(payload.kind, 'tree')
  assert.equal(payload.format, 'markdown')
  assert.equal(payload.sourcePath, file)
  assert.equal(payload.writtenPath, '')
  assert.equal(payload.sheetTitle, 'Root')
  assert.equal(payload.sheetCount, 1)
  assert.deepEqual(payload.warnings, ['Markdown 降级元素'])
  assert.equal(payload.mermaid, 'mindmap\n  Root')

  const blocks = render(harness, 'markdown_to_mindmap', { mdPath: file }, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /^Markdown 导图: Root · 4 nodes\n- Markdown 降级元素\n\n```mermaid\n/)
  assert.ok(!blocks[0].text.includes('已写出'))
})

test('markdown_to_mindmap writes .xmind once and refuses a silent overwrite', async () => {
  const harness = buildHarness()
  const file = virtualMd('doc.md')
  const output = virtualXmind('written.xmind')
  harness.fsio.files.set(file, Buffer.from('# Doc', 'utf8'))

  const value = await harness.run('markdown_to_mindmap', { mdPath: file, outputXmindPath: output })
  assert.ok(harness.fsio.files.has(output))
  const parsed = readXmind(harness, output)
  assert.equal(parsed.sheetTitle, 'Root')
  assert.equal(parsed.sheetCount, 1)
  assert.deepEqual(parsed.rootTopic, value.rootTopic)

  const payload = meta(harness, 'markdown_to_mindmap', { mdPath: file, outputXmindPath: output }, value)
  assert.equal(payload.writtenPath, output)
  const blocks = render(harness, 'markdown_to_mindmap', { mdPath: file, outputXmindPath: output }, value)
  assert.ok(blocks[0].text.endsWith(`已写出: ${output}`))

  await harness.run('markdown_to_mindmap', { mdPath: file, outputXmindPath: output })
  assert.equal(harness.fsio.files.get(output).toString('utf8'), JSON.stringify({ sheets: [{ title: 'Root', root: value.rootTopic }] }))

  harness.markdown.currentRoot = { ...sampleRoot(), title: 'Changed' }
  await assert.rejects(
    harness.run('markdown_to_mindmap', { mdPath: file, outputXmindPath: output }),
    /目标文件已存在且内容不同，已拒绝覆盖/,
  )
  assert.equal(harness.xmind.state.built.length, 3)
})

test('markdown_to_mindmap enforces path extensions and aborts cleanly', async () => {
  const harness = buildHarness()
  const file = virtualMd('doc.md')
  harness.fsio.files.set(file, Buffer.from('# Doc', 'utf8'))

  await assert.rejects(harness.run('markdown_to_mindmap', { mdPath: 'doc.md' }), /必须是绝对路径/)
  await assert.rejects(harness.run('markdown_to_mindmap', { mdPath: virtualXmind('doc.xmind') }), /扩展名必须是 \.md/)
  await assert.rejects(
    harness.run('markdown_to_mindmap', { mdPath: file, outputXmindPath: 'out.xmind' }),
    /必须是绝对路径/,
  )
  await assert.rejects(
    harness.run('markdown_to_mindmap', { mdPath: file, outputXmindPath: virtualMd('out.md') }),
    /扩展名必须是 \.xmind/,
  )
  assert.deepEqual(harness.xmind.state.built, [])

  const readsBefore = harness.fsio.state.reads
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    harness.run('markdown_to_mindmap', { mdPath: file }, controller.signal),
    error => error.name === 'AbortError',
  )
  assert.equal(harness.fsio.state.reads, readsBefore)
})

test('edit_mindmap_node update_title trims, rewrites the workbook, and reports metadata', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-title.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])

  const value = await harness.run('edit_mindmap_node', {
    sourcePath: file,
    nodeId: 'a',
    action: 'update_title',
    payload: { title: '  A 重命名  ' },
  })
  assert.deepEqual(Object.keys(value).sort(), ['rootTopic', 'warnings'])
  assert.deepEqual(value.warnings, [])
  assert.equal(value.rootTopic.children.attached[0].title, 'A 重命名')
  assert.equal(harness.fsio.state.writeGuardCalls, 1)

  const saved = readXmind(harness, file)
  assert.equal(saved.rootTopic.children.attached[0].title, 'A 重命名')

  const payload = meta(harness, 'edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title' }, value)
  assert.equal(payload.v, 1)
  assert.equal(payload.kind, 'tree')
  assert.equal(payload.action, 'update_title')
  assert.equal(payload.nodeId, 'a')
  assert.equal(payload.writtenPath, file)
  assert.equal(payload.format, 'xmind')
  assert.equal(payload.sheetTitle, 'Sheet 1')
  assert.equal(payload.rootTopic.children.attached[0].title, 'A 重命名')
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload)

  const blocks = render(harness, 'edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title' }, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /^已编辑: update_title · a → A 重命名\n- Root\n {2}- A 重命名\n {4}- A1\n {2}- B$/)
})

test('edit_mindmap_node update_title rejects empty titles and unknown nodes', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-empty.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])
  for (const title of ['', '   ', undefined]) {
    await assert.rejects(
      harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title', payload: { title } }),
      /标题不能为空或纯空白/,
    )
  }
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'ghost', action: 'update_title', payload: { title: 'x' } }),
    /未找到节点: ghost/,
  )
  assert.equal(harness.fsio.state.writeGuardCalls, 0)
})

test('edit_mindmap_node add_child generates ids, copies metadata, and honors index', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-add.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])

  const appended = await harness.run('edit_mindmap_node', {
    sourcePath: file,
    nodeId: 'a',
    action: 'add_child',
    payload: { title: ' 新节点 ', notes: '新备注', href: 'https://example.com', labels: ['x', 'x', 'y'] },
  })
  const a = appended.rootTopic.children.attached.find(node => node.id === 'a')
  assert.equal(a.children.attached.length, 2)
  const child = a.children.attached[1]
  assert.equal(child.title, '新节点')
  assert.equal(child.notes, '新备注')
  assert.equal(child.href, 'https://example.com')
  assert.deepEqual(child.labels, ['x', 'y'])
  assert.notEqual(child.id, 'a')
  assert.deepEqual(readXmind(harness, file).rootTopic.children.attached.find(node => node.id === 'a').children.attached[1], child)

  const inserted = await harness.run('edit_mindmap_node', {
    sourcePath: file,
    nodeId: 'root',
    action: 'add_child',
    payload: { title: '首位', index: 0 },
  })
  assert.equal(inserted.rootTopic.children.attached[0].title, '首位')

  const appendedOutOfRange = await harness.run('edit_mindmap_node', {
    sourcePath: file,
    nodeId: 'root',
    action: 'add_child',
    payload: { title: '末尾', index: 99 },
  })
  assert.equal(appendedOutOfRange.rootTopic.children.attached.at(-1).title, '末尾')

  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'add_child', payload: {} }),
    /标题不能为空或纯空白/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'ghost', action: 'add_child', payload: { title: 'x' } }),
    /未找到节点: ghost/,
  )
})

test('edit_mindmap_node delete_node removes subtrees and protects the root', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-delete.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])

  const value = await harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'delete_node', payload: {} })
  const ids = []
  walkTree(value.rootTopic, node => ids.push(node.id))
  assert.ok(!ids.includes('a'))
  assert.ok(!ids.includes('a1'))
  assert.ok(ids.includes('b'))
  assert.deepEqual(value.warnings, [])
  const saved = readXmind(harness, file)
  assert.ok(!saved.rootTopic.children.attached.some(node => node.id === 'a'))

  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'root', action: 'delete_node', payload: {} }),
    /不能删除根节点/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'ghost', action: 'delete_node', payload: {} }),
    /未找到节点: ghost/,
  )

  const blocks = render(harness, 'edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'delete_node' }, value)
  assert.match(blocks[0].text, /^已编辑: delete_node · a → A\n/)
})

test('edit_mindmap_node move_node reparents, reorders, and rejects every illegal move', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-move.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])

  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a1', action: 'move_node', payload: {} }),
    /move_node 需要提供 payload\.parentId/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a1', action: 'move_node', payload: { parentId: 'a1' } }),
    /不能把节点移动到它自己的子树下/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'move_node', payload: { parentId: 'a1' } }),
    /不能把节点移动到它自己的子树下/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'root', action: 'move_node', payload: { parentId: 'b' } }),
    /不能移动根节点/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'move_node', payload: { parentId: 'ghost' } }),
    /未找到目标父节点: ghost/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'ghost', action: 'move_node', payload: { parentId: 'b' } }),
    /未找到节点: ghost/,
  )
  assert.equal(harness.fsio.state.writeGuardCalls, 0)

  const moved = await harness.run('edit_mindmap_node', {
    sourcePath: file,
    nodeId: 'a1',
    action: 'move_node',
    payload: { parentId: 'b' },
  })
  const b = moved.rootTopic.children.attached.find(node => node.id === 'b')
  assert.deepEqual(b.children.attached.map(node => node.id), ['a1'])
  const a = moved.rootTopic.children.attached.find(node => node.id === 'a')
  assert.deepEqual(a.children.attached, [])
  assert.equal(readXmind(harness, file).rootTopic.children.attached.find(node => node.id === 'b').children.attached[0].id, 'a1')

  const reordered = await harness.run('edit_mindmap_node', {
    sourcePath: file,
    nodeId: 'b',
    action: 'move_node',
    payload: { parentId: 'root', index: 0 },
  })
  assert.deepEqual(reordered.rootTopic.children.attached.map(node => node.id), ['b', 'a'])
})

test('edit_mindmap_node .md source re-serializes Markdown and warns about it', async () => {
  const harness = buildHarness()
  const file = virtualMd('notes.md')
  harness.fsio.files.set(file, Buffer.from('# Doc\n\n- item', 'utf8'))

  const value = await harness.run('edit_mindmap_node', {
    sourcePath: file,
    nodeId: 'a',
    action: 'update_title',
    payload: { title: 'A2' },
  })
  assert.ok(value.warnings.includes('已按结构化规则重新序列化 Markdown'))
  assert.ok(value.warnings.includes('Markdown 降级元素'))
  assert.equal(harness.fsio.files.get(file).toString('utf8'), '# Root')
  assert.equal(harness.markdown.lastFileName, 'notes')

  const payload = meta(harness, 'edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title' }, value)
  assert.equal(payload.format, 'markdown')
  assert.equal(payload.writtenPath, file)

  const blocks = render(harness, 'edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title' }, value)
  assert.match(blocks[0].text, /- 已按结构化规则重新序列化 Markdown/)
})

test('edit_mindmap_node refuses multi-sheet workbooks instead of dropping other sheets', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-multi.xmind'), [
    { title: 'S1', root: sampleRoot() },
    { title: 'S2', root: { id: 'root2', title: 'Second', children: { attached: [] } } },
  ])
  const before = harness.fsio.files.get(file).toString('utf8')

  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title', payload: { title: 'X' } }),
    {
      message: '该 .xmind 包含 2 个 Sheet，edit_mindmap_node 目前只支持编辑单 Sheet 文件（避免丢失其他 Sheet）；请先拆分文件或使用 XMind 客户端编辑',
    },
  )
  assert.equal(harness.fsio.state.writeGuardCalls, 0)
  assert.equal(harness.fsio.state.writes, 0)
  assert.equal(harness.fsio.files.get(file).toString('utf8'), before)
  assert.equal(harness.xmind.state.built.length, 0)
})

test('edit_mindmap_node rejects a .md that changed between read and write', async () => {
  const harness = buildHarness()
  const file = virtualMd('changed.md')
  harness.fsio.files.set(file, Buffer.from('# Doc', 'utf8'))

  harness.fsio.state.failWriteGuard = true
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title', payload: { title: 'X' } }),
    { message: `目标文件在读取后已被修改，已拒绝覆盖: ${file}` },
  )
  assert.equal(harness.fsio.files.get(file).toString('utf8'), '# Doc')
  assert.equal(harness.fsio.state.writes, 0)

  harness.fsio.state.failWriteGuard = false
  harness.fsio.state.staleBaseline = true
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title', payload: { title: 'X' } }),
    { message: `目标文件在读取后已被修改，已拒绝覆盖: ${file}` },
  )
  assert.equal(harness.fsio.files.get(file).toString('utf8'), '# Doc')
})

test('edit_mindmap_node fails closed on stale baselines and write errors', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-stale.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])
  const before = harness.fsio.files.get(file).toString('utf8')

  harness.fsio.state.staleBaseline = true
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title', payload: { title: 'X' } }),
    /目标文件在读取后已被修改，已拒绝覆盖/,
  )
  assert.equal(harness.fsio.state.writeGuardCalls, 0)
  assert.equal(harness.fsio.files.get(file).toString('utf8'), before)

  harness.fsio.state.staleBaseline = false
  harness.fsio.state.failWriteGuard = true
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title', payload: { title: 'X' } }),
    /目标文件在读取后已被修改，已拒绝覆盖/,
  )
  assert.equal(harness.fsio.files.get(file).toString('utf8'), before)
})

test('edit_mindmap_node rejects bad paths, actions, ids, and invalid edited trees', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-bad.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])

  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: join(VROOT, 'bad.txt'), nodeId: 'a', action: 'update_title', payload: { title: 'x' } }),
    /扩展名必须是 \.xmind 或 \.md/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: 'relative.xmind', nodeId: 'a', action: 'update_title', payload: { title: 'x' } }),
    /必须是绝对路径/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'rename', payload: {} }),
    /不支持的操作: rename/,
  )
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: '', action: 'update_title', payload: { title: 'x' } }),
    /节点 id 不能为空/,
  )
  assert.equal(harness.fsio.state.writeGuardCalls, 0)

  const duplicate = buildHarness({ treeOverrides: { generateId: () => 'a' } })
  const duplicateFile = seedXmind(duplicate, virtualXmind('edit-duplicate.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])
  await assert.rejects(
    duplicate.run('edit_mindmap_node', { sourcePath: duplicateFile, nodeId: 'root', action: 'add_child', payload: { title: '重复' } }),
    /invalid tree: duplicate id/,
  )
})

test('edit_mindmap_node aborts before reading and caps its outline at 40 lines', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('edit-abort.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    harness.run('edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title', payload: { title: 'x' } }, controller.signal),
    error => error.name === 'AbortError',
  )
  assert.equal(harness.fsio.state.reads, 0)
  assert.equal(harness.fsio.state.writeGuardCalls, 0)

  const wideHarness = buildHarness()
  const wideFile = seedXmind(wideHarness, virtualXmind('edit-wide.xmind'), [{ title: 'Sheet 1', root: wideRoot() }])
  const value = await wideHarness.run('edit_mindmap_node', {
    sourcePath: wideFile,
    nodeId: 'root',
    action: 'update_title',
    payload: { title: 'Wide2' },
  })
  const blocks = render(wideHarness, 'edit_mindmap_node', { sourcePath: wideFile, nodeId: 'root', action: 'update_title' }, value)
  const lines = blocks[0].text.split('\n')
  assert.equal(lines.length, 42)
  assert.equal(lines[1], '- Wide2')
  assert.equal(lines.at(-1), '… (大纲已截断)')
})

test('xmind_to_markdown returns the Markdown text and renders it verbatim', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('to-md.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])

  const value = await harness.run('xmind_to_markdown', { xmindPath: file })
  assert.equal(typeof value, 'string')
  assert.equal(value, '# Root')
  assert.deepEqual(render(harness, 'xmind_to_markdown', { xmindPath: file }, value), [{ type: 'text', text: '# Root' }])

  const payload = meta(harness, 'xmind_to_markdown', { xmindPath: file }, value)
  assert.equal(payload.v, 1)
  assert.equal(payload.kind, 'markdown')
  assert.equal(payload.sourcePath, file)
  assert.equal(payload.writtenPath, '')
  assert.equal(payload.markdown, value)
  assert.equal(payload.sheetTitle, 'Sheet 1')
  assert.equal(payload.sheetCount, 1)
  assert.deepEqual(payload.warnings, [])
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload)
})

test('xmind_to_markdown optionally writes .md without silent overwrites', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('to-md-write.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])
  const output = virtualMd('written.md')

  const value = await harness.run('xmind_to_markdown', { xmindPath: file, outputMdPath: output })
  assert.equal(value, '# Root')
  assert.equal(harness.fsio.files.get(output).toString('utf8'), '# Root')
  const payload = meta(harness, 'xmind_to_markdown', { xmindPath: file, outputMdPath: output }, value)
  assert.equal(payload.writtenPath, output)

  await harness.run('xmind_to_markdown', { xmindPath: file, outputMdPath: output })
  assert.equal(harness.fsio.files.get(output).toString('utf8'), '# Root')

  harness.markdown.treeToMarkdown = () => '# Changed'
  await assert.rejects(
    harness.run('xmind_to_markdown', { xmindPath: file, outputMdPath: output }),
    /目标文件已存在且内容不同，已拒绝覆盖/,
  )
})

test('xmind_to_markdown enforces .md output paths and abort signals', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('to-md-bad.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])

  await assert.rejects(
    harness.run('xmind_to_markdown', { xmindPath: file, outputMdPath: virtualXmind('out.xmind') }),
    /扩展名必须是 \.md/,
  )
  await assert.rejects(
    harness.run('xmind_to_markdown', { xmindPath: file, outputMdPath: 'out.md' }),
    /必须是绝对路径/,
  )
  await assert.rejects(harness.run('xmind_to_markdown', { xmindPath: virtualMd('x.md') }), /扩展名必须是 \.xmind/)

  assert.deepEqual(harness.xmind.state.built, [])

  const readsBefore = harness.fsio.state.reads
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    harness.run('xmind_to_markdown', { xmindPath: file }, controller.signal),
    error => error.name === 'AbortError',
  )
  assert.equal(harness.fsio.state.reads, readsBefore)
})

test('render and presentationMeta stay safe for replayed values without execute caches', async () => {
  const harness = buildHarness()
  const file = seedXmind(harness, virtualXmind('replay.xmind'), [{ title: 'Sheet 1', root: sampleRoot() }])
  const value = await harness.run('view_xmind', { xmindPath: file })
  const replayed = JSON.parse(JSON.stringify(value))

  const blocks = render(harness, 'view_xmind', { xmindPath: file }, replayed)
  assert.match(blocks[0].text, /^XMind: Sheet 1 \(sheet 1\/1\) · 4 nodes · 2 notes/)
  const payload = meta(harness, 'view_xmind', { xmindPath: file }, replayed)
  assert.equal(payload.sourcePath, file)
  assert.equal(payload.format, 'json')
  assert.equal(payload.sheetCount, 1)
  assert.equal(payload.sheetIndex, 0)
  assert.deepEqual(payload.rootTopic, replayed.rootTopic)
  assert.equal(payload.mermaid, 'mindmap\n  Root')

  const editValue = await harness.run('edit_mindmap_node', {
    sourcePath: file,
    nodeId: 'a',
    action: 'update_title',
    payload: { title: 'Replay A' },
  })
  const replayedEdit = JSON.parse(JSON.stringify(editValue))
  const editBlocks = render(harness, 'edit_mindmap_node', { sourcePath: file, nodeId: 'a', action: 'update_title' }, replayedEdit)
  assert.match(editBlocks[0].text, /^已编辑: update_title · a → Replay A/)

  const unknownMarkdownPayload = meta(
    harness,
    'xmind_to_markdown',
    { xmindPath: `${VROOT}\\never.xmind` },
    '# never executed',
  )
  assert.equal(unknownMarkdownPayload.kind, 'markdown')
  assert.equal(unknownMarkdownPayload.markdown, '# never executed')
  assert.equal(unknownMarkdownPayload.sourcePath, `${VROOT}\\never.xmind`)
  assert.equal(unknownMarkdownPayload.writtenPath, '')
  assert.equal(unknownMarkdownPayload.sheetTitle, '')
  assert.equal(unknownMarkdownPayload.sheetCount, 1)
  assert.deepEqual(unknownMarkdownPayload.warnings, [])
  assert.deepEqual(render(harness, 'xmind_to_markdown', { xmindPath: file }, '# never executed'), [{ type: 'text', text: '# never executed' }])
})
