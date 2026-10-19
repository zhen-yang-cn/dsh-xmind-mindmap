// Contract test: compiles every tool option object with the REAL shipped
// @deepseek-ai/dsh-tools defineTool/schema compiler (vendored verbatim under
// test/support/vendor), then validates arguments, output values, render blocks,
// presentationMeta payloads and cooperative cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineTool } from './support/vendor/dsh-tools/lib/types/schema.js';
import { validateJsonSchemaValue } from './support/vendor/dsh-tools/lib/types/json-schema.js';
import { createToolDefinitions } from '../lib/tools.js';
import { buildXmindBuffer } from '../lib/xmind.js';

const TOOL_NAMES = ['view_xmind', 'markdown_to_mindmap', 'edit_mindmap_node', 'xmind_to_markdown'];

const SAMPLE_MD = [
  '# Project Plan',
  '',
  '## Goals',
  '',
  '- Ship the plugin',
  '- Keep the tree stable',
  '',
  '## Notes',
  '',
  '- First note',
  '  - Nested note',
  '',
].join('\n');

const SAMPLE_TREE = {
  title: 'Roadmap',
  children: {
    attached: [
      {
        title: 'Phase 1',
        notes: 'View XMind files',
        labels: ['p1'],
        children: { attached: [{ title: 'view_xmind' }] },
      },
      { title: 'Phase 2', href: 'https://example.com/phase2' },
    ],
  },
};

function sampleTree() {
  return JSON.parse(JSON.stringify(SAMPLE_TREE));
}

async function definitions() {
  const maybe = createToolDefinitions({});
  const list = typeof maybe?.then === 'function' ? await maybe : maybe;
  assert.ok(Array.isArray(list), 'createToolDefinitions must return an array of option objects');
  return list;
}

function byName(list, name) {
  const found = list.find((entry) => entry?.name === name);
  assert.ok(found, `missing tool definition: ${name}`);
  return found;
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xmind-contract-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('all four tools compile with the shipped defineTool', async () => {
  const list = await definitions();
  assert.deepEqual(list.map((entry) => entry.name), TOOL_NAMES);
  for (const options of list) {
    assert.equal(typeof options.description, 'string');
    assert.ok(options.description.length > 20, `${options.name}: description too short`);
    assert.equal(typeof options.execute, 'function');
    assert.equal(typeof options.output?.render, 'function');
    assert.equal(typeof options.output?.presentationMeta, 'function');
    const compiled = defineTool(options);
    assert.equal(compiled.name, options.name);
    assert.equal(compiled.parameters.type, 'object');
    assert.ok(compiled.parameters.properties && Object.keys(compiled.parameters.properties).length > 0);
  }
});

test('parameter schemas declare the documented requirements', async () => {
  const list = await definitions();
  const view = byName(list, 'view_xmind');
  assert.deepEqual(view.parameters.xmindPath.type, 'string');
  assert.equal(view.parameters.xmindPath.required, true);
  assert.equal(view.parameters.sheetIndex.type, 'integer');

  const mdToMap = byName(list, 'markdown_to_mindmap');
  assert.equal(mdToMap.parameters.mdPath.required, true);
  assert.equal(mdToMap.parameters.outputXmindPath.required, undefined);

  const edit = byName(list, 'edit_mindmap_node');
  assert.equal(edit.parameters.sourcePath.required, true);
  assert.equal(edit.parameters.nodeId.required, true);
  assert.deepEqual(edit.parameters.action.enum, ['update_title', 'add_child', 'delete_node', 'move_node']);
  assert.equal(edit.parameters.action.required, true);
  assert.equal(edit.parameters.payload.type, 'object');
  assert.equal(edit.parameters.payload.additionalProperties, true);

  const toMd = byName(list, 'xmind_to_markdown');
  assert.equal(toMd.parameters.xmindPath.required, true);

  const compiled = defineTool(view);
  assert.deepEqual(compiled.parameters.required, ['xmindPath']);
  assert.deepEqual(validateJsonSchemaValue(compiled.parameters, {}, '').length > 0, true);
  assert.deepEqual(validateJsonSchemaValue(compiled.parameters, { xmindPath: '/tmp/a.xmind' }, ''), []);
  assert.deepEqual(validateJsonSchemaValue(compiled.parameters, { xmindPath: 1 }, '').length > 0, true);
});

test('output schemas: recursive tree uses the json node, arrays are typed', async () => {
  const list = await definitions();
  for (const options of list) {
    const compiled = defineTool(options);
    if (options.name === 'xmind_to_markdown') {
      assert.equal(compiled.output.schema.type, 'string');
      continue;
    }
    const schema = compiled.output.schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, `${options.name}: output object must be closed`);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(),
      options.name === 'view_xmind'
        ? ['rootTopic', 'sheetCount', 'sheetTitle', 'warnings']
        : ['rootTopic', 'warnings']);
    assert.equal(schema.properties.rootTopic.type, undefined,
      'rootTopic compiles to the annotation-only json node');
    assert.equal(schema.properties.rootTopic.additionalProperties, undefined);
    assert.equal(schema.properties.warnings.type, 'array');
    assert.equal(schema.properties.warnings.items.type, 'string');
    if (options.name === 'view_xmind') {
      assert.equal(schema.properties.sheetCount.type, 'integer');
      assert.equal(schema.properties.sheetTitle.type, 'string');
    }
    const sampleValue = options.name === 'view_xmind'
      ? { rootTopic: { title: 'x' }, sheetTitle: 'S', sheetCount: 1, warnings: [] }
      : { rootTopic: { title: 'x' }, warnings: [] };
    assert.deepEqual(validateJsonSchemaValue(schema, sampleValue, ''), []);
  }
});

