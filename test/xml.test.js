// Contract tests for lib/xml.js (minimal XML DOM parser + helpers).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseXml,
  findChild,
  findChildren,
  textOf,
  childrenOf,
} from '../lib/xml.js'

const SAMPLE = `\uFEFF<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- leading comment -->
<!DOCTYPE root [
  <!ENTITY ignored "because-doctype-is-skipped">
]>
<root a="1" b='two' c = "three">
  <empty/>
  <text>Hello &amp; &lt;world&gt; &#65;&#x42;</text>
  <cdata><![CDATA[<raw> & stuff]]></cdata>
  <mixed>left<b>bold</b>right</mixed>
  <unknown>&nbsp; &madeup;</unknown>
  <ns:tag attr="v">namespaced</ns:tag>
</root>
<!-- trailing comment -->`

test('parseXml handles declaration, comments, DOCTYPE, CDATA, self-closing tags and entities', () => {
  const document = parseXml(SAMPLE)
  assert.equal(document.name, '#document')
  assert.equal(document.parent, null)
  assert.equal(document.children.length, 1)

  const root = findChild(document, 'root')
  assert.ok(root)
  assert.equal(root.name, 'root')
  assert.deepEqual(root.attrs, { a: '1', b: 'two', c: 'three' })
  assert.equal(root.parent, document)

  const empty = findChild(root, 'empty')
  assert.ok(empty)
  assert.equal(childrenOf(empty).length, 0)
  assert.equal(textOf(empty), '')

  assert.equal(textOf(findChild(root, 'text')), 'Hello & <world> AB')
  assert.equal(textOf(findChild(root, 'cdata')), '<raw> & stuff')
  assert.equal(textOf(findChild(root, 'mixed')), 'leftboldright')
  assert.equal(textOf(findChild(root, 'unknown')), '&nbsp; &madeup;')
  assert.equal(findChild(root, 'ns:tag').attrs.attr, 'v')
  assert.equal(textOf(findChild(root, 'ns:tag')), 'namespaced')

  assert.equal(root.text.trim(), '') // direct text is only whitespace
  assert.equal(childrenOf(root).length, 6)
  assert.equal(findChildren(root, 'missing').length, 0)
  assert.equal(findChild(root, 'missing'), null)
})

test('textOf concatenates nested text in document order and trims ends', () => {
  const document = parseXml('<a>  one <b>two<c>three</c></b> four  </a>')
  assert.equal(textOf(findChild(document, 'a')), 'one twothree four')
  assert.equal(textOf(null), '')
  assert.equal(textOf(undefined), '')
})

test('parseXml tolerates multiple root elements and surrounding whitespace', () => {
  const document = parseXml('\n  <a/>\n  <b x="1"/>\n')
  assert.equal(document.children.length, 2)
  assert.equal(findChild(document, 'a').name, 'a')
  assert.equal(findChild(document, 'b').attrs.x, '1')
})

test('parseXml tolerates unquoted attribute values and redundant whitespace', () => {
  const document = parseXml('<root  a = bare  b = "quoted"   c=\'single\' />')
  assert.deepEqual(findChild(document, 'root').attrs, {
    a: 'bare',
    b: 'quoted',
    c: 'single',
  })
})

test('CDATA is not entity-decoded and can contain angle brackets', () => {
  const document = parseXml('<root><![CDATA[a &amp; <b> ]]></root>')
  assert.equal(textOf(findChild(document, 'root')), 'a &amp; <b>')
})

test('numeric character references decode decimal and hexadecimal', () => {
  const document = parseXml('<root>&#20320;&#x597D;&#x1F600;</root>')
  assert.equal(textOf(findChild(document, 'root')), '你好😀')
})

test('parseXml rejects malformed XML with Chinese errors', () => {
  assert.throws(() => parseXml(42), /字符串/)
  assert.throws(() => parseXml(''), /XML 内容为空/)
  assert.throws(() => parseXml('   \n  '), /XML 内容为空/)
  assert.throws(() => parseXml('<?xml version="1.0"?>'), /未找到根元素/)
  assert.throws(() => parseXml('<a><b></a>'), /标签不匹配/)
  assert.throws(() => parseXml('<a><b></b>'), /<a> 未闭合/)
  assert.throws(() => parseXml('<a>'), /<a> 未闭合/)
  assert.throws(() => parseXml('</a>'), /多余的结束标签/)
  assert.throws(() => parseXml('<a><!-- x</a>'), /注释未闭合/)
  assert.throws(() => parseXml('<a><![CDATA[x</a>'), /CDATA 未闭合/)
  assert.throws(() => parseXml('<a><?pi x</a>'), /处理指令未闭合/)
  assert.throws(() => parseXml('<a b>text</a>'), /缺少 "="/)
  assert.throws(
    () => parseXml('<a b="c>text</a>'),
    /引号未闭合|起始标签未闭合/,
  )
})

test('childrenOf tolerates malformed node objects', () => {
  assert.deepEqual(childrenOf(null), [])
  assert.deepEqual(childrenOf(undefined), [])
  assert.deepEqual(childrenOf({}), [])
  const child = { name: 'x', attrs: {}, children: [], text: '' }
  assert.deepEqual(childrenOf({ children: [child] }), [child])
})
