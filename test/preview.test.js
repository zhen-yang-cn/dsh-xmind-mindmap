// Right Sidebar `.xmind` preview: registration metadata, browser-side ZIP/XML
// parsing (validated against the host parser), multi-sheet payloads and render
// smoke tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { setup } from './client-harness.js';
import { parseXmindBuffer } from '../lib/xmind.js';
import { writeZip } from '../lib/zip.js';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = `${HERE}demo/sample.xmind`;
const CLASSIC = `${HERE}demo/classic.xmind`;

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
  assert.equal(loaded.state.documentPreviews.length, 1);
  const definition = loaded.state.documentPreviews[0];
  assert.equal(definition.id, loaded.internals.PREVIEW_ID);
  assert.deepEqual(definition.extensions, ['xmind']);
  assert.deepEqual(definition.binaryExtensions, ['xmind']);
  assert.equal(definition.priority, 'extension');
  assert.equal(definition.loading, 'bytes-complete');
  assert.equal(definition.wrap, false);
  assert.equal(typeof definition.title, 'function');
  assert.equal(definition.title(), 'XMind 导图');

  const body = loaded.registrations.find((registration) => registration.target.name === 'sidebar.right.tab.document');
  assert.ok(body, 'sidebar.right.tab.document body missing');
  assert.equal(body.target.key, loaded.internals.PREVIEW_ID);
  assert.equal(body.target.locale, 'xmind');
  assert.equal(typeof body.component, 'function');
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
