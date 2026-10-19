/* node:test suite for the dsh-xmind-mindmap client card (loader format, registrations, layout, meta parsing, rendering smoke). */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as harness from './client-harness.js'

function makeTree() {
  return {
    id: 'r',
    title: 'Root',
    children: {
      attached: [
        {
          id: 'a',
          title: 'Alpha',
          children: { attached: [{ id: 'a1', title: 'Alpha child one', children: { attached: [] } }] },
        },
        { id: 'b', title: 'Beta', notes: 'some notes', children: { attached: [] } },
        {
          id: 'c',
          title: 'Gamma',
          children: { attached: [] },
          href: 'https://example.com/doc',
          labels: ['x', 'y'],
        },
      ],
    },
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function byId(layout) {
  const map = {}
  for (const node of layout.nodes) map[node.id] = node
  return map
}

function overlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
}

function assertNoOverlap(nodes) {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      assert.equal(
        overlap(nodes[i], nodes[j]),
        false,
        'nodes ' + nodes[i].id + ' and ' + nodes[j].id + ' overlap'
      )
    }
  }
}

test('loader format: window.__ModuleLoader__.load with id and factory', function () {
  const loaded = harness.loadClient()
  assert.equal(loaded.id, 'dsh-xmind-mindmap')
  assert.equal(typeof loaded.factory, 'function')
  assert.equal(loaded.requireCalls.length, 1)
  assert.equal(loaded.requireCalls[0], 'react')
  assert.equal(loaded.window.__moduleLoaderLoadCount, 1)

  const source = loaded.source
  const withoutBanner = source.replace(/^\/\*[\s\S]*?\*\/\s*/, '')
  assert.ok(/^window\.__ModuleLoader__\.load\(\{/.test(withoutBanner), 'must start with the loader call after the banner comment')
  assert.ok(source.indexOf("id: 'dsh-xmind-mindmap'") >= 0, 'literal loader id')
  assert.ok(source.indexOf("const React = require('react')") >= 0, 'React comes from require("react")')
  assert.ok(source.indexOf('React.createElement') >= 0, 'must use React.createElement')
  assert.equal(source.indexOf('@deepseek-ai/'), -1, 'no Harness client packages')
  assert.equal(source.indexOf('jsx'), -1, 'no JSX')
})

test('module shape: name, inject list and apply function', function () {
  const loaded = harness.loadClient()
  assert.equal(loaded.module.name, 'dsh-xmind-mindmap')
  assert.deepEqual(loaded.module.inject, ['slots', 'locale', 'documentPreviews'])
  assert.equal(typeof loaded.module.apply, 'function')
  const internals = loaded.module.__internals
  for (const key of ['layoutTree', 'parseMeta', 'outlineRows', 'escapeLabel', 'truncate']) {
    assert.equal(typeof internals[key], 'function', '__internals.' + key + ' must be a function')
  }
})

test('apply registers the same Card for all four tool keys', function () {
  const setup = harness.setup()
  const toolRegistrations = setup.registrations.filter(function (registration) {
    return registration.target.name === 'tool.call.toolview'
  })
  assert.equal(toolRegistrations.length, 4)
  assert.deepEqual(toolRegistrations.map(function (registration) {
    return registration.target.key
  }), ['view_xmind', 'markdown_to_mindmap', 'edit_mindmap_node', 'xmind_to_markdown'])
  assert.ok(setup.state.injectCalls.indexOf('tool.call.toolview') >= 0)
  assert.ok(setup.state.injectCalls.indexOf('sidebar.right.tab.document') >= 0)
  for (const registration of toolRegistrations) {
    assert.equal(registration.target.locale, 'xmind')
    assert.equal(typeof registration.component, 'function')
    assert.equal(registration.component, setup.Card, 'all four keys share the same component')
  }
})

test('locale dictionaries are registered under xmind via ctx.effect and stay key-complete', function () {
  const setup = harness.setup()
  const dictionaryEffects = setup.state.effects.filter(function (effect) {
    return effect.label === 'dsh-xmind-mindmap: dictionaries'
  })
  assert.equal(dictionaryEffects.length, 1)
  assert.ok(setup.state.effects.some(function (effect) {
    return effect.label === 'dsh-xmind-mindmap: xmind preview registration'
  }))
  assert.equal(setup.state.localeRegistrations.length, 1)
  const registration = setup.state.localeRegistrations[0]
  assert.equal(registration.namespace, 'xmind')
  const zh = registration.dictionaries.zh
  const en = registration.dictionaries.en
  assert.equal(typeof zh, 'object')
  assert.equal(typeof en, 'object')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en key sets must be identical')
  assert.ok(Object.keys(zh).length > 20)
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], 'string', 'zh ' + key)
    assert.ok(zh[key].length > 0, 'zh ' + key + ' must not be empty')
    assert.equal(typeof en[key], 'string', 'en ' + key)
    assert.ok(en[key].length > 0, 'en ' + key + ' must not be empty')
  }
})

