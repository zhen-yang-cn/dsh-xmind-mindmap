// Right Sidebar `.xmind` preview: registration metadata, browser-side ZIP/XML
// parsing (validated against the host parser), multi-sheet payloads and render
// smoke tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { setup, findElement, findElements } from './client-harness.js';
import { parseXmindBuffer } from '../lib/xmind.js';
import { writeZip } from '../lib/zip.js';
import { parseMarkdown } from '../lib/markdown.js';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = `${HERE}demo/sample.xmind`;
const CLASSIC = `${HERE}demo/classic.xmind`;
const SAMPLE_MD = `${HERE}demo/sample.md`;

function outline(node, depth, out) {
  const rows = out || [];
  rows.push(`${'  '.repeat(depth || 0)}${node.title}`);
  const attached = node.children && Array.isArray(node.children.attached) ? node.children.attached : [];
  for (const child of attached) outline(child, (depth || 0) + 1, rows);
  return rows;
}

test('the plugin declares the documentPreviews service', () => {
  const loaded = setup();
  assert.deepEqual(loaded.loaded.module.inject, ['slots', 'locale', 'documentPreviews']);
});

test('registers a bytes-complete .xmind preview at extension priority', () => {
  const loaded = setup();
  assert.equal(loaded.state.documentPreviews.length, 2);
  const definition = loaded.state.documentPreviews.find((entry) => entry.id === loaded.internals.PREVIEW_ID);
  assert.ok(definition, 'xmind preview definition missing');
  assert.deepEqual(definition.extensions, ['xmind']);
  assert.deepEqual(definition.binaryExtensions, ['xmind']);
  assert.equal(definition.priority, 'extension');
  assert.equal(definition.loading, 'bytes-complete');
  assert.equal(definition.wrap, false);
  assert.equal(typeof definition.title, 'function');
  assert.equal(definition.title(), 'XMind 导图');

  const body = loaded.registrations.find(
    (registration) => registration.target.name === 'sidebar.right.tab.document' && registration.target.key === loaded.internals.PREVIEW_ID
  );
  assert.ok(body, 'sidebar.right.tab.document body missing');
  assert.equal(body.target.locale, 'xmind');
  assert.equal(typeof body.component, 'function');
});

test('registers a bytes-complete .md preview that outranks the builtin Markdown renderer', () => {
  const loaded = setup();
  const definition = loaded.state.documentPreviews.find((entry) => entry.id === loaded.internals.MARKDOWN_PREVIEW_ID);
  assert.ok(definition, 'markdown preview definition missing');
  assert.deepEqual(definition.extensions, ['md', 'markdown']);
  assert.equal(definition.binaryExtensions, undefined, '.md must stay readable text for the host');
  assert.equal(definition.priority, 'extension', 'extension priority ranks before builtin');
  assert.equal(definition.loading, 'bytes-complete', 'the whole document is needed to build the tree');
  assert.equal(definition.wrap, false);
  assert.equal(definition.title(), 'Markdown 导图');
  assert.notEqual(definition.id, loaded.internals.PREVIEW_ID);

  const body = loaded.registrations.find(
    (registration) =>
      registration.target.name === 'sidebar.right.tab.document' && registration.target.key === loaded.internals.MARKDOWN_PREVIEW_ID
  );
  assert.ok(body, 'markdown sidebar body missing');
  assert.equal(body.target.locale, 'xmind');
  assert.equal(body.component, loaded.internals.MarkdownPreviewBody);
});

