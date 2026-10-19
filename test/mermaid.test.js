// Contract tests for lib/mermaid.js (escaping, deterministic mindmap serialization, caps).
import test from 'node:test'
import assert from 'node:assert/strict'
import { escapeMermaidLabel, treeToMermaid, isMindmapSupported } from '../lib/mermaid.js'

test('escapeMermaidLabel escapes Mermaid syntax characters', () => {
  assert.equal(escapeMermaidLabel('a(b)[c]{d}<e>"f"'), 'a\\(b\\)\\[c\\]\\{d\\}\\<e\\>\\"f\\"')
  assert.equal(escapeMermaidLabel("it's:ok;no#way`x`"), "it\\'s\\:ok\\;no\\#way\\`x\\`")
  assert.equal(escapeMermaidLabel('plain 中文'), 'plain 中文')
  assert.equal(escapeMermaidLabel(null), '')
  assert.equal(escapeMermaidLabel(undefined), '')
})

test('escapeMermaidLabel flattens newlines to spaces', () => {
  assert.equal(escapeMermaidLabel('line1\nline2\r\nline3\rline4'), 'line1 line2 line3 line4')
})

test('treeToMermaid emits mindmap with two-space indentation, notes and labels', () => {
  const root = {
    id: 'r',
    title: 'Root',
    children: {
      attached: [
        {
          id: 'a',
          title: 'A (x)',
          notes: 'note',
          children: { attached: [{ id: 'a1', title: 'A1', children: { attached: [] } }] },
        },
        { id: 'b', title: 'B', labels: ['l1', 'l2'], children: { attached: [] } },
      ],
    },
  }
  const expected =
    'mindmap\n' +
    'Root\n' +
    '  A \\(x\\) [备注]\n' +
    '    A1\n' +
    '  B #l1 #l2\n'
  assert.equal(treeToMermaid(root), expected)
  assert.equal(treeToMermaid(root), expected) // deterministic
  assert.ok(treeToMermaid(root).startsWith('mindmap\n'))
  assert.ok(treeToMermaid(root).endsWith('\n'))
})

test('treeToMermaid uses the configured indent unit', () => {
  const root = {
    id: 'r',
    title: 'R',
    children: { attached: [{ id: 'c', title: 'C', children: { attached: [] } }] },
  }
  assert.equal(treeToMermaid(root, { indent: '\t' }), 'mindmap\nR\n\tC\n')
})

test('treeToMermaid caps nodes and appends a truncated leaf', () => {
  const root = {
    id: 'r',
    title: 'R',
    children: {
      attached: [
        { id: 'a', title: 'A', children: { attached: [{ id: 'a1', title: 'A1', children: { attached: [] } }] } },
        { id: 'b', title: 'B', children: { attached: [] } },
      ],
    },
  }
  assert.equal(treeToMermaid(root, { maxNodes: 3 }), 'mindmap\nR\n  A\n    A1\n      ... (truncated)\n')
  assert.equal(treeToMermaid(root, { maxNodes: 1 }), 'mindmap\nR\n  ... (truncated)\n')
  assert.equal(treeToMermaid(root, { maxNodes: 4 }), 'mindmap\nR\n  A\n    A1\n  B\n')
  assert.ok(!treeToMermaid(root, { maxNodes: 4 }).includes('(truncated)'))
})

test('treeToMermaid handles an absent root and escapes labels', () => {
  assert.equal(treeToMermaid(null), 'mindmap\n')
  const root = {
    id: 'r',
    title: 'R',
    labels: ['a#b'],
    children: { attached: [] },
  }
  assert.equal(treeToMermaid(root), 'mindmap\nR #a\\#b\n')
})

test('isMindmapSupported documents the degraded profile', () => {
  assert.equal(isMindmapSupported(), false)
})