test('layoutTree is deterministic and lays out every node without overlap', function () {
  const internals = harness.setup().internals
  const first = internals.layoutTree(makeTree(), { collapsed: new Set() })
  const second = internals.layoutTree(makeTree(), { collapsed: new Set() })
  assert.deepEqual(first, second, 'layout must be deterministic')

  assert.deepEqual(
    first.nodes.map(function (node) {
      return node.id
    }),
    ['r', 'a', 'a1', 'b', 'c'],
    'pre-order node order'
  )
  assert.equal(first.links.length, first.nodes.length - 1)
  assert.equal(first.nodes[0].x, 24, 'root starts at the layout padding')
  assert.ok(first.width > 0 && first.height > 0)

  const nodes = byId(first)
  for (const link of first.links) {
    assert.ok(nodes[link.from], 'link source exists')
    assert.ok(nodes[link.to], 'link target exists')
    assert.ok(nodes[link.to].x >= nodes[link.from].x + nodes[link.from].w, 'child sits right of its parent')
  }

  assertNoOverlap(first.nodes)

  for (const node of first.nodes) {
    assert.ok(node.x >= 0 && node.y >= 0)
    assert.ok(node.x + node.w <= first.width)
    assert.ok(node.y + node.h <= first.height)
    assert.equal(typeof node.depth, 'number')
    assert.equal(typeof node.hasNotes, 'boolean')
    assert.equal(typeof node.collapsed, 'boolean')
    assert.ok(Array.isArray(node.children))
  }

  const siblings = ['a', 'b', 'c'].map(function (id) {
    return nodes[id]
  })
  for (let i = 0; i < siblings.length; i += 1) {
    for (let j = i + 1; j < siblings.length; j += 1) {
      const a = siblings[i]
      const b = siblings[j]
      assert.ok(a.y + a.h <= b.y || b.y + b.h <= a.y, 'siblings must not overlap vertically')
    }
  }
})

test('layoutTree keeps a bushy tree overlap-free at every depth', function () {
  const internals = harness.setup().internals
  const tree = { id: 'root', title: 'Bushy root', children: { attached: [] } }
  for (let i = 0; i < 10; i += 1) {
    const child = { id: 'c' + i, title: 'Child number ' + i, children: { attached: [] } }
    for (let j = 0; j < (i % 3) + 1; j += 1) {
      child.children.attached.push({
        id: 'c' + i + '-' + j,
        title: j === 0 ? 'Short' : 'A much longer grandchild title ' + i + '-' + j,
        children: { attached: [] },
        notes: j === 0 ? 'note text' : undefined,
      })
    }
    tree.children.attached.push(child)
  }
  const layout = internals.layoutTree(tree, { collapsed: new Set() })
  assert.equal(layout.nodes.length, 30)
  assertNoOverlap(layout.nodes)
  const nodes = byId(layout)
  for (const link of layout.links) {
    assert.ok(nodes[link.to].x >= nodes[link.from].x + nodes[link.from].w, 'child is right of parent')
  }
  for (const node of layout.nodes) {
    assert.ok(node.x + node.w <= layout.width)
    assert.ok(node.y + node.h <= layout.height)
  }
  assert.deepEqual(layout, internals.layoutTree(tree, { collapsed: new Set() }), 'bushy layout is deterministic')
})

