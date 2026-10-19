// Contract tests for lib/markdown.js: every row of CONTRACT.md section 3 markdown <-> tree mapping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, parseMarkdownToTree, treeToMarkdown } from '../lib/markdown.js'
import { flattenTree } from '../lib/tree.js'

function depths(root) {
  return flattenTree(root).map((entry) => entry.depth)
}

function titles(root) {
  return flattenTree(root).map((entry) => entry.node.title)
}

test('empty input yields a single root and the empty warning', () => {
  const { root, warnings } = parseMarkdown('   \n\t\n', { fileName: 'Empty Doc.md' })
  assert.deepEqual(root, { id: 'md-1', title: 'Empty Doc', children: { attached: [] } })
  assert.deepEqual(warnings, ['文件为空或只包含空白字符'])

  assert.equal(parseMarkdown('').root.title, 'Untitled')
  assert.equal(parseMarkdown(undefined).root.title, 'Untitled')
})

test('no level-1 heading uses the file name stem as root title', () => {
  const { root, warnings } = parseMarkdown('- a\n- b\n', { fileName: 'C:\\docs\\My Notes.markdown' })
  assert.equal(root.title, 'My Notes')
  assert.deepEqual(titles(root), ['My Notes', 'a', 'b'])
  assert.deepEqual(depths(root), [1, 2, 2])
  assert.equal(root.id, 'md-1')
  assert.equal(root.children.attached[0].id, 'md-2')
  assert.deepEqual(warnings, [])
})

test('first level-1 heading is the root; later level-1 headings become root children', () => {
  const md = '# Root\n## A\n### A1\n# Second\n## B\n'
  const { root } = parseMarkdown(md)
  assert.equal(root.title, 'Root')
  assert.deepEqual(titles(root), ['Root', 'A', 'A1', 'Second', 'B'])
  assert.deepEqual(depths(root), [1, 2, 3, 2, 2])
  assert.equal(root.children.attached[0].title, 'A')
  assert.equal(root.children.attached[1].title, 'Second')
  assert.equal(root.children.attached[2].title, 'B')
})