test('the .md registration wins over the host builtin Markdown renderer', () => {
  // Mirror of the host's matchingDocumentPreviews() ordering (dp-client.js):
  // rank = priority === 'builtin' ? 0 : 1, then suffix length, then registration order.
  const loaded = setup();
  const ours = loaded.state.documentPreviews;
  const builtinMarkdown = {
    id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown',
    extensions: ['md', 'markdown'],
    priority: 'builtin',
    title: () => 'Markdown',
    loading: 'text-pages',
    wrap: false,
  };
  const definitions = ours.concat([builtinMarkdown]);
  const fileName = 'notes.md';
  const candidates = definitions
    .map((definition, order) => ({
      definition,
      order,
      rank: definition.priority === 'builtin' ? 0 : 1,
      length: Math.max(0, ...definition.extensions.map((ext) => (fileName.endsWith('.' + ext) ? ext.length : 0))),
    }))
    .filter((candidate) => candidate.length > 0)
    .sort((left, right) => right.rank - left.rank || right.length - left.length || left.order - right.order)
    .map((candidate) => candidate.definition);
  assert.equal(candidates[0].id, loaded.internals.MARKDOWN_PREVIEW_ID, 'the mindmap view must be the default');
  assert.ok(candidates.some((definition) => definition.id === builtinMarkdown.id), 'the builtin stays selectable');
  assert.equal(candidates[0].loading, 'bytes-complete');
});

test('browser ZIP + content.json parsing agrees with the host parser', async () => {
  const bytes = new Uint8Array(await readFile(SAMPLE));
  const internals = setup().internals;
  const browser = await internals.parseXmindBytes(bytes);
  const host = parseXmindBuffer(Buffer.from(bytes));
  assert.equal(browser.format, 'json');
  assert.equal(browser.sheets.length, 1);
  assert.equal(browser.sheets[0].title, host.sheetTitle);
  assert.deepEqual(outline(browser.sheets[0].rootTopic), outline(host.rootTopic));
  assert.equal(browser.sheets[0].rootTopic.notes, host.rootTopic.notes);
  assert.deepEqual(browser.warnings, []);
});

test('browser content.xml fallback agrees with the host parser (XMind 8)', async () => {
  const bytes = new Uint8Array(await readFile(CLASSIC));
  const internals = setup().internals;
  const browser = await internals.parseXmindBytes(bytes);
  const host = parseXmindBuffer(Buffer.from(bytes));
  assert.equal(browser.format, 'xml');
  assert.deepEqual(outline(browser.sheets[0].rootTopic), outline(host.rootTopic));
  assert.equal(browser.sheets[0].title, host.sheetTitle);
  assert.deepEqual(browser.sheets[0].rootTopic.children.attached[1].labels, ['legacy']);
});

test('multi-sheet workbooks expose every sheet and a selectable payload', async () => {
  const sheets = [
    {
      id: 's1', class: 'sheet', title: 'First',
      rootTopic: { id: 'r1', title: 'One', children: { attached: [{ id: 'c1', title: 'A' }] } },
    },
    {
      id: 's2', class: 'sheet', title: 'Second',
      rootTopic: { id: 'r2', title: 'Two', children: { attached: [] } },
    },
  ];
  const bytes = writeZip([
    { name: 'mimetype', data: Buffer.from('application/vnd.xmind.workbook'), store: true },
    { name: 'content.json', data: Buffer.from(JSON.stringify(sheets), 'utf8') },
  ]);
  const internals = setup().internals;
  const parsed = await internals.parseXmindBytes(new Uint8Array(bytes));
  assert.equal(parsed.sheets.length, 2);
  assert.deepEqual(parsed.sheets.map((sheet) => sheet.title), ['First', 'Second']);
  const second = internals.previewPayload(parsed.sheets, 1, [], 'D:\\x.xmind');
  assert.equal(second.sheetIndex, 1);
  assert.equal(second.sheetCount, 2);
  assert.equal(second.sheetTitle, 'Second');
  assert.equal(second.rootTopic.title, 'Two');
  const clamped = internals.previewPayload(parsed.sheets, 9, [], 'D:\\x.xmind');
  assert.equal(clamped.sheetIndex, 1);
});