test('layoutTree prunes collapsed subtrees', function () {
  const internals = harness.setup().internals
  const layout = internals.layoutTree(makeTree(), { collapsed: new Set(['a']) })
  const nodes = byId(layout)
  assert.ok(nodes.a, 'collapsed node still visible')
  assert.equal(nodes.a.collapsed, true)
  assert.deepEqual(nodes.a.children, [])
  assert.equal(nodes.a1, undefined, 'descendant pruned')
  assert.deepEqual(
    layout.nodes.map(function (node) {
      return node.id
    }),
    ['r', 'a', 'b', 'c']
  )
  assert.equal(layout.links.length, 3)
  assertNoOverlap(layout.nodes)

  const rootOnly = internals.layoutTree(makeTree(), { collapsed: ['r'] })
  assert.deepEqual(
    rootOnly.nodes.map(function (node) {
      return node.id
    }),
    ['r']
  )
  assert.equal(rootOnly.links.length, 0)
  assert.equal(rootOnly.nodes[0].collapsed, true)
  assert.equal(rootOnly.nodes[0].childCount, 3)
  assert.equal(rootOnly.width, rootOnly.nodes[0].w + 48)
  assert.equal(rootOnly.height, rootOnly.nodes[0].h + 48)
})

test('layoutTree tolerates loose/empty input and loose node shapes', function () {
  const internals = harness.setup().internals
  assert.deepEqual(internals.layoutTree(null), { nodes: [], links: [], width: 0, height: 0 })
  assert.deepEqual(internals.layoutTree(undefined, { collapsed: null }), { nodes: [], links: [], width: 0, height: 0 })

  const loose = internals.layoutTree({
    title: 'Loose root',
    children: [{ title: 'Loose child', children: [{ title: 'Grandchild' }] }],
  })
  assert.equal(loose.nodes.length, 3)
  assert.equal(loose.nodes[0].title, 'Loose root')
  assert.equal(loose.nodes[2].depth, 3)
  for (const node of loose.nodes) assert.ok(node.id && node.title)
})

