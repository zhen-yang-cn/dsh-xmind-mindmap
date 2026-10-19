// Acceptance matrix for dsh-xmind-mindmap: the seven delivery criteria from the
// task statement, exercised end-to-end over the pure modules and the real tool
// option objects (without importing the Cordis host entry).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, treeToMarkdown } from '../lib/markdown.js';
import { validateTree, countNodes, collectIds, findNode } from '../lib/tree.js';
import { writeZip } from '../lib/zip.js';
import { parseXmindBuffer, buildXmindBuffer } from '../lib/xmind.js';
import { createToolDefinitions } from '../lib/tools.js';

const HERE = fileURLToPath(new URL('..', import.meta.url));

const MIMETYPE = 'application/vnd.xmind.workbook';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xmind-accept-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function defs() {
  const maybe = createToolDefinitions({});
  return typeof maybe?.then === 'function' ? await maybe : maybe;
}

function tool(list, name) {
  const found = list.find((entry) => entry.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

function outline(node, depth = 0, out = []) {
  out.push(`${'  '.repeat(depth)}${node.title}`);
  for (const child of node.children?.attached ?? []) outline(child, depth + 1, out);
  return out;
}

function xmind8Buffer(rootXml) {
  return writeZip([
    { name: 'mimetype', data: Buffer.from(MIMETYPE), store: true },
    { name: 'content.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${rootXml}`, 'utf8') },
  ]);
}

test('AC1: heading/list Markdown maps to the expected tree hierarchy', () => {
  const md = [
    '# Release Plan',
    '',
    'Intro paragraph as notes.',
    '',
    '## Scope',
    '',
    '- view_xmind',
    '- markdown_to_mindmap',
    '  - shared tree schema',
    '',
    '### Deep',
    '',
    '1. ordered one',
    '2. ordered two',
    '',
  ].join('\n');
  const { root, warnings } = parseMarkdown(md, { fileName: 'release.md' });
  assert.equal(root.title, 'Release Plan');
  assert.deepEqual(root.children.attached.map((node) => node.title), ['Scope']);
  const scope = root.children.attached[0];
  assert.deepEqual(scope.children.attached.map((node) => node.title),
    ['view_xmind', 'markdown_to_mindmap', 'Deep']);
  const mdNode = scope.children.attached[1];
  assert.deepEqual(mdNode.children.attached.map((node) => node.title), ['shared tree schema']);
  const deep = scope.children.attached[2];
  assert.deepEqual(deep.children.attached.map((node) => node.title), ['ordered one', 'ordered two']);
  assert.match(root.notes ?? '', /Intro paragraph/);
  assert.equal(scope.notes, undefined);
  assert.deepEqual(validateTree(root), []);
  assert.deepEqual(warnings.filter((w) => /暂不支持/.test(w)), []);
});

test('AC2: .md -> .xmind -> reopen keeps hierarchy and titles', async (t) => {
  const dir = await tempDir(t);
  const mdPath = join(dir, 'doc.md');
  const xmindPath = join(dir, 'doc.xmind');
  await writeFile(mdPath, '# Root Topic\n\n## Alpha\n\n- a1\n- a2\n\n## Beta\n\n- b1\n');
  const list = await defs();
  const converted = await tool(list, 'markdown_to_mindmap')
    .execute({ mdPath, outputXmindPath: xmindPath }, { signal: new AbortController().signal });
  assert.equal(converted.rootTopic.title, 'Root Topic');
  assert.ok((await stat(xmindPath)).size > 0);

  const viewed = await tool(list, 'view_xmind')
    .execute({ xmindPath }, { signal: new AbortController().signal });
  assert.deepEqual(outline(viewed.rootTopic), outline(converted.rootTopic));
  assert.deepEqual(validateTree(viewed.rootTopic), []);

  const backMd = await tool(list, 'xmind_to_markdown')
    .execute({ xmindPath }, { signal: new AbortController().signal });
  const reparsed = parseMarkdown(backMd, { fileName: 'doc.md' });
  assert.deepEqual(outline(reparsed.root), outline(converted.rootTopic));
});

test('AC3: incremental edits keep a valid tree with a unique-id root', async (t) => {
  const dir = await tempDir(t);
  const mdPath = join(dir, 'edit.md');
  await writeFile(mdPath, '# Editable\n\n## Child A\n\n- grand\n\n## Child B\n');
  const list = await defs();
  const toMap = tool(list, 'markdown_to_mindmap');
  const edit = tool(list, 'edit_mindmap_node');
  const initial = await toMap.execute({ mdPath }, { signal: new AbortController().signal });
  const rootId = initial.rootTopic.id;
  const childA = initial.rootTopic.children.attached[0];

  const renamed = await edit.execute({
    sourcePath: mdPath, nodeId: childA.id, action: 'update_title', payload: { title: 'Renamed A' },
  }, { signal: new AbortController().signal });
  assert.equal(renamed.rootTopic.id, rootId);
  assert.equal(renamed.rootTopic.children.attached[0].title, 'Renamed A');

  const added = await edit.execute({
    sourcePath: mdPath, nodeId: rootId, action: 'add_child', payload: { title: 'Added C', notes: 'from test' },
  }, { signal: new AbortController().signal });
  assert.ok(outline(added.rootTopic).some((line) => line.includes('Added C')));
  const ids = [...collectIds(added.rootTopic)];
  assert.equal(ids.length, new Set(ids).size);
  assert.deepEqual(validateTree(added.rootTopic), []);

  const removed = await edit.execute({
    sourcePath: mdPath, nodeId: 'nope', action: 'delete_node', payload: {},
  }, { signal: new AbortController().signal }).then(() => null, (error) => error);
  assert.ok(removed instanceof Error, 'deleting an unknown node must fail');

  const deleted = await edit.execute({
    sourcePath: mdPath, nodeId: initial.rootTopic.children.attached[1].id,
    action: 'delete_node', payload: {},
  }, { signal: new AbortController().signal });
  assert.deepEqual(outline(deleted.rootTopic).filter((line) => line.includes('Child B')), []);
  assert.equal(deleted.rootTopic.id, rootId);
  assert.deepEqual(validateTree(deleted.rootTopic), []);

  await assert.rejects(edit.execute({
    sourcePath: mdPath, nodeId: deleted.rootTopic.id, action: 'delete_node', payload: {},
  }, { signal: new AbortController().signal }));
  await assert.rejects(edit.execute({
    sourcePath: mdPath, nodeId: deleted.rootTopic.id, action: 'update_title', payload: { title: '   ' },
  }, { signal: new AbortController().signal }));
});

test('AC4: XMind 2020 content.json renders with hierarchy, titles and notes', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'modern.xmind');
  const sheets = [{
    id: 'sheet-1',
    class: 'sheet',
    title: 'Modern Sheet',
    rootTopic: {
      id: 'root',
      title: 'Modern Root',
      notes: { plain: { content: 'root note' } },
      children: {
        attached: [
          { id: 'c1', title: 'Child One', labels: ['tag-a'], notes: { plain: { content: 'child note' } } },
          { id: 'c2', title: 'Child Two' },
        ],
      },
    },
  }];
  await writeFile(file, writeZip([
    { name: 'mimetype', data: Buffer.from(MIMETYPE), store: true },
    { name: 'content.json', data: Buffer.from(JSON.stringify(sheets), 'utf8') },
  ]));
  const list = await defs();
  const view = tool(list, 'view_xmind');
  const value = await view.execute({ xmindPath: file, sheetIndex: 0 }, { signal: new AbortController().signal });
  assert.equal(value.sheetTitle, 'Modern Sheet');
  assert.equal(value.sheetCount, 1);
  assert.deepEqual(outline(value.rootTopic), ['Modern Root', '  Child One', '  Child Two']);
  assert.equal(value.rootTopic.notes, 'root note');
  assert.equal(value.rootTopic.children.attached[0].notes, 'child note');
  assert.deepEqual(value.rootTopic.children.attached[0].labels, ['tag-a']);
  const meta = view.output.presentationMeta({ xmindPath: file }, value);
  assert.match(meta.mermaid, /Modern Root/);
  assert.match(meta.mermaid, /\[备注\]/);
  assert.match(meta.mermaid, /#tag-a/);
});

test('AC5: XMind 8 content.xml-only workbook parses without content.json', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'classic.xmind');
  const sheet = `<xmap-content version="2.0">
    <sheet id="sheet-classic">
      <topic id="classic-root">
        <title>Classic Root</title>
        <notes><plain>classic root note</plain></notes>
        <children><topics type="attached">
          <topic id="classic-a"><title>Classic A</title>
            <children><topics type="attached">
              <topic id="classic-a1"><title>Classic A1</title></topic>
            </topics></children>
          </topic>
          <topic id="classic-b"><title>Classic B</title><labels><label>old</label></labels></topic>
        </topics></children>
      </topic>
      <title>Classic Sheet</title>
    </sheet>
  </xmap-content>`;
  await writeFile(file, xmind8Buffer(sheet));

  const parsed = parseXmindBuffer(await readFile(file));
  assert.equal(parsed.format, 'xml');
  assert.equal(parsed.rootTopic.title, 'Classic Root');
  assert.deepEqual(outline(parsed.rootTopic), ['Classic Root', '  Classic A', '    Classic A1', '  Classic B']);

  const list = await defs();
  const value = await tool(list, 'view_xmind')
    .execute({ xmindPath: file }, { signal: new AbortController().signal });
  assert.equal(value.rootTopic.title, 'Classic Root');
  assert.deepEqual(value.rootTopic.children.attached[1].labels, ['old']);
});

