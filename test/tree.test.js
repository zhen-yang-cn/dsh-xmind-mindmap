// Contract tests for lib/tree.js (schema, normalization, traversal, validation).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TREE_NODE_JSON_SCHEMA,
  createNode,
  normalizeTree,
  walkTree,
  flattenTree,
  findNode,
  countNodes,
  treeDepth,
  collectIds,
  generateId,
  cloneTree,
  validateTree,
  assertTree,
  countWithField,
} from '../lib/tree.js'

function sampleTree() {
  return {
    id: 'r',
    title: 'Root',
    children: {
      attached: [
        { id: 'a', title: 'A', notes: 'a note', children: { attached: [{ id: 'a1', title: 'A1', children: { attached: [] } }] } },
        { id: 'b', title: 'B', href: 'https://example.com', labels: ['x', 'y'], children: { attached: [] } },
      ],
    },
  }
}

test('TREE_NODE_JSON_SCHEMA is the recursive-safe json value schema', () => {
  assert.deepEqual(TREE_NODE_JSON_SCHEMA, { type: 'json' })
})

test('createNode fills canonical shape and drops empty optional fields', () => {
  const node = createNode({
    id: 'n1',
    title: '  Root title  ',
    notes: '   ',
    href: '   ',
    labels: [' a ', 'a', 'b', '', 42],
    children: [{ id: 'c1', title: 'Child' }],
    unknown: 'dropped',
  })
  assert.deepEqual(node, {
    id: 'n1',
    title: 'Root title',
    children: { attached: [{ id: 'c1', title: 'Child', children: { attached: [] } }] },
    labels: ['a', 'b'],
  })
})

test('createNode accepts children.attached and applies Untitled fallback', () => {
  const node = createNode({
    title: '   ',
    children: { attached: [{ id: 'x', title: 'X' }] },
  })
  assert.equal(node.id, 'node')
  assert.equal(node.title, 'Untitled')
  assert.equal(node.children.attached.length, 1)
  assert.equal(node.children.attached[0].title, 'X')
})

test('normalizeTree assigns collision-free ids and drops empties', () => {
  const warnings = []
  const raw = {
    id: 'root',
    title: 'Root',
    children: {
      attached: [
        { title: 'A', notes: 'note', href: ' https://a.example ', labels: ['l1', 'l1', ' l2 '] },
        { id: 'root', title: 'Duplicate' },
        { id: 'b', title: '   ' },
      ],
    },
  }
  const result = normalizeTree(raw, { idPrefix: 'x', warnings })
  assert.equal(result.warnings, warnings)
  assert.equal(result.root.id, 'root')
  const children = result.root.children.attached
  assert.equal(children[0].id, 'x1')
  assert.equal(children[0].href, 'https://a.example')
  assert.deepEqual(children[0].labels, ['l1', 'l2'])
  assert.equal(children[1].id, 'x2')
  assert.equal(children[2].id, 'b')
  assert.equal(children[2].title, 'Untitled')
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /id 重复/)
  assert.match(warnings[1], /标题为空/)
})

test('normalizeTree accepts bare child arrays and warns on non-array children', () => {
  const { root } = normalizeTree({ title: 'Root', children: [{ title: 'A' }] })
  assert.equal(root.children.attached.length, 1)

  const warnings = []
  const bad = normalizeTree({ title: 'Root', children: 'nope' }, { warnings })
  assert.equal(bad.root.children.attached.length, 0)
  assert.match(warnings[0], /children 字段不是数组/)
})

test('normalizeTree truncates below maxDepth with one warning', () => {
  const warnings = []
  const { root } = normalizeTree(
    {
      title: 'one',
      children: {
        attached: [{ title: 'two', children: { attached: [{ title: 'three', children: { attached: [{ title: 'four' }] } }] } }],
      },
    },
    { maxDepth: 2, warnings },
  )
  assert.equal(root.children.attached[0].title, 'two')
  assert.equal(root.children.attached[0].children.attached.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /截断/)
})

test('normalizeTree replaces invalid raw input with a placeholder root', () => {
  const warnings = []
  const { root } = normalizeTree(null, { warnings })
  assert.equal(root.title, 'Untitled')
  assert.match(root.id, /^t\d+$/)
  assert.match(warnings[0], /节点数据无效/)
})

test('walkTree is pre-order with depth and parent', () => {
  const root = sampleTree()
  const seen = []
  const visited = walkTree(root, (node, depth, parent) => {
    seen.push([node.id, depth, parent ? parent.id : null])
  })
  assert.equal(visited, 4)
  assert.deepEqual(seen, [
    ['r', 1, null],
    ['a', 2, 'r'],
    ['a1', 3, 'a'],
    ['b', 2, 'r'],
  ])
})