test('heading levels map to depths 2..6 and tolerate level 7+', () => {
  const md = '# R\n## L2\n### L3\n#### L4\n##### L5\n###### L6\n####### L7\n######## L8\n'
  const { root } = parseMarkdown(md)
  assert.deepEqual(titles(root), ['R', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'])
  assert.deepEqual(depths(root), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(root.children.attached[0].children.attached[0].children.attached[0].title, 'L4')
})

test('headings before the first level-1 heading attach under the eventual root', () => {
  const md = '## Early\nearly note\n\n# Root\n\n## Late\n'
  const { root } = parseMarkdown(md)
  assert.equal(root.title, 'Root')
  assert.deepEqual(titles(root), ['Root', 'Early', 'Late'])
  assert.equal(root.children.attached[0].notes, 'early note')
  assert.equal(root.children.attached[0].id, 'md-2')
  assert.equal(root.children.attached[1].id, 'md-3')
})

test('ATX closing hashes are stripped from titles', () => {
  const { root } = parseMarkdown('# Root ##\n## Child ###\n')
  assert.equal(root.title, 'Root')
  assert.equal(root.children.attached[0].title, 'Child')
})

test('unordered lists nest by 2-space indentation and drop markers', () => {
  const md = '# R\n- a\n  - b\n    - c\n* d\n'
  const { root } = parseMarkdown(md)
  assert.deepEqual(titles(root), ['R', 'a', 'b', 'c', 'd'])
  assert.deepEqual(depths(root), [1, 2, 3, 4, 2])
  const a = root.children.attached[0]
  assert.equal(a.children.attached[0].title, 'b')
  assert.equal(a.children.attached[0].children.attached[0].title, 'c')
})

test('ordered lists behave like unordered lists and drop the marker', () => {
  const md = '# R\n1. one\n2. two\n   1) child\n'
  const { root } = parseMarkdown(md)
  assert.deepEqual(titles(root), ['R', 'one', 'two', 'child'])
  assert.deepEqual(depths(root), [1, 2, 2, 3])
})

test('a single tab is one indentation unit', () => {
  const { root } = parseMarkdown('# R\n- a\n\t- b\n')
  assert.deepEqual(titles(root), ['R', 'a', 'b'])
  assert.deepEqual(depths(root), [1, 2, 3])
})

test('mixed space/tab indentation warns once and keeps the first-seen unit', () => {
  const warnings = []
  const md = '# R\n- a\n  - b\n\t- c\n'
  const { root } = parseMarkdown(md, { warnings })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /第 4 行/)
  assert.match(warnings[0], /列表缩进混用空格与 Tab/)
  assert.deepEqual(titles(root), ['R', 'a', 'b', 'c'])
  assert.deepEqual(depths(root), [1, 2, 3, 3])
})

test('paragraphs after a heading become notes; subsequent paragraphs append', () => {
  const md = '# R\nfirst line\nsecond line\n\nsecond para\n\n## A\n- item\ndetail one\n\ndetail two\n'
  const { root } = parseMarkdown(md)
  assert.equal(root.notes, 'first line\nsecond line\n\nsecond para')
  const item = root.children.attached[0].children.attached[0]
  assert.equal(item.title, 'item')
  assert.equal(item.notes, 'detail one\n\ndetail two')
})

test('a paragraph with no preceding heading/list becomes a root child', () => {
  const { root } = parseMarkdown('A standalone paragraph with   extra spaces.\n', { fileName: 'Notes.md' })
  assert.equal(root.title, 'Notes')
  const child = root.children.attached[0]
  assert.equal(child.title, 'A standalone paragraph with extra spaces.')
  assert.equal(child.notes, 'A standalone paragraph with   extra spaces.')
  assert.equal(child.id, 'md-2')
})

test('standalone paragraph titles collapse whitespace and cap at 80 characters', () => {
  const long = `${'word '.repeat(30)}tail`
  const { root } = parseMarkdown(long)
  const child = root.children.attached[0]
  assert.equal(child.title.length, 80)
  assert.ok(long.startsWith(child.title))
  assert.equal(child.notes, long.trim())

  const multi = parseMarkdown('line one\nline two\n')
  assert.equal(multi.root.children.attached[0].title, 'line one')
  assert.equal(multi.root.children.attached[0].notes, 'line one\nline two')
})

test('exactly one Markdown link sets title and href on headings and list items', () => {
  const { root } = parseMarkdown('# [Home](https://h.example)\n## [Site](https://example.com/path?q=1)\n- [Doc](https://x/y)\n- [W](https://e/a_(b))\n')
  assert.equal(root.title, 'Home')
  assert.equal(root.href, 'https://h.example')
  const site = root.children.attached[0]
  const [doc, nested] = site.children.attached
  assert.equal(site.title, 'Site')
  assert.equal(site.href, 'https://example.com/path?q=1')
  assert.equal(doc.title, 'Doc')
  assert.equal(doc.href, 'https://x/y')
  assert.equal(nested.title, 'W')
  assert.equal(nested.href, 'https://e/a_(b)')
})

test('links mixed with other text stay literal and do not set href', () => {
  const { root } = parseMarkdown('# R\n## See [Site](https://example.com)\n- see [Site](https://e)\n')
  const heading = root.children.attached[0]
  const list = heading.children.attached[0]
  assert.equal(heading.title, 'See [Site](https://example.com)')
  assert.equal(heading.href, undefined)
  assert.equal(list.title, 'see [Site](https://e)')
  assert.equal(list.href, undefined)
})

test('fenced code under a heading degrades into that node notes with a Chinese warning', () => {
  const md = '# R\n## A\n```js\nconst x = 1\n```\n'
  const { root, warnings } = parseMarkdown(md)
  const a = root.children.attached[0]
  assert.equal(
    a.notes,
    '该内容类型暂不支持 XMind 结构映射:\n```js\nconst x = 1\n```',
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /第 3 行/)
  assert.match(warnings[0], /代码块/)
})

test('fenced code without an enclosing node becomes a 代码块 root child', () => {
  const { root, warnings } = parseMarkdown('```text\nhello\n```\n', { fileName: 'code.md' })
  assert.equal(root.title, 'code')
  const child = root.children.attached[0]
  assert.equal(child.title, '代码块')
  assert.equal(child.notes, '```text\nhello\n```')
  assert.equal(child.id, 'md-2')
  assert.match(warnings[0], /第 1 行：暂不支持代码块/)
})

test('unclosed fenced code degrades without throwing', () => {
  const { root, warnings } = parseMarkdown('# R\n## A\n```\nunclosed\n')
  assert.match(root.children.attached[0].notes, /unclosed/)
  assert.equal(warnings.length, 1)
})

test('tables degrade into enclosing notes with a warning', () => {
  const md = '# R\n## T\n| a | b |\n| - | - |\n| 1 | 2 |\n'
  const { root, warnings } = parseMarkdown(md)
  const t = root.children.attached[0]
  assert.equal(
    t.notes,
    '该内容类型暂不支持 XMind 结构映射:\n| a | b |\n| - | - |\n| 1 | 2 |',
  )
  assert.match(warnings[0], /第 3 行：暂不支持表格/)

  const dashed = parseMarkdown('# R\n| a | b |\n| --- | --- |\n| 1 | 2 |\n')
  assert.match(dashed.warnings[0], /暂不支持表格/)
  assert.match(dashed.root.notes, /\| 1 \| 2 \|/)
})

test('each degraded element gets its own marker and warning in the same node', () => {
  const md =
    '# R\n## Code\n\n' +
    '```js\nconst x = 1\n```\n\n' +
    '| a | b |\n| - | - |\n| 1 | 2 |\n\n' +
    '![alt](https://example.com/i.png)\n\n' +
    '> quoted line\n'
  const { root, warnings } = parseMarkdown(md)
  const code = root.children.attached[0]
  assert.equal(warnings.length, 4)
  for (const kind of ['代码块', '表格', '图片', '引用块']) {
    assert.ok(warnings.some((warning) => warning.includes(kind)), `missing ${kind} warning: ${JSON.stringify(warnings)}`)
  }
  assert.equal((code.notes.match(/该内容类型暂不支持 XMind 结构映射:/g) || []).length, 4)
  assert.match(code.notes, /const x = 1/)
  assert.match(code.notes, /\| 1 \| 2 \|/)
  assert.match(code.notes, /!\[alt\]\(https:\/\/example\.com\/i\.png\)/)
  assert.match(code.notes, /> quoted line/)
})

test('images degrade into notes or a 图片 root child', () => {
  const withHeading = parseMarkdown('# R\n![alt](pic.png)\n')
  assert.match(withHeading.root.notes, /该内容类型暂不支持/)
  assert.match(withHeading.root.notes, /!\[alt\]\(pic\.png\)/)
  assert.match(withHeading.warnings[0], /第 2 行：暂不支持图片/)

  const standalone = parseMarkdown('![alt](pic.png)\n', { fileName: 'img.md' })
  assert.equal(standalone.root.children.attached[0].title, '图片')
  assert.equal(standalone.root.children.attached[0].notes, '![alt](pic.png)')
})

test('blockquotes degrade into notes or a 引用块 root child', () => {
  const withHeading = parseMarkdown('# R\n> quote line\n> second\n')
  assert.equal(
    withHeading.root.notes,
    '该内容类型暂不支持 XMind 结构映射:\n> quote line\n> second',
  )
  assert.match(withHeading.warnings[0], /第 2 行：暂不支持引用块/)

  const standalone = parseMarkdown('> quote\n', { fileName: 'q.md' })
  assert.equal(standalone.root.children.attached[0].title, '引用块')
  assert.equal(standalone.root.children.attached[0].notes, '> quote')
})

test('empty list items fall back to Untitled', () => {
  const { root } = parseMarkdown('# R\n-\n')
  assert.equal(root.children.attached[0].title, 'Untitled')
})

test('markdown node ids are md-<n> in document pre-order', () => {
  const md = '# R\n## A\n- a1\n  - a2\n\n### B\npara\n\n## C\n'
  const { root } = parseMarkdown(md)
  const ids = flattenTree(root).map((entry) => entry.node.id)
  assert.deepEqual(ids, ids.map((_id, index) => `md-${index + 1}`))
})

test('parseMarkdown reuses the caller warnings array', () => {
  const warnings = []
  const result = parseMarkdown('# R\n', { warnings })
  assert.equal(result.warnings, warnings)
  assert.equal(warnings.length, 0)
  parseMarkdown('  ', { warnings })
  assert.deepEqual(warnings, ['文件为空或只包含空白字符'])
})

test('parseMarkdownToTree is an alias of parseMarkdown', () => {
  assert.equal(parseMarkdownToTree, parseMarkdown)
})

test('treeToMarkdown emits stable normalized Markdown', () => {
  const tree = {
    id: 'r',
    title: 'Root',
    notes: 'root notes',
    children: {
      attached: [
        { id: 'a', title: 'Alpha', children: { attached: [{ id: 'a1', title: 'A1', children: { attached: [] } }] } },
        { id: 'b', title: 'Beta', href: 'https://b.example', labels: ['x', 'y'], children: { attached: [] } },
      ],
    },
  }
  const md = treeToMarkdown(tree)
  assert.equal(
    md,
    '# Root\n\nroot notes\n\n## Alpha\n\n### A1\n\n## [Beta](https://b.example) #x #y\n',
  )
  assert.ok(md.endsWith('\n'))
  assert.ok(!md.endsWith('\n\n'))
  assert.ok(!md.includes('\r'))
  assert.ok(!/\n\n\n/.test(md))
})

test('treeToMarkdown normalizes CRLF and multi-line titles', () => {
  const tree = {
    id: 'r',
    title: 'Root',
    notes: 'a\r\nb\r\n',
    children: { attached: [{ id: 'c', title: 'Child\r\nTitle', children: { attached: [] } }] },
  }
  assert.equal(treeToMarkdown(tree), '# Root\n\na\nb\n\n## Child Title\n')
  assert.ok(!treeToMarkdown(tree).includes('\r'))
})

test('treeToMarkdown prepends the original depth note for depth > 6', () => {
  let root = { id: 'n1', title: 'L1', children: { attached: [] } }
  let cursor = root
  for (let depth = 2; depth <= 7; depth += 1) {
    const node = {
      id: `n${depth}`,
      title: `L${depth}`,
      children: { attached: [] },
      ...(depth === 7 ? { notes: 'deep notes' } : {}),
    }
    cursor.children.attached.push(node)
    cursor = node
  }
  const md = treeToMarkdown(root)
  assert.match(md, /###### L7\n\n原始层级深度: 7\n\ndeep notes\n$/)
  assert.equal(md.match(/原始层级深度: 7/g).length, 1)

  cursor.notes = '原始层级深度: 7\n\nkept once'
  const deduped = treeToMarkdown(root)
  assert.equal(deduped.match(/原始层级深度: 7/g).length, 1)
  assert.match(deduped, /kept once/)
})

test('treeToMarkdown rejects an invalid root', () => {
  assert.throws(() => treeToMarkdown(null), TypeError)
  assert.throws(() => treeToMarkdown('x'), TypeError)
})

test('treeToMarkdown output is stable under reparse', () => {
  const tree = {
    id: 'r',
    title: 'Root',
    href: 'https://root.example',
    labels: ['home'],
    children: {
      attached: [
        { id: 'c', title: 'Child', notes: 'note', labels: ['tag'], children: { attached: [] } },
      ],
    },
  }
  const once = treeToMarkdown(tree)
  const twice = treeToMarkdown(parseMarkdown(once).root)
  assert.equal(twice, once)
})

test('parse -> treeToMarkdown -> parse round-trips titles, structure, notes and hrefs', () => {
  const sample =
    '# Project\n\n' +
    'Overview paragraph.\n\n' +
    '## Plan\n\n' +
    '- Alpha\n' +
    '  - Alpha child\n' +
    '- Beta\n\n' +
    '### Details\n\n' +
    'Some details.\n\n' +
    '## Links\n\n' +
    '- [Site](https://example.com)\n'
  const first = parseMarkdown(sample)
  const md = treeToMarkdown(first.root)
  const second = parseMarkdown(md)
  assert.deepEqual(second.root, first.root)
  assert.deepEqual(second.warnings, [])
  assert.equal(md, treeToMarkdown(second.root))
})