test('parseMeta accepts a complete payload', function () {
  const internals = harness.setup().internals
  const parsed = internals.parseMeta({
    meta: {
      v: 1,
      kind: 'tree',
      sourcePath: 'C:\\docs\\demo.xmind',
      format: 'json',
      sheetTitle: 'Sheet 1',
      sheetCount: 2,
      sheetIndex: 1,
      rootTopic: makeTree(),
      mermaid: 'mindmap\n  Root',
      warnings: [' w1 ', '', 42, 'w2'],
      writtenPath: 'C:\\out\\demo.xmind',
      action: 'update_title',
      nodeId: 'a',
    },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.kind, 'tree')
  assert.equal(parsed.v, 1)
  assert.equal(parsed.sourcePath, 'C:\\docs\\demo.xmind')
  assert.equal(parsed.format, 'json')
  assert.equal(parsed.sheetTitle, 'Sheet 1')
  assert.equal(parsed.sheetCount, 2)
  assert.equal(parsed.sheetIndex, 1)
  assert.equal(parsed.nodeCount, 5)
  assert.deepEqual(parsed.warnings, ['w1', 'w2'])
  assert.equal(parsed.warningCount, 2)
  assert.equal(parsed.mermaid, 'mindmap\n  Root')
  assert.equal(parsed.writtenPath, 'C:\\out\\demo.xmind')
  assert.equal(parsed.action, 'update_title')
  assert.equal(parsed.nodeId, 'a')
  assert.ok(parsed.rootTopic && parsed.rootTopic.children.attached.length === 3)
})

test('parseMeta falls back safely for null, short and garbage meta', function () {
  const internals = harness.setup().internals
  const cases = [
    null,
    undefined,
    {},
    { meta: null },
    { meta: 'garbage' },
    { meta: [] },
    { meta: {} },
    { meta: { v: 1 } },
    { meta: { v: 1, kind: 'tree' } },
    { meta: { v: 1, kind: 'tree', rootTopic: 'oops' } },
    { meta: { v: 1, kind: 'tree', rootTopic: [] } },
    { meta: { v: 1, kind: 'tree', rootTopic: 7 } },
  ]
  for (const block of cases) {
    let parsed
    assert.doesNotThrow(function () {
      parsed = internals.parseMeta(block)
    }, 'parseMeta must not throw for ' + JSON.stringify(block))
    assert.equal(parsed.ok, false)
    assert.equal(parsed.rootTopic, null)
    assert.equal(parsed.nodeCount, 0)
    assert.deepEqual(parsed.warnings, [])
    assert.equal(parsed.kind, 'tree')
    assert.equal(parsed.markdown, '')
  }
})

test('parseMeta keeps markdown payloads and normalises a loose rootTopic', function () {
  const internals = harness.setup().internals
  const markdown = internals.parseMeta({ meta: { v: 1, kind: 'markdown', markdown: '# hello', warnings: ['x'] } })
  assert.equal(markdown.ok, true)
  assert.equal(markdown.kind, 'markdown')
  assert.equal(markdown.markdown, '# hello')
  assert.equal(markdown.nodeCount, 0)

  const parsed = internals.parseMeta({
    meta: {
      v: 1,
      kind: 'tree',
      rootTopic: {
        title: 'Root',
        labels: [' a ', 'a', 'b', '', null],
        children: [
          { title: '', id: 'dup' },
          { id: 'dup', title: 'Second', notes: '  ' },
          { id: 'dup', title: 'Third' },
        ],
      },
    },
  })
  assert.equal(parsed.ok, true)
  const root = parsed.rootTopic
  assert.equal(root.title, 'Root')
  assert.deepEqual(root.labels, ['a', 'b'])
  assert.equal(root.children.attached.length, 3)
  const ids = root.children.attached.map(function (node) {
    return node.id
  })
  assert.equal(new Set(ids).size, 3, 'duplicate ids must be replaced')
  assert.equal(root.children.attached[0].title, 'Untitled')
  assert.equal(root.children.attached[0].notes, undefined, 'blank notes are dropped')
})

test('outlineRows returns a pre-order flat tree', function () {
  const internals = harness.setup().internals
  const rows = internals.outlineRows(makeTree())
  assert.deepEqual(
    rows.map(function (row) {
      return row.id
    }),
    ['r', 'a', 'a1', 'b', 'c']
  )
  assert.deepEqual(
    rows.map(function (row) {
      return row.depth
    }),
    [1, 2, 3, 2, 2]
  )
  assert.deepEqual(
    rows.map(function (row) {
      return row.parentId
    }),
    ['', 'r', 'a', 'r', 'r']
  )
  assert.equal(rows[0].hasChildren, true)
  assert.equal(rows[2].hasChildren, false)
  assert.equal(rows[3].hasNotes, true)
  assert.equal(rows[3].notes, 'some notes')
  assert.equal(rows[4].href, 'https://example.com/doc')
  assert.deepEqual(rows[4].labels, ['x', 'y'])
  assert.deepEqual(internals.outlineRows(null), [])
})

test('escapeLabel and truncate are single-line safe and deterministic', function () {
  const internals = harness.setup().internals
  assert.equal(internals.escapeLabel(' <a & b> \n c\t d '), '&lt;a &amp; b&gt; c d')
  assert.equal(internals.escapeLabel('quote " and \' sign'), 'quote &quot; and &#39; sign')
  assert.equal(internals.escapeLabel(null), '')
  assert.equal(internals.escapeLabel('a\u0000b'), 'a b')

  assert.equal(internals.truncate('abcdef', 4), 'abc…')
  assert.equal(internals.truncate('abc', 10), 'abc')
  assert.equal(internals.truncate('abcdef', 1), '…')
  assert.equal(internals.truncate(null, 3), '')
  assert.equal(internals.truncate('abcdef', 0), 'abcdef')
})

test('Card renders block.content when meta is missing (never blank)', function () {
  const setup = harness.setup()
  const element = setup.Card({
    phase: 'result',
    block: { content: [{ type: 'text', text: 'FALLBACK BODY' }] },
    t: undefined,
  })
  assert.ok(element && element.type === 'div')
  const strings = harness.collectStrings(element)
  assert.ok(strings.indexOf('FALLBACK BODY') >= 0, 'fallback content is rendered')
  assert.ok(strings.indexOf('XMind 导图') >= 0, 'header title is rendered')
})

test('Card never throws for empty block, garbage meta or preparing phase', function () {
  const setup = harness.setup()
  const empty = setup.Card({ phase: 'result', block: {}, t: undefined })
  assert.ok(harness.collectStrings(empty).indexOf('没有可显示的导图数据') >= 0)

  assert.doesNotThrow(function () {
    setup.Card({ phase: 'result', block: { meta: 'garbage', content: [] } })
    setup.Card({ phase: 'result', block: null })
    setup.Card({ phase: 'start', block: { meta: { v: 1, kind: 'tree', rootTopic: makeTree() } } })
    setup.Card({})
  })

  const preparing = setup.Card({ phase: 'preparing', block: {}, t: undefined })
  const strings = harness.collectStrings(preparing)
  assert.ok(strings.indexOf('正在解析导图…') >= 0, 'preparing shows the scanning label')
  const preparingHeader = Array.isArray(preparing.props.children)
    ? preparing.props.children[0]
    : preparing.props.children
  assert.equal(preparingHeader.props['aria-expanded'], undefined, 'preparing row is not a disclosure')
})

test('Card renders the tree payload: badges, nodes, notes marker and warnings', function () {
  const setup = harness.setup()
  const element = setup.Card({
    phase: 'result',
    block: {
      meta: {
        v: 1,
        kind: 'tree',
        sourcePath: 'C:\\docs\\demo.xmind',
        format: 'json',
        sheetTitle: 'Sheet 1',
        sheetCount: 2,
        sheetIndex: 0,
        rootTopic: makeTree(),
        mermaid: 'mindmap\n  Root',
        warnings: ['degraded one', 'degraded two'],
      },
    },
    t: undefined,
  })
  const strings = harness.collectStrings(element)
  assert.ok(strings.indexOf('Sheet 1') >= 0, 'sheet title shown')
  assert.ok(strings.indexOf('5 节点') >= 0, 'node count badge')
  assert.ok(strings.indexOf('Sheet 1/2') >= 0, 'sheet badge')
  assert.ok(strings.indexOf('警告 2') >= 0, 'warning badge')
  assert.ok(strings.indexOf('Root') >= 0, 'root node label')
  assert.ok(strings.indexOf('Alpha') >= 0, 'child node label')
  assert.ok(strings.indexOf('Beta [备注]') >= 0, 'notes marker in node text')
  assert.ok(strings.indexOf('degraded one') >= 0, 'warnings list rendered')
  assert.ok(strings.indexOf('导图') >= 0 && strings.indexOf('大纲') >= 0, 'view toggle rendered')
  assert.ok(strings.indexOf('Mermaid 源码') >= 0, 'mermaid toggle rendered')
  assert.ok(strings.indexOf('100%') >= 0, 'zoom label rendered')
})

test('Card renders the markdown payload with a copy button', function () {
  const setup = harness.setup()
  const element = setup.Card({
    phase: 'result',
    block: {
      meta: {
        v: 1,
        kind: 'markdown',
        sourcePath: 'C:\\docs\\demo.xmind',
        sheetTitle: 'Sheet 1',
        markdown: '# Heading\n\n- item',
        warnings: [],
      },
    },
    t: undefined,
  })
  const strings = harness.collectStrings(element)
  assert.ok(strings.indexOf('Markdown 预览') >= 0)
  assert.ok(strings.indexOf('# Heading\n\n- item') >= 0)
  assert.ok(strings.indexOf('复制') >= 0)
})

function treeMeta(extra) {
  return Object.assign(
    {
      v: 1,
      kind: 'tree',
      sourcePath: 'C:\\docs\\demo.xmind',
      format: 'json',
      sheetTitle: 'Sheet 1',
      sheetCount: 2,
      sheetIndex: 0,
      rootTopic: makeTree(),
      mermaid: 'mindmap\n  Root',
      warnings: [],
    },
    extra || {}
  )
}

test('outline view exposes role=tree/treeitem rows with disclosure state', function () {
  const setup = harness.setup({ stateOverrides: { 1: 'outline', 3: 'b' } })
  const element = setup.Card({ phase: 'result', block: { meta: treeMeta() }, t: undefined })
  const tree = harness.findElement(element, function (node) {
    return node.props.role === 'tree'
  })
  assert.ok(tree, 'role=tree container exists')
  const items = harness.findElements(tree, function (node) {
    return node.props.role === 'treeitem'
  })
  assert.equal(items.length, 5)
  assert.equal(items[0].props['aria-level'], 1)
  assert.equal(items[0].props['aria-expanded'], true)
  assert.equal(items[1].props['aria-level'], 2)
  assert.equal(items[1].props['aria-expanded'], true)
  assert.equal(items[2].props['aria-expanded'], undefined, 'leaf rows are not expandable')
  const selected = items.filter(function (item) {
    return item.props['aria-selected'] === true
  })
  assert.equal(selected.length, 1)
  assert.ok(harness.collectStrings(selected[0]).indexOf('Beta') >= 0)
})

test('outline view honours collapsed rows', function () {
  const setup = harness.setup({ stateOverrides: { 1: 'outline', 2: new Set(['a']) } })
  const element = setup.Card({ phase: 'result', block: { meta: treeMeta() }, t: undefined })
  const tree = harness.findElement(element, function (node) {
    return node.props.role === 'tree'
  })
  const items = harness.findElements(tree, function (node) {
    return node.props.role === 'treeitem'
  })
  assert.equal(items.length, 4, 'collapsed node hides its descendant row')
  const strings = harness.collectStrings(tree)
  assert.equal(strings.indexOf('Alpha child one'), -1)
  assert.equal(items[1].props['aria-expanded'], false)
})

test('map view shows the side panel for the selected node (notes, href, labels)', function () {
  const notesSetup = harness.setup({ stateOverrides: { 3: 'b' } })
  const notesCard = notesSetup.Card({ phase: 'result', block: { meta: treeMeta() }, t: undefined })
  const notesPanel = harness.findElement(notesCard, function (node) {
    return node.props['aria-label'] === '节点详情'
  })
  assert.ok(notesPanel, 'side panel exists for a selected node')
  const notesStrings = harness.collectStrings(notesPanel)
  assert.ok(notesStrings.indexOf('some notes') >= 0, 'notes are shown')

  const linkSetup = harness.setup({ stateOverrides: { 3: 'c' } })
  const linkCard = linkSetup.Card({ phase: 'result', block: { meta: treeMeta() }, t: undefined })
  const linkPanel = harness.findElement(linkCard, function (node) {
    return node.props['aria-label'] === '节点详情'
  })
  const linkStrings = harness.collectStrings(linkPanel)
  assert.ok(linkStrings.indexOf('https://example.com/doc') >= 0, 'href is shown')
  assert.ok(linkStrings.indexOf('x') >= 0 && linkStrings.indexOf('y') >= 0, 'labels are shown')
  const anchor = harness.findElement(linkPanel, function (node) {
    return node.type === 'a'
  })
  assert.equal(anchor.props.href, 'https://example.com/doc')
  assert.equal(anchor.props.rel, 'noreferrer noopener')
})

test('map view renders collapsed nodes and the Mermaid source toggle', function () {
  const collapsedSetup = harness.setup({ stateOverrides: { 2: new Set(['a']) } })
  const collapsedCard = collapsedSetup.Card({ phase: 'result', block: { meta: treeMeta() }, t: undefined })
  const collapsedStrings = harness.collectStrings(collapsedCard)
  assert.equal(collapsedStrings.indexOf('Alpha child one'), -1, 'collapsed descendant is not drawn')
  assert.ok(collapsedStrings.indexOf('+1') >= 0, 'collapsed child count badge')

  const mermaidSetup = harness.setup({ stateOverrides: { 6: true } })
  const mermaidCard = mermaidSetup.Card({ phase: 'result', block: { meta: treeMeta() }, t: undefined })
  const mermaidStrings = harness.collectStrings(mermaidCard)
  assert.ok(mermaidStrings.indexOf('mindmap\n  Root') >= 0, 'mermaid source is rendered')
})


test('client.js is read-only and free of global side effects', function () {
  const loaded = harness.loadClient()
  const source = loaded.source
  assert.equal(source.indexOf('document.body'), -1)
  assert.equal(source.indexOf('document.createElement'), -1)
  assert.equal(source.indexOf('createElement(\'style\')'), -1)
  assert.equal(source.indexOf('<style'), -1)
  assert.equal(source.indexOf('localStorage'), -1)
  assert.ok(source.indexOf('var(--dsw-alias-') >= 0, 'uses design tokens with fallbacks')
  assert.ok(/var\(--dsw-alias-[a-z0-9-]+,\s*[^)]+\)/.test(source), 'every token has a literal fallback')
})