test('invalid workbooks produce a readable Chinese error', async () => {
  const internals = setup().internals;
  await assert.rejects(() => internals.parseXmindBytes(new Uint8Array([1, 2, 3, 4])), /ZIP/);
  const emptyZip = writeZip([{ name: 'mimetype', data: Buffer.from('application/vnd.xmind.workbook'), store: true }]);
  await assert.rejects(() => internals.parseXmindBytes(new Uint8Array(emptyZip)), /content\.json 或 content\.xml/);
});

test('preview body renders loading, empty and ready states without throwing', () => {
  const loaded = setup();
  const internals = loaded.internals;
  assert.equal(typeof internals.XmindPreviewBody, 'function');
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const empty = internals.XmindPreviewBody({ content: { kind: 'text' }, t: null });
  assert.ok(empty && empty.type === 'div');
  const loading = internals.XmindPreviewBody({ content: { kind: 'bytes', data: bytes }, t: null, resourceAddress: { path: 'D:\\a.xmind' } });
  assert.ok(loading && loading.type === 'div');
  const text = JSON.stringify(loading);
  assert.match(text, /正在解析/);
});

test('previewBytesOf accepts Uint8Array and ArrayBuffer only', () => {
  const internals = setup().internals;
  assert.ok(internals.previewBytesOf({ kind: 'bytes', data: new Uint8Array([1]) }) instanceof Uint8Array);
  assert.ok(internals.previewBytesOf({ kind: 'bytes', data: new ArrayBuffer(2) }) instanceof Uint8Array);
  assert.equal(internals.previewBytesOf({ kind: 'bytes' }), null);
  assert.equal(internals.previewBytesOf({ kind: 'text', text: 'x' }), null);
  assert.equal(internals.previewBytesOf(null), null);
});

test('parseXmlLite handles entities, CDATA and self-closing tags', () => {
  const internals = setup().internals;
  const document = internals.parseXmlLite(
    '<?xml version="1.0"?><root a="1 &amp; 2"><item/><![CDATA[a < b]]><nested><plain>x &lt; y</plain></nested></root>'
  );
  const root = document.children[0];
  assert.equal(root.name, 'root');
  assert.equal(root.attrs.a, '1 & 2');
  assert.equal(root.children[0].name, 'item');
  assert.match(root.text, /a < b/);
  assert.ok(root.children.some((child) => child.name === 'nested'));
});

test('previewTextOf reads text-pages content and rejects other modes', () => {
  const internals = setup().internals;
  assert.equal(internals.previewTextOf({ kind: 'text', text: '# a' }), '# a');
  assert.equal(internals.previewTextOf({ kind: 'text' }), '');
  assert.equal(internals.previewTextOf({ kind: 'bytes', data: new Uint8Array([1]) }), null);
  assert.equal(internals.previewTextOf(null), null);
});

test('previewDocumentText decodes bytes-complete and text-pages content alike', () => {
  const internals = setup().internals;
  const encoded = new TextEncoder().encode('# Hello\n\n- a\n- b\n');
  assert.deepEqual(internals.previewDocumentText({ kind: 'bytes', data: encoded }), { status: 'ok', text: '# Hello\n\n- a\n- b\n' });
  assert.deepEqual(internals.previewDocumentText({ kind: 'text', text: '# Hi' }), { status: 'ok', text: '# Hi' });
  assert.deepEqual(internals.previewDocumentText({ kind: 'text', pages: [], text: '', eof: true }), { status: 'ok', text: '' });
  assert.equal(internals.previewDocumentText(null).status, 'empty');
  const oversized = { kind: 'bytes', data: new Uint8Array(internals.MARKDOWN_MAX_BYTES + 1) };
  assert.equal(internals.previewDocumentText(oversized).status, 'too-large');
});

