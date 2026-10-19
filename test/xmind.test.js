// Contract tests for lib/xmind.js (XMind 2020 JSON / XMind 8 XML read + write).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readZip, writeZip } from '../lib/zip.js'
import {
  buildContentJson,
  buildContentXml,
  buildXmindBuffer,
  parseXmindBuffer,
} from '../lib/xmind.js'
import { parseXml, findChild, findChildren, textOf } from '../lib/xml.js'

const MIMETYPE = 'application/vnd.xmind.workbook'

function zipOf(entries) {
  return writeZip([
    { name: 'mimetype', data: Buffer.from(MIMETYPE, 'utf8'), store: true },
    ...entries,
  ])
}

function sampleTree() {
  return {
    id: 'root',
    title: '中心主题 🌟',
    children: {
      attached: [
        {
          id: 'branch-a',
          title: '分支 A & <tag>',
          notes: '第一行备注\n第二行备注',
          href: 'https://example.com/?a=1&b=2',
          labels: ['标签1', '标签 2'],
          children: {
            attached: [
              { id: 'leaf-a1', title: '子节点 "引号"', children: { attached: [] } },
            ],
          },
        },
        { id: 'branch-b', title: '分支 B', children: { attached: [] } },
      ],
    },
  }
}

function collectIds(root) {
  const ids = []
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    ids.push(node.id)
    for (const child of node.children.attached) stack.push(child)
  }
  return ids
}

const XMIND8_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">
  <sheet id="sheet-one">
    <title>工作表 &amp; 1</title>
    <topic id="root-topic">
      <title>根 &lt;主题&gt; &amp; 更多</title>
      <notes><plain>备注 &amp; 说明</plain></notes>
      <labels><label>A</label><label>B</label><label>A</label></labels>
      <href>https://example.com/?x=1&amp;y=2</href>
      <children>
        <topics type="attached">
          <topic id="child-topic"><title>子 &quot;一&quot;</title><marker-refs><marker-ref marker-id="star-red"/></marker-refs></topic>
        </topics>
        <topics type="detached">
          <topic id="floating"><title>浮动主题</title></topic>
        </topics>
        <topics type="summary">
          <topic id="summary"><title>摘要主题</title></topic>
        </topics>
      </children>
    </topic>
  </sheet>
  <sheet id="sheet-two"><title>第二页</title><topic id="root-two"><title>第二根</title></topic></sheet>
