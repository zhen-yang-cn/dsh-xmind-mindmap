// Production-entry test: `apply()` must register all four tools through
// ctx.tools.register even in a deployment where `@deepseek-ai/dsh-tools` cannot
// be imported (which is exactly the situation this profile exposes).
import test from 'node:test';
import assert from 'node:assert/strict';

import { inject, apply } from '../index.js';
import { validateJsonSchemaValue } from './support/vendor/dsh-tools/lib/types/json-schema.js';

test('inject declares the tools service', () => {
  assert.deepEqual(inject, ['tools']);
});

test('apply registers four compiled definitions through a fake registry', async () => {
  const registered = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        const dispose = () => {};
        disposers.push(dispose);
        return dispose;
      },
    },
  };
  await apply(ctx);
  assert.equal(registered.length, 4);
  assert.deepEqual(registered.map((definition) => definition.name), [
    'view_xmind', 'markdown_to_mindmap', 'edit_mindmap_node', 'xmind_to_markdown',
  ]);
  for (const definition of registered) {
    assert.equal(definition.parameters.type, 'object');
    assert.ok(definition.parameters.properties && Object.keys(definition.parameters.properties).length > 0);
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.output.presentationMeta, 'function');
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.output.schema.type, definition.name === 'xmind_to_markdown' ? 'string' : 'object');
  }
  const view = registered[0];
  assert.deepEqual(view.parameters.required, ['xmindPath']);
  assert.equal(view.parameters.properties.sheetIndex.type, 'integer');
  const edit = registered.find((definition) => definition.name === 'edit_mindmap_node');
  assert.deepEqual(edit.parameters.required.sort(), ['action', 'nodeId', 'sourcePath']);
  assert.deepEqual(edit.parameters.properties.action.enum, ['update_title', 'add_child', 'delete_node', 'move_node']);
  assert.deepEqual(validateJsonSchemaValue(view.parameters, { xmindPath: 'C:\\x.xmind' }, ''), []);
  assert.ok(validateJsonSchemaValue(view.parameters, {}, '').length > 0);
  assert.equal(disposers.length, 4);
});