test('the browser Markdown parser mirrors the host parser on the demo file', async () => {
  const internals = setup().internals;
  const markdown = await readFile(SAMPLE_MD, 'utf8');
  const browser = internals.parseMarkdownText(markdown, { fileName: 'sample.md' });
  const host = parseMarkdown(markdown, { fileName: 'sample.md' });
  assert.deepEqual(browser.root, host.root);
  assert.deepEqual(browser.warnings, host.warnings);
});

test('the browser Markdown parser mirrors the host parser on a degraded document', () => {
  const internals = setup().internals;
  const markdown = [
    '# Degraded',
    '',
    'Intro.',
    '',
    '## Code',
    '',
    '```js',
    'const x = 1',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '![alt](https://example.com/i.png)',
    '',
    '> quoted',
    '',
    '### Deep',
    '',
    '1. one',
    '2. two',
    '',
  ].join('\n');
  const browser = internals.parseMarkdownText(markdown, { fileName: 'degraded.md' });
  const host = parseMarkdown(markdown, { fileName: 'degraded.md' });
  assert.deepEqual(browser.root, host.root);
  assert.deepEqual(browser.warnings, host.warnings);
  assert.ok(browser.warnings.length >= 3);
});

test('the browser Markdown parser mirrors edge cases (empty, BOM, CRLF, no heading)', () => {
  const internals = setup().internals;
  const sources = [
    '',
    '   \n\n  \n',
    '\uFEFF# BOM Title\n\n- a\n',
    '# CRLF\r\n\r\n- a\r\n- b\r\n',
    'just a paragraph without any heading',
    '# Only Root',
    '# Root\n\n# Second Root\n\n## Child\n',
    '* star\n+ plus\n- dash\n',
    '- a\n\t- tab nested\n  - space nested\n',
  ];
  for (const source of sources) {
    const browser = internals.parseMarkdownText(source, { fileName: 'edge.md' });
    const host = parseMarkdown(source, { fileName: 'edge.md' });
    assert.deepEqual(browser.root, host.root, 'root mismatch for ' + JSON.stringify(source));
    assert.deepEqual(browser.warnings, host.warnings, 'warnings mismatch for ' + JSON.stringify(source));
  }
});

test('markdownPreviewPayload produces a tree payload the card accepts', () => {
  const internals = setup().internals;
  const payload = internals.markdownPreviewPayload('# Root\n\n## A\n\n- a1\n', 'D:\\docs\\plan.md');
  assert.equal(payload.v, 1);
  assert.equal(payload.kind, 'tree');
  assert.equal(payload.format, 'markdown');
  assert.equal(payload.sourcePath, 'D:\\docs\\plan.md');
  assert.equal(payload.rootTopic.title, 'Root');
  assert.deepEqual(payload.rootTopic.children.attached.map((node) => node.title), ['A']);
  assert.deepEqual(payload.warnings, []);
  const fallback = internals.markdownPreviewPayload('no heading at all', 'D:\\docs\\notes.md');
  assert.equal(fallback.rootTopic.title, 'notes');
  const empty = internals.markdownPreviewPayload('', 'D:\\docs\\empty.md');
  assert.equal(empty.rootTopic.title, 'empty');
  assert.deepEqual(empty.warnings, ['文件为空或只包含空白字符']);
});

test('markdown preview body renders the mindmap card for bytes-complete content', () => {
  const internals = setup().internals;
  const body = internals.MarkdownPreviewBody({
    content: { kind: 'bytes', data: new TextEncoder().encode('# Root\n\n## A\n\n- a1\n') },
    t: null,
    resourceAddress: { path: 'D:\\docs\\plan.md' },
  });
  assert.ok(body && body.type === 'div');
  const card = findElement(body, (element) => element.type === internals.MindmapCard);
  assert.ok(card, 'the body must render the shared MindmapCard component');
  assert.equal(card.props.variant, 'preview');
  assert.equal(card.props.block.meta.format, 'markdown');
  assert.equal(card.props.block.meta.sourcePath, 'D:\\docs\\plan.md');
  assert.equal(card.props.block.meta.rootTopic.title, 'Root');
  assert.deepEqual(card.props.block.meta.rootTopic.children.attached.map((node) => node.title), ['A']);
});