</xmap-content>`

test('buildXmindBuffer -> parseXmindBuffer round-trips hierarchy, titles, notes, href and labels', () => {
  const tree = sampleTree()
  const buffer = buildXmindBuffer(tree)
  const parsed = parseXmindBuffer(buffer)

  assert.equal(parsed.format, 'json')
  assert.equal(parsed.sheetTitle, 'Sheet 1')
  assert.equal(parsed.sheetCount, 1)
  assert.deepEqual(parsed.sheets, [{ id: 'sheet-root', title: 'Sheet 1' }])
  assert.deepEqual(parsed.rootTopic, tree)
  assert.deepEqual(parsed.warnings, [])
})

test('buildXmindBuffer emits the contract entry set, mimetype stored first', () => {
  const buffer = buildXmindBuffer(sampleTree(), { sheetTitle: '自定义 Sheet' })
  const zip = readZip(buffer)

  assert.deepEqual([...zip.keys()], [
    'mimetype',
    'content.json',
    'content.xml',
    'metadata.json',
    'manifest.json',
    'META-INF/manifest.xml',
  ])
  assert.equal(zip.get('mimetype').toString('utf8'), MIMETYPE)

  // First local header: method 0 (store), fixed DOS timestamp 1980-01-01.
  assert.equal(buffer.readUInt32LE(0), 0x04034b50)
  assert.equal(buffer.readUInt16LE(8), 0)
  assert.equal(buffer.readUInt16LE(10), 0)
  assert.equal(buffer.readUInt16LE(12), 0x0021)
  assert.equal(buffer.subarray(30, 38).toString('utf8'), 'mimetype')

  const metadata = JSON.parse(zip.get('metadata.json').toString('utf8'))
  assert.equal(metadata.activeSheetId, 'sheet-root')
  const manifest = JSON.parse(zip.get('manifest.json').toString('utf8'))
  for (const name of [
    'content.json',
    'content.xml',
    'metadata.json',
    'manifest.json',
    'META-INF/manifest.xml',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(manifest['file-entries'], name))
  }
  assert.match(
    zip.get('META-INF/manifest.xml').toString('utf8'),
    /full-path="content\.xml"/,
  )
})

test('buildXmindBuffer is deterministic and honors sheetTitle', () => {
  const first = buildXmindBuffer(sampleTree(), { sheetTitle: '计划' })
  const second = buildXmindBuffer(sampleTree(), { sheetTitle: '计划' })
  assert.deepEqual(first, second)

  const parsed = parseXmindBuffer(first)
  assert.equal(parsed.sheetTitle, '计划')
  assert.equal(parsed.sheets[0].title, '计划')
})

test('content.xml compatibility stub carries the same tree and parses standalone', () => {
  const tree = sampleTree()
  const buffer = buildXmindBuffer(tree, { sheetTitle: 'XML 兼容' })
  const zip = readZip(buffer)
  const xml = zip.get('content.xml').toString('utf8')

  assert.match(xml, /<xmap-content/)
  const document = parseXml(xml)
  const content = findChild(document, 'xmap-content')
  const sheet = findChild(content, 'sheet')
  assert.equal(textOf(findChild(sheet, 'title')), 'XML 兼容')
  const rootElement = findChild(sheet, 'topic')
  assert.equal(textOf(findChild(rootElement, 'title')), '中心主题 🌟')
  assert.equal(textOf(findChild(rootElement, 'notes')).length, 0) // notes are on a child

  const xmlOnly = writeZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'content.xml', data: xml },
  ])
  const parsed = parseXmindBuffer(xmlOnly)
  assert.equal(parsed.format, 'xml')
  assert.equal(parsed.sheetTitle, 'XML 兼容')
  assert.deepEqual(parsed.rootTopic, tree)
  assert.deepEqual(parsed.warnings, [])
})

test('buildContentJson returns a one-sheet XMind 2020 array', () => {
  const value = buildContentJson(sampleTree(), '标题')
  assert.ok(Array.isArray(value))
  assert.equal(value.length, 1)
  const sheet = value[0]
  assert.equal(sheet.class, 'sheet')
  assert.equal(sheet.id, 'sheet-root')
  assert.equal(sheet.title, '标题')
  assert.equal(sheet.rootTopic.class, 'topic')
  assert.equal(sheet.rootTopic.title, '中心主题 🌟')

  const branch = sheet.rootTopic.children.attached[0]
  assert.equal(branch.id, 'branch-a')
  assert.equal(branch.notes.plain.content, '第一行备注\n第二行备注')
  assert.deepEqual(branch.labels, ['标签1', '标签 2'])
  assert.equal(branch.href, 'https://example.com/?a=1&b=2')
  assert.equal(branch.children.attached[0].title, '子节点 "引号"')
  assert.equal(branch.children.attached[0].children, undefined)
})

test('buildContentXml escapes XML-special characters and stays parseable', () => {
  const tree = sampleTree()
  const xml = buildContentXml(tree, 'A & B <sheet> "q"')
  assert.match(xml, /A &amp; B &lt;sheet&gt; "q"/)
  assert.match(xml, /分支 A &amp; &lt;tag&gt;/)

  const document = parseXml(xml)
  const sheet = findChild(findChild(document, 'xmap-content'), 'sheet')
  assert.equal(textOf(findChild(sheet, 'title')), 'A & B <sheet> "q"')
  assert.equal(textOf(findChild(findChild(sheet, 'topic'), 'title')), '中心主题 🌟')

  const xmlOnly = writeZip([
    { name: 'mimetype', data: MIMETYPE },
    { name: 'content.xml', data: xml },
  ])
  assert.deepEqual(parseXmindBuffer(xmlOnly).rootTopic, tree)
})

test('parseXmindBuffer reads XMind 8 content.xml with multi-sheet selection', () => {
  const buffer = zipOf([{ name: 'content.xml', data: XMIND8_XML }])
  const first = parseXmindBuffer(buffer)

  assert.equal(first.format, 'xml')
  assert.equal(first.sheetCount, 2)
  assert.equal(first.sheetTitle, '工作表 & 1')
  assert.deepEqual(first.sheets, [
    { id: 'sheet-one', title: '工作表 & 1' },
    { id: 'sheet-two', title: '第二页' },
  ])

  const root = first.rootTopic
  assert.equal(root.id, 'root-topic')
  assert.equal(root.title, '根 <主题> & 更多')
  assert.equal(root.notes, '备注 & 说明')
  assert.equal(root.href, 'https://example.com/?x=1&y=2')
  assert.deepEqual(root.labels, ['A', 'B'])
  assert.equal(root.children.attached.length, 1)
  assert.equal(root.children.attached[0].id, 'child-topic')
  assert.equal(root.children.attached[0].title, '子 "一"')

  assert.ok(first.warnings.some((warning) => warning.includes('浮动')))
  assert.ok(first.warnings.some((warning) => warning.includes('摘要')))
  assert.ok(first.warnings.some((warning) => warning.includes('2 个 Sheet')))

  const second = parseXmindBuffer(buffer, { sheetIndex: 1 })
  assert.equal(second.sheetTitle, '第二页')
  assert.deepEqual(second.rootTopic, {
    id: 'root-two',
    title: '第二根',
    children: { attached: [] },
  })
})

test('parseXmindBuffer reads XMind 2020 multi-sheet content.json', () => {
  const sheets = [
    {
      id: 's1',
      class: 'sheet',
      title: '第一页',
      rootTopic: {
        id: 'r1',
        class: 'topic',
        title: '根一',
        children: { attached: [{ id: 'c1', title: '子一' }] },
      },
    },
    {
      id: 's2',
      class: 'sheet',
      title: '第二页',
      rootTopic: { id: 'r2', title: '根二' },
    },
  ]
  const buffer = zipOf([
    { name: 'content.json', data: JSON.stringify(sheets) },
    { name: 'content.xml', data: '<xmap-content><sheet><topic><title>wrong</title></topic></sheet></xmap-content>' },
  ])
  const warnings = []
  const first = parseXmindBuffer(buffer, { warnings })

  assert.equal(first.warnings, warnings)
  assert.equal(first.format, 'json')
  assert.equal(first.sheetCount, 2)
  assert.equal(first.sheetTitle, '第一页')
  assert.equal(first.rootTopic.title, '根一')
  assert.equal(first.rootTopic.children.attached[0].title, '子一')
  assert.deepEqual(first.sheets, [
    { id: 's1', title: '第一页' },
    { id: 's2', title: '第二页' },
  ])
  assert.ok(first.warnings.some((warning) => warning.includes('2 个 Sheet')))

  const second = parseXmindBuffer(buffer, { sheetIndex: 1 })
  assert.equal(second.rootTopic.title, '根二')
  assert.deepEqual(second.rootTopic, {
    id: 'r2',
    title: '根二',
    children: { attached: [] },
  })
})

test('content.json placeholders fall back to content.xml with a warning', () => {
  for (const placeholder of ['[]', '{}', 'not-json', '', 'null']) {
    const buffer = zipOf([
      { name: 'content.json', data: placeholder },
      { name: 'content.xml', data: XMIND8_XML },
    ])
    const parsed = parseXmindBuffer(buffer)
    assert.equal(parsed.format, 'xml', `placeholder ${JSON.stringify(placeholder)}`)
    assert.ok(
      parsed.warnings.some((warning) => warning.includes('回退')),
      `placeholder ${JSON.stringify(placeholder)}`,
    )
    assert.equal(parsed.rootTopic.title, '根 <主题> & 更多')
  }
})

test('parseXmindBuffer fails clearly when no usable content exists', () => {
  assert.throws(() => parseXmindBuffer(Buffer.alloc(0)), /内容为空/)
  assert.throws(() => parseXmindBuffer(Buffer.alloc(64, 0x41)), /ZIP/)
  assert.throws(() => parseXmindBuffer('nope'), /Buffer/)
  assert.throws(() => parseXmindBuffer(zipOf([])), /缺少 content\.json/)
  assert.throws(
    () => parseXmindBuffer(zipOf([{ name: 'content.json', data: '[]' }])),
    /content\.json/,
  )
  assert.throws(
    () => parseXmindBuffer(zipOf([{ name: 'content.xml', data: '<broken' }])),
    /content\.xml/,
  )
  assert.throws(
    () =>
      parseXmindBuffer(
        zipOf([{ name: 'content.xml', data: '<xmap-content/>' }]),
      ),
    /缺少 sheet/,
  )
})

test('parseXmindBuffer validates sheetIndex', () => {
  const buffer = buildXmindBuffer(sampleTree())
  assert.throws(() => parseXmindBuffer(buffer, { sheetIndex: 1 }), /超出范围/)
  assert.throws(() => parseXmindBuffer(buffer, { sheetIndex: -1 }), /非负整数/)
  assert.throws(() => parseXmindBuffer(buffer, { sheetIndex: 1.5 }), /非负整数/)
  assert.throws(() => parseXmindBuffer(buffer, { sheetIndex: '0' }), /非负整数/)
})

test('parseXmindBuffer tolerates notes as string and children as a loose array', () => {
  const buffer = zipOf([
    {
      name: 'content.json',
      data: JSON.stringify([
        {
          id: 'sheet',
          class: 'sheet',
          title: '数组子主题',
          rootTopic: {
            id: 'root',
            title: '根',
            notes: '纯文本备注',
            children: [
              { id: 'a', title: 'A' },
              { id: 'b', title: 'B' },
            ],
          },
        },
      ]),
    },
  ])
  const parsed = parseXmindBuffer(buffer)
  assert.equal(parsed.rootTopic.notes, '纯文本备注')
  assert.deepEqual(
    parsed.rootTopic.children.attached.map((node) => node.title),
    ['A', 'B'],
  )
  assert.deepEqual(parsed.rootTopic.children.attached[0].children, { attached: [] })
})

test('unsupported XMind content appends Chinese warnings instead of throwing', () => {
  const rootTopic = {
    id: 'r',
    title: '根',
    image: { src: 'picture.png' },
    mysteryField: true,
    children: {
      attached: [
        {
          id: 'c',
          title: '子',
          children: {
            attached: [],
            detached: [{ id: 'f', title: '浮动' }],
          },
        },
      ],
      summary: [{ id: 'summary-topic', title: '摘要' }],
    },
  }
  const buffer = zipOf([
    {
      name: 'content.json',
      data: JSON.stringify([
        { id: 's', class: 'sheet', title: '降级', rootTopic },
      ]),
    },
  ])
  const parsed = parseXmindBuffer(buffer)
  assert.equal(parsed.rootTopic.title, '根')
  assert.ok(parsed.warnings.some((warning) => warning.includes('图片或附件')))
  assert.ok(parsed.warnings.some((warning) => warning.includes('mysteryField')))
  assert.ok(parsed.warnings.some((warning) => warning.includes('浮动')))
  assert.ok(parsed.warnings.some((warning) => warning.includes('摘要')))
})

test('notes formats are normalized and unsupported notes warn', () => {
  const make = (notes) =>
    zipOf([
      {
        name: 'content.json',
        data: JSON.stringify([
          {
            id: 's',
            class: 'sheet',
            title: 'T',
            rootTopic: { id: 'r', title: 'R', notes },
          },
        ]),
      },
    ])

  assert.equal(parseXmindBuffer(make('  文本备注  ')).rootTopic.notes, '文本备注')
  assert.equal(
    parseXmindBuffer(make({ plain: { content: '对象备注' } })).rootTopic.notes,
    '对象备注',
  )
  assert.equal(parseXmindBuffer(make({ plain: '字符串 plain' })).rootTopic.notes, '字符串 plain')
  assert.equal(parseXmindBuffer(make('   ')).rootTopic.notes, undefined)

  const richOnly = parseXmindBuffer(make({ realHTML: { content: '<p>hi</p>' } }))
  assert.equal(richOnly.rootTopic.notes, undefined)
  assert.ok(richOnly.warnings.some((warning) => warning.includes('备注')))
})

test('missing or duplicate ids are replaced deterministically with a warning', () => {
  const buffer = zipOf([
    {
      name: 'content.json',
      data: JSON.stringify([
        {
          id: 'sheet',
          class: 'sheet',
          title: 'T',
          rootTopic: {
            id: 'root',
            title: '根',
            children: {
              attached: [
                { id: 'dup', title: '一' },
                { id: 'dup', title: '二' },
                { title: '三' },
              ],
            },
          },
        },
      ]),
    },
  ])
  const parsed = parseXmindBuffer(buffer)
  const ids = collectIds(parsed.rootTopic)
  assert.equal(ids.length, 4)
  assert.equal(new Set(ids).size, 4)
  assert.equal(parsed.rootTopic.children.attached[0].id, 'dup')
  assert.ok(parsed.warnings.some((warning) => warning.includes('id')))
})

test('missing titles fall back to "Untitled" with a warning', () => {
  const buffer = zipOf([
    {
      name: 'content.json',
      data: JSON.stringify([
        {
          id: 's',
          class: 'sheet',
          title: 'T',
          rootTopic: { id: 'r', children: { attached: [{ id: 'c', title: '  ' }] } },
        },
      ]),
    },
  ])
  const parsed = parseXmindBuffer(buffer)
  assert.equal(parsed.rootTopic.title, 'Untitled')
  assert.equal(parsed.rootTopic.children.attached[0].title, 'Untitled')
  assert.ok(parsed.warnings.some((warning) => warning.includes('Untitled')))
})

test('missing sheet titles fall back to "Sheet N" with a warning', () => {
  const buffer = zipOf([
    {
      name: 'content.json',
      data: JSON.stringify([
        { id: 's', class: 'sheet', rootTopic: { id: 'r', title: 'R' } },
      ]),
    },
  ])
  const parsed = parseXmindBuffer(buffer)
  assert.equal(parsed.sheetTitle, 'Sheet 1')
  assert.ok(parsed.warnings.some((warning) => warning.includes('缺少标题')))
})

test('buildXmindBuffer validates the canonical tree and reports degraded input', () => {
  assert.throws(() => buildXmindBuffer(null), /rootTopic/)
  assert.throws(() => buildXmindBuffer('tree'), /rootTopic/)
  assert.throws(
    () => buildXmindBuffer({ id: 'r', title: 'R', children: { attached: 'nope' } }),
    /attached 必须是数组/,
  )
  assert.throws(
    () => buildXmindBuffer({ id: 'r', title: 'R', children: { attached: [7] } }),
    /非对象节点/,
  )

  const cyclic = { id: 'r', title: 'R', children: { attached: [] } }
  cyclic.children.attached.push(cyclic)
  assert.throws(() => buildXmindBuffer(cyclic), /循环引用/)

  const tree = sampleTree()
  tree.children.attached[1].mystery = true
  tree.children.attached[1].labels = 'not-an-array'
  const warnings = []
  buildXmindBuffer(tree, { sheetTitle: 5, warnings })
  assert.ok(warnings.some((warning) => warning.includes('mystery')))
  assert.ok(warnings.some((warning) => warning.includes('标签')))
  assert.ok(warnings.some((warning) => warning.includes('sheetTitle')))
})

test('XML unknown fields and image/attachment content degrade with warnings', () => {
  const xml = `<xmap-content><sheet id="s"><title>T</title><topic id="r"><title>R</title><mystery/><image src="x.png"/></topic></sheet></xmap-content>`
  const parsed = parseXmindBuffer(zipOf([{ name: 'content.xml', data: xml }]))
  assert.ok(parsed.warnings.some((warning) => warning.includes('mystery')))
  assert.ok(parsed.warnings.some((warning) => warning.includes('图片或附件')))
})