test('AC6: code/table/image/blockquote degrade into notes with explicit warnings', async (t) => {
  const md = [
    '# Degraded',
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
    '> quoted line',
    '',
  ].join('\n');
  const { root, warnings } = parseMarkdown(md, { fileName: 'degraded.md' });
  assert.deepEqual(validateTree(root), []);
  assert.ok(warnings.length >= 3, `expected degradation warnings, got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => /暂不支持/.test(w)));
  const codeWarning = warnings.find((w) => /代码块/.test(w));
  assert.ok(codeWarning, `expected a code-block warning, got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => /表格/.test(w)), `expected a table warning, got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => /图片/.test(w)), `expected an image warning, got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => /引用块/.test(w)), `expected a blockquote warning, got ${JSON.stringify(warnings)}`);
  const allNotes = JSON.stringify(root);
  assert.match(allNotes, /const x = 1/);
  assert.match(allNotes, /quoted line/);

  const list = await defs();
  const dir = await tempDir(t);
  const file = join(dir, 'degraded.md');
  await writeFile(file, md);
  const converted = await tool(list, 'markdown_to_mindmap')
    .execute({ mdPath: file }, { signal: new AbortController().signal });
  assert.equal(converted.rootTopic.title, 'Degraded');
  assert.ok(converted.warnings.length >= 3);
});