test('the markdown preview body also accepts text-pages content', () => {
  const internals = setup().internals;
  const body = internals.MarkdownPreviewBody({
    content: { kind: 'text', pages: [{ offset: 0, lines: 5, text: '# Root\n\n## A\n' }], text: '# Root\n\n## A\n', eof: true },
    t: null,
    resourceAddress: { path: 'D:\\docs\\plan.md' },
  });
  const card = findElement(body, (element) => element.type === internals.MindmapCard);
  assert.ok(card, 'markdown card missing');
  assert.equal(card.props.block.meta.rootTopic.title, 'Root');
});

test('the markdown preview body offers both the mindmap and the original source view', () => {
  const internals = setup().internals;
  const markdown = '# Root\n\n## A\n\n- a1\n';
  const body = internals.MarkdownPreviewBody({
    content: { kind: 'bytes', data: new TextEncoder().encode(markdown) },
    t: null,
    resourceAddress: { path: 'D:\\docs\\plan.md' },
  });
  // The view bar is always mounted, in both views, so switching back is possible from either side.
  const buttons = findElements(body, (element) => element.type === 'button');
  assert.equal(buttons.length, 2, 'one button per view');
  assert.deepEqual(buttons.map((button) => button.props['aria-label']), ['导图', '原文']);
  assert.equal(buttons[0].props['aria-pressed'], 'true', 'the mindmap is the default view');
  assert.equal(buttons[1].props['aria-pressed'], 'false');
  assert.equal(typeof buttons[1].props.onClick, 'function');
  // The default view is still the mindmap, so the raw source is not rendered yet.
  assert.match(JSON.stringify(body), /"variant":"preview"/);
  assert.doesNotMatch(JSON.stringify(body), /## A/);
});

test('the source view renders the untouched Markdown text instead of the tree', () => {
  const internals = setup({ stateOverrides: { 0: 'source' } }).internals;
  const markdown = '# Root\n\n## A\n\n- a1\n';
  const body = internals.MarkdownPreviewBody({
    content: { kind: 'bytes', data: new TextEncoder().encode(markdown) },
    t: null,
    resourceAddress: { path: 'D:\\docs\\plan.md' },
  });
  // No card in the source view: the original bytes are shown verbatim, so a switch is lossless.
  assert.equal(findElement(body, (element) => element.type === internals.MindmapCard), null);
  const pre = findElement(body, (element) => element.type === 'pre');
  assert.ok(pre, 'source view must fall back to a <pre> when the host primitive is unavailable');
  assert.equal(pre.props.children, markdown, 'the Markdown source must be shown verbatim');
  const buttons = findElements(body, (element) => element.type === 'button');
  assert.equal(buttons[1].props['aria-pressed'], 'true');
  assert.equal(buttons[0].props['aria-pressed'], 'false');
});

test('the source view renders through the host Markdown primitive when the platform seeds it', () => {
  const HostMarkdownText = (props) => ({ type: 'host-markdown', props });
  const internals = setup({
    stateOverrides: { 0: 'source' },
    modules: { '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: HostMarkdownText } },
  }).internals;
  const markdown = '# Root\n\n```js\nconst a = 1\n```\n';
  const body = internals.MarkdownPreviewBody({
    content: { kind: 'bytes', data: new TextEncoder().encode(markdown) },
    t: null,
    resourceAddress: { path: 'D:\\docs\\host.md' },
  });
  const host = findElement(body, (element) => element.type === HostMarkdownText);
  assert.ok(host, 'the rendered Markdown comes from the host primitive');
  assert.equal(host.props.text, markdown, 'the host renders the untouched file text');
  assert.equal(host.props.streaming, false, 'a complete file is not streamed');
  assert.equal(findElement(body, (element) => element.type === 'pre'), null, 'the verbatim fallback stays unused');
  assert.deepEqual(host.props.labels, {
    code: {
      copyLabel: '复制',
      copiedLabel: '已复制',
      toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
    },
    footnotes: '脚注',
  });
});

test('the source view falls back to the verbatim text if the host Markdown renderer fails', () => {
  const HostMarkdownText = () => {
    throw new Error('host renderer exploded');
  };
  const internals = setup({
    stateOverrides: { 0: 'source' },
    modules: { '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: HostMarkdownText } },
  }).internals;
  const markdown = '# Root\n';
  const body = internals.MarkdownPreviewBody({
    content: { kind: 'bytes', data: new TextEncoder().encode(markdown) },
    t: null,
    resourceAddress: { path: 'D:\\docs\\boom.md' },
  });
  const boundary = findElement(body, (element) => element.type && element.type.name === 'HostMarkdownBoundary');
  assert.ok(boundary, 'the host renderer must sit behind an error boundary');
  // The boundary's fallback is the verbatim <pre>, so a host-side crash still leaves the file readable.
  const pre = findElement(boundary.props.fallback, (element) => element.type === 'pre');
  assert.ok(pre, 'the boundary falls back to the verbatim <pre>');
  assert.equal(pre.props.children, markdown);
});

test('the chosen view is remembered per document path', () => {
  const loaded = setup();
  const internals = loaded.internals;
  const content = { kind: 'bytes', data: new TextEncoder().encode('# Root\n\n## A\n') };
  const first = internals.MarkdownPreviewBody({
    content: content,
    t: null,
    resourceAddress: { path: 'D:\\docs\\remember.md' },
  });
  const sourceButton = findElements(first, (element) => element.type === 'button')[1];
  sourceButton.props.onClick();
  // A remount of the same path starts in the remembered view, a different path keeps the default.
  const remount = internals.MarkdownPreviewBody({
    content: content,
    t: null,
    resourceAddress: { path: 'D:\\docs\\remember.md' },
  });
  assert.ok(findElement(remount, (element) => element.type === 'pre'), 'the source view must be restored');
  const other = internals.MarkdownPreviewBody({
    content: content,
    t: null,
    resourceAddress: { path: 'D:\\docs\\other.md' },
  });
  assert.ok(findElement(other, (element) => element.type === internals.MindmapCard), 'other files keep the map');
});

test('markdown preview body renders empty and oversized states without throwing', () => {
  const internals = setup().internals;
  const empty = internals.MarkdownPreviewBody({ content: { kind: 'text', pages: [], text: '', eof: true }, t: null });
  assert.ok(empty && empty.type === 'div');
  assert.match(JSON.stringify(empty), /没有可映射为导图的内容/);
  const blank = internals.MarkdownPreviewBody({ content: { kind: 'text', text: '   \n\n', eof: true }, t: null });
  assert.ok(blank && blank.type === 'div');
  const noContent = internals.MarkdownPreviewBody({ t: null });
  assert.ok(noContent && noContent.type === 'div');
  assert.match(JSON.stringify(noContent), /没有读取到文件内容/);
  const oversized = internals.MarkdownPreviewBody({
    content: { kind: 'bytes', data: new Uint8Array(internals.MARKDOWN_MAX_BYTES + 1) },
    t: null,
  });
  assert.ok(oversized && oversized.type === 'div');
  assert.match(JSON.stringify(oversized), /过大/);
  const bytesBody = internals.MarkdownPreviewBody({
    content: { kind: 'bytes', data: new TextEncoder().encode('# From Bytes\n\n- a\n') },
    t: null,
    resourceAddress: 'D:\\docs\\bytes.md',
  });
  const card = findElement(bytesBody, (element) => element.type === internals.MindmapCard);
  assert.ok(card, 'markdown card missing');
  assert.equal(card.props.block.meta.rootTopic.title, 'From Bytes');
});