test('flattenTree reports parent and sibling index', () => {
  const flat = flattenTree(sampleTree())
  assert.deepEqual(
    flat.map((entry) => [entry.node.id, entry.depth, entry.parent ? entry.parent.id : null, entry.index]),
    [
      ['r', 1, null, -1],
      ['a', 2, 'r', 0],
      ['a1', 3, 'a', 0],
      ['b', 2, 'r', 1],
    ],
  )
})

test('findNode, countNodes, treeDepth and collectIds', () => {
  const root = sampleTree()
  assert.deepEqual(findNode(root, 'a1'), { node: root.children.attached[0].children.attached[0], parent: root.children.attached[0], index: 0, depth: 3 })
  assert.equal(findNode(root, 'r').depth, 1)
  assert.equal(findNode(root, 'r').parent, null)
  assert.equal(findNode(root, 'missing'), null)
  assert.equal(countNodes(root), 4)
  assert.equal(countNodes(null), 0)
  assert.equal(treeDepth(root), 3)
  assert.equal(treeDepth(null), 0)
  assert.deepEqual([...collectIds(root)], ['r', 'a', 'a1', 'b'])
})

test('generateId avoids existing ids and honours prefix', () => {
  assert.equal(generateId(new Set(['n1', 'n2'])), 'n3')
  assert.equal(generateId(['x1'], 'x'), 'x2')
  assert.equal(generateId(undefined), 'n1')
})

test('cloneTree is a deep clone', () => {
  const root = sampleTree()
  const clone = cloneTree(root)
  assert.deepEqual(clone, root)
  assert.notEqual(clone, root)
  clone.children.attached[0].title = 'changed'
  assert.equal(root.children.attached[0].title, 'A')
})

test('validateTree accepts a canonical tree and assertTree does not throw', () => {
  assert.deepEqual(validateTree(sampleTree()), [])
  assert.doesNotThrow(() => assertTree(sampleTree()))
})

test('validateTree catches duplicate ids, empty fields and missing children', () => {
  const duplicate = {
    id: 'r',
    title: 'R',
    children: {
      attached: [
        { id: 'x', title: 'X', children: { attached: [] } },
        { id: 'x', title: 'Y', children: { attached: [] } },
      ],
    },
  }
  assert.match(validateTree(duplicate).join(';'), /id 重复/)

  const empty = { id: '   ', title: '', children: { attached: [] }, notes: '  ', labels: [] }
  const violations = validateTree(empty).join(';')
  assert.match(violations, /非空字符串 id/)
  assert.match(violations, /title 必须是非空字符串/)
  assert.match(violations, /notes 必须是非空字符串/)
  assert.match(violations, /labels 必须是非空数组/)

  assert.match(validateTree({ id: 'r', title: 'R' }).join(';'), /children\.attached 必须是数组/)
  assert.match(validateTree([{ id: 'r', title: 'R' }]).join(';'), /根节点必须是普通对象/)
  assert.throws(() => assertTree(duplicate), /^Error: invalid tree: /)
})

test('validateTree catches duplicate labels and non-plain nodes', () => {
  const labels = { id: 'r', title: 'R', labels: ['a', 'a'], children: { attached: [] } }
  assert.match(validateTree(labels).join(';'), /labels 存在重复项/)

  const nonPlain = { id: 'r', title: 'R', children: { attached: [new Date()] } }
  assert.match(validateTree(nonPlain).join(';'), /必须是普通对象/)
})

test('validateTree detects cycles and over-deep chains', () => {
  const cycle = { id: 'a', title: 'A', children: { attached: [] } }
  cycle.children.attached.push(cycle)
  assert.match(validateTree(cycle).join(';'), /循环引用/)

  const deep = { id: 'n0', title: 'n0', children: { attached: [] } }
  let cursor = deep
  for (let i = 1; i <= 513; i += 1) {
    const node = { id: `n${i}`, title: `n${i}`, children: { attached: [] } }
    cursor.children.attached.push(node)
    cursor = node
  }
  assert.match(validateTree(deep).join(';'), /512/)
})

test('countWithField counts non-empty notes/href/labels', () => {
  const root = sampleTree()
  assert.equal(countWithField(root, 'notes'), 1)
  assert.equal(countWithField(root, 'href'), 1)
  assert.equal(countWithField(root, 'labels'), 1)
  assert.equal(countWithField(root, 'missing'), 0)
})