test('AC7: host registration is lifecycle-owned by the tool registry', async () => {
  const source = await readFile(join(HERE, 'index.js'), 'utf8');
  assert.match(source, /export const inject = \['tools'\]/);
  assert.match(source, /export (async )?function apply\(ctx\)/);
  assert.match(source, /ctx\.tools\.register\(defineTool\(/);
  assert.ok(!/ctx\.effect\s*\(/.test(source), 'tool registration must not be wrapped in ctx.effect');
  const list = await defs();
  assert.equal(list.length, 4);
  assert.deepEqual(new Set(list.map((entry) => entry.name)), new Set([
    'view_xmind', 'markdown_to_mindmap', 'edit_mindmap_node', 'xmind_to_markdown',
  ]));
  for (const entry of list) assert.equal(typeof entry.execute, 'function');
});

test('AC7b: a generated workbook round-trips notes/href/labels', async () => {
  const tree = {
    title: 'Round Trip',
    notes: 'root notes',
    children: {
      attached: [
        { title: 'Linked', href: 'https://example.com/x', labels: ['one', 'two'] },
        { title: 'Plain', notes: 'line1\nline2' },
      ],
    },
  };
  const parsed = parseXmindBuffer(buildXmindBuffer(tree));
  assert.deepEqual(outline(parsed.rootTopic), ['Round Trip', '  Linked', '  Plain']);
  assert.equal(parsed.rootTopic.notes, 'root notes');
  assert.equal(parsed.rootTopic.children.attached[0].href, 'https://example.com/x');
  assert.deepEqual(parsed.rootTopic.children.attached[0].labels, ['one', 'two']);
  assert.equal(parsed.rootTopic.children.attached[1].notes, 'line1\nline2');
});

test('AC7c: treeToMarkdown keeps deep levels at ###### and records original depth', () => {
  let node = { title: 'L7', children: { attached: [] } };
  for (let depth = 6; depth >= 1; depth -= 1) node = { title: `L${depth}`, children: { attached: [node] } };
  const md = treeToMarkdown(node);
  assert.match(md, /^# L1$/m);
  assert.match(md, /^###### L6$/m);
  assert.match(md, /^###### L7$/m);
  assert.match(md, /原始层级深度: 7/);
  const { root } = parseMarkdown(md, { fileName: 'deep.md' });
  assert.equal(countNodes(root), 7);
  assert.ok(findNode(root, collectIds(root).values().next().value));
});