test('view_xmind executes against a real generated .xmind and renders text + meta', async (t) => {
  const dir = await tempDir(t);
  const xmindPath = join(dir, 'sample.xmind');
  await writeFile(xmindPath, buildXmindBuffer(sampleTree()));
  const list = await definitions();
  const options = byName(list, 'view_xmind');
  const compiled = defineTool(options);
  const args = { xmindPath, sheetIndex: 0 };
  assert.deepEqual(validateJsonSchemaValue(compiled.parameters, args, ''), []);
  const controller = new AbortController();
  const value = await options.execute(args, { signal: controller.signal });
  assert.deepEqual(validateJsonSchemaValue(compiled.output.schema, value, ''), []);
  assert.equal(value.rootTopic.title, 'Roadmap');
  assert.equal(value.rootTopic.children.attached[0].children.attached[0].title, 'view_xmind');
  assert.equal(value.rootTopic.children.attached[0].notes, 'View XMind files');
  assert.equal(value.sheetCount, 1);
  assert.equal(typeof value.sheetTitle, 'string');
  const blocks = compiled.output.render(args, value);
  assert.ok(Array.isArray(blocks) && blocks.length >= 1);
  assert.ok(blocks.every((block) => block.type === 'text' && typeof block.text === 'string'));
  assert.match(blocks[0].text, /mermaid/);
  const meta = compiled.output.presentationMeta(args, value);
  assert.equal(meta.v, 1);
  assert.equal(meta.kind, 'tree');
  assert.equal(meta.rootTopic.title, 'Roadmap');
  assert.ok(JSON.stringify(meta).length > 50);
});

test('markdown_to_mindmap executes, and edit_mindmap_node rewrites the tree', async (t) => {
  const dir = await tempDir(t);
  const mdPath = join(dir, 'plan.md');
  await writeFile(mdPath, SAMPLE_MD);
  const list = await definitions();

  const mdOptions = byName(list, 'markdown_to_mindmap');
  const mdCompiled = defineTool(mdOptions);
  const controller = new AbortController();
  const converted = await mdOptions.execute({ mdPath }, { signal: controller.signal });
  assert.deepEqual(validateJsonSchemaValue(mdCompiled.output.schema, converted, ''), []);
  assert.equal(converted.rootTopic.title, 'Project Plan');
  assert.ok(converted.rootTopic.children.attached.length >= 2);
  const child = converted.rootTopic.children.attached[0];
  assert.equal(child.title, 'Goals');

  const editOptions = byName(list, 'edit_mindmap_node');
  const editCompiled = defineTool(editOptions);
  const editArgs = { sourcePath: mdPath, nodeId: child.id, action: 'update_title', payload: { title: 'Objectives' } };
  assert.deepEqual(validateJsonSchemaValue(editCompiled.parameters, editArgs, ''), []);
  const edited = await editOptions.execute(editArgs, { signal: new AbortController().signal });
  assert.deepEqual(validateJsonSchemaValue(editCompiled.output.schema, edited, ''), []);
  assert.equal(edited.rootTopic.children.attached[0].title, 'Objectives');
  const meta = editCompiled.output.presentationMeta(editArgs, edited);
  assert.equal(meta.action, 'update_title');
  assert.equal(meta.nodeId, child.id);
});

test('xmind_to_markdown returns the canonical Markdown string', async (t) => {
  const dir = await tempDir(t);
  const xmindPath = join(dir, 'roadmap.xmind');
  await writeFile(xmindPath, buildXmindBuffer(sampleTree(), { sheetTitle: 'Roadmap Sheet' }));
  const list = await definitions();
  const options = byName(list, 'xmind_to_markdown');
  const compiled = defineTool(options);
  const args = { xmindPath };
  const value = await options.execute(args, { signal: new AbortController().signal });
  assert.equal(typeof value, 'string');
  assert.deepEqual(validateJsonSchemaValue(compiled.output.schema, value, ''), []);
  assert.match(value, /^# Roadmap/);
  assert.match(value, /^## Phase 1/m);
  assert.match(value, /备注|View XMind files/);
  const blocks = compiled.output.render(args, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, value);
  const meta = compiled.output.presentationMeta(args, value);
  assert.equal(meta.kind, 'markdown');
  assert.equal(meta.markdown, value);
});

test('aborted signals are observed before file work', async (t) => {
  const dir = await tempDir(t);
  const xmindPath = join(dir, 'abort.xmind');
  await writeFile(xmindPath, buildXmindBuffer(sampleTree()));
  const list = await definitions();
  const options = byName(list, 'view_xmind');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(options.execute({ xmindPath }, { signal: controller.signal }));
});
