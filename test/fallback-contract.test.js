// Fallback-compiler contract test: for every tool option object, the local
// compiler used when Harness packages cannot be imported must produce EXACTLY
// the same raw JSON Schema as the shipped @deepseek-ai/dsh-tools defineTool
// (vendored verbatim in test/support/vendor), and must validate arguments the
// same way.
import test from 'node:test';
import assert from 'node:assert/strict';

import { defineTool } from './support/vendor/dsh-tools/lib/types/schema.js';
import { validateJsonSchemaValue } from './support/vendor/dsh-tools/lib/types/json-schema.js';
import { compileTool, validateCompiled } from '../lib/define-tool.js';
import { createToolDefinitions } from '../lib/tools.js';

async function definitions() {
  const maybe = createToolDefinitions({});
  return typeof maybe?.then === 'function' ? await maybe : maybe;
}

const VALID_ARGS = {
  view_xmind: [{ xmindPath: 'C:\\tmp\\a.xmind' }, { xmindPath: 'C:\\tmp\\a.xmind', sheetIndex: 1 }],
  markdown_to_mindmap: [{ mdPath: 'C:\\tmp\\a.md' }, { mdPath: 'C:\\tmp\\a.md', outputXmindPath: 'C:\\tmp\\a.xmind' }],
  edit_mindmap_node: [
    { sourcePath: 'C:\\tmp\\a.md', nodeId: 'md-1', action: 'update_title', payload: { title: 'x' } },
    { sourcePath: 'C:\\tmp\\a.xmind', nodeId: 'n-1', action: 'move_node', payload: { parentId: 'n-2', index: 0 } },
  ],
  xmind_to_markdown: [{ xmindPath: 'C:\\tmp\\a.xmind' }, { xmindPath: 'C:\\tmp\\a.xmind', outputMdPath: 'C:\\tmp\\a.md' }],
};

const INVALID_ARGS = {
  view_xmind: [{}, { xmindPath: 1 }, { xmindPath: 'x', sheetIndex: 'one' }],
  markdown_to_mindmap: [{}, { mdPath: null }],
  edit_mindmap_node: [
    {},
    { sourcePath: 'a', nodeId: 'n', action: 'explode' },
    { sourcePath: 'a', nodeId: 'n', action: 'update_title', payload: 'not-an-object' },
  ],
  xmind_to_markdown: [{}, { xmindPath: [] }],
};

test('local compiler reproduces the shipped defineTool schemas exactly', async () => {
  const list = await definitions();
  for (const options of list) {
    const real = defineTool(options);
    const fallback = compileTool(options);
    assert.equal(fallback.name, real.name);
    assert.equal(fallback.description, real.description);
    assert.deepEqual(fallback.parameters, real.parameters, `${options.name}: parameters differ`);
    assert.deepEqual(fallback.output.schema, real.output.schema, `${options.name}: output schema differs`);
    assert.equal(fallback.timeoutMs, real.timeoutMs);
    assert.equal(typeof fallback.execute, 'function');
    assert.equal(typeof fallback.output.render, 'function');
    assert.equal(typeof fallback.output.presentationMeta, 'function');
  }
});

test('local compiler accepts and rejects the same argument samples', async () => {
  const list = await definitions();
  for (const options of list) {
    const real = defineTool(options);
    const fallback = compileTool(options);
    for (const args of VALID_ARGS[options.name]) {
      assert.deepEqual(validateJsonSchemaValue(real.parameters, args, ''), [],
        `${options.name}: real rejected valid args ${JSON.stringify(args)}`);
      assert.deepEqual(validateCompiled(fallback.parameters, args), [],
        `${options.name}: fallback rejected valid args ${JSON.stringify(args)}`);
    }
    for (const args of INVALID_ARGS[options.name]) {
      assert.notDeepEqual(validateJsonSchemaValue(real.parameters, args, ''), [],
        `${options.name}: real accepted invalid args ${JSON.stringify(args)}`);
      assert.notDeepEqual(validateCompiled(fallback.parameters, args), [],
        `${options.name}: fallback accepted invalid args ${JSON.stringify(args)}`);
    }
  }
});

test('fallback execute validates before the body, like defineTool', async () => {
  const list = await definitions();
  const view = list.find((entry) => entry.name === 'view_xmind');
  const fallback = compileTool(view);
  let bodyRan = false;
  const original = view.execute;
  view.execute = async () => { bodyRan = true; return original; };
  try {
    await assert.rejects(
      () => fallback.execute({}, { signal: new AbortController().signal }),
      (error) => error.name === 'ToolArgsError' && error.code === 'INVALID_ARGS',
    );
    assert.equal(bodyRan, false);
  } finally {
    view.execute = original;
  }
});

test('fallback render and presentationMeta delegate verbatim', async () => {
  const list = await definitions();
  const view = list.find((entry) => entry.name === 'view_xmind');
  const fallback = compileTool(view);
  const args = { xmindPath: 'C:\\tmp\\a.xmind' };
  const value = {
    rootTopic: { id: 'r', title: 'Root', children: { attached: [] } },
    sheetTitle: 'Sheet 1',
    sheetCount: 1,
    warnings: [],
  };
  assert.deepEqual(fallback.output.render(args, value), view.output.render(args, value));
  assert.deepEqual(fallback.output.presentationMeta(args, value), view.output.presentationMeta(args, value));
});
