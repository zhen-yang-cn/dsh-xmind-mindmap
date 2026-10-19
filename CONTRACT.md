# dsh-xmind-mindmap — internal build contract (authoritative)

Status: frozen interface. Every teammate codes to this file. If you must deviate, message the Lead
*first* and update this file in the same change.

## 0. Environment facts (verified by the Lead, do not re-derive)

- DSH checkout lives inside `D:\DeepSeek Harness\resources\app.asar` (not directly readable by node/pwsh
  tools). Extracted read-only copies used as references live under
  `D:\DSH_Data\Workspace\Project\.dsh-inspect\extracted\dsh\node_modules\@deepseek-ai\`.
- Bundled node: `D:\DSH_Data\Home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  (call it `$NODE`). It is **not** on PATH. Python is not on PATH.
- There is **no mermaid renderer installed** in this DSH profile. There is no `dsh-mermaid-plugin`,
  no `dsh-mermaid-renderer`, no `dsh-mermaid-smooth` (the market catalog has none). Therefore the
  client card must render with its own plain React + SVG outline/tree view, and the tool output still
  carries Mermaid `mindmap` source for environments that do have a renderer (degradation rule).
- There is **no `plugin_manager` tool** in this agent session. Installation is done by the Lead with
  `scripts/install-profile.mjs` (backup + junction + bundle list) and verified in the browser.
- `window.__ModuleLoader__.load({ id, factory(require) })` is the client bundle format; the factory
  returns a module object `{ name, inject, apply }`. React comes from `require('react')`.
- Tool contract (verified against `dsh-tools@0.2.1-rc.2` `defineTool`):
  - `defineTool({ name, description, parameters, output: { schema, render, presentationMeta? },
    execute, timeoutMs?, isConcurrencySafe?, finalizeContent?, projectContent?, deferLoading? })`
  - `parameters` is a **property map** (not an object schema): `{ xmindPath: { type: 'string',
    required: true, description: '...' } }`.
  - value schemas: `{type:'string'|'number'|'integer'|'boolean'|'null'|'json'}`,
    `{type:'array', items:<schema>}`, `{type:'object', properties:{...}, additionalProperties:true|false}`
    (the `additionalProperties` key is mandatory on object nodes), `{oneOf:[...]}`, plus
    `description/title/default/examples` and per-property `required: true`.
  - Recursive schemas are impossible; use `{ type: 'json' }` for the recursive `rootTopic` payload.
  - `execute(args, exec)` returns the canonical value; `exec.signal` is the cooperative abort signal.
  - `render(args, value)` returns content blocks `[{ type: 'text', text }]`.
  - `presentationMeta(args, value)` returns client-only JSON persisted as `block.meta` in the Web UI
    (never shown to the model). This is how the card gets the full tree.
  - Tool registration is **not** wrapped in `ctx.effect`; the registry owns its lifecycle.
- Host plugin module shape: `export const inject = ['tools']; export function apply(ctx, config) {}`.
  ESM only. Never import `@deepseek-ai/dsh-client-*` from the host half.

## 1. Canonical tree schema (the one shape everything shares)

```ts
type TreeNode = {
  id: string;                    // unique inside one tree, non-empty
  title: string;                 // display title, non-empty; may be '' only for synthetic roots?
                                 // -> NO: always non-empty ("Untitled" fallback)
  children: { attached: TreeNode[] };   // always present, possibly empty
  notes?: string;                // present only when non-empty
  href?: string;                 // present only when non-empty
  labels?: string[];             // present only when non-empty; de-duplicated
}
```

Invariants (assert in `assertTree`):
1. `id` non-empty string, unique across the whole tree.
2. `title` string (trimmed non-empty on write; `update_title` rejects empty/whitespace).
3. `children.attached` is an array; every entry is a valid node.
4. `notes` / `href` / `labels` omitted (not `undefined`, not empty) when empty.
5. No cycles; depth is finite (cap walk at 512).
6. JSON-serializable plain objects only (no class instances, no Map/Set).

`rootTopic` always is a TreeNode.

## 2. Module APIs (exact file + export names)

All modules are ESM, zero runtime dependencies, pure unless stated. Use `node:` builtins only.

### `lib/tree.js` (owner: tree-md)
```js
export const TREE_NODE_JSON_SCHEMA  // { type: 'json' } — the only recursive-safe schema node
export function createNode(partial) // -> canonical TreeNode (fills children.attached, drops empties)
export function normalizeTree(raw, opts) // opts: { idPrefix='t', maxDepth=64, warnings:[] }
//   raw is a loose XMind-ish node { id?, title?, children:{attached:[]}|[], notes?, href?, labels? }
//   returns { root, warnings }
export function walkTree(root, visit) // pre-order visit(node, depth, parent)
export function flattenTree(root) // -> Array<{ node, depth, parent, index }>
export function findNode(root, id) // -> { node, parent, index, depth } | null
export function countNodes(root) // number
export function treeDepth(root) // number (root = 1)
export function collectIds(root) // -> Set<string>
export function generateId(existingIds, prefix='n') // collision-free short id
export function cloneTree(root) // deep clone (structuredClone)
export function validateTree(root) // -> string[] violations (empty = valid)
export function assertTree(root) // throws Error('invalid tree: ...') when violations exist
export function countWithField(root, field) // helper for summaries
```

### `lib/mermaid.js` (owner: tree-md)
```js
export function escapeMermaidLabel(text) // escape ()[]{}<>"':;#` and newlines -> spaces
export function treeToMermaid(root, opts) // opts { maxNodes=800, indent='  ' }
// returns string starting with "mindmap\n"; deterministic; depth indentation = 2 spaces per level.
// Node line: `${indent}${escapeMermaidLabel(displayTitle)}`
// displayTitle = title + (notes ? ' [备注]' : '') + labels.map(l => ' #'+l).join('')
// Root line is the same rule. Truncated nodes get a final "... (truncated)" leaf and a warning is
// NOT emitted here (caller owns warnings); expose truncation via second return? NO — keep string-only.
export function isMindmapSupported() // -> false in this profile (documented, used for degradation)
```

### `lib/markdown.js` (owner: tree-md)
```js
export function parseMarkdown(markdown, opts) // opts { fileName, warnings=[] }
// -> { root, warnings } implementing section 3 exactly.
export function treeToMarkdown(root) // -> string (section 3 reverse mapping)
export function parseMarkdownToTree(markdown, opts) // alias of parseMarkdown
```

### `lib/zip.js` (owner: xmind-io)
```js
export function readZip(buffer) // -> Map<string, Buffer> preserving entry names ('content.json', ...)
export function writeZip(entries) // -> Buffer; entries: [{ name, data, store?: boolean }]
// Writer contract: mimetype MUST be entry[0], stored (method 0), and kept uncompressed.
// Other entries deflated (method 8) with valid CRC32. Deterministic DOS timestamps (1980-01-01).
export function crc32(buffer) // number (unsigned)
```

### `lib/xml.js` (owner: xmind-io)
```js
export function parseXml(text) // -> Node { name, attrs: Record<string,string>, children: XmlNode[],
                               //          text: string, parent? } (root wrapper name '#document')
export function findChild(node, name) // first direct child or null
export function findChildren(node, name) // direct children with name
export function textOf(node) // concatenated direct+descendant text, trimmed
export function childrenOf(node) // node.children ?? []
```
Support: XML declaration, comments, DOCTYPE (skipped), CDATA, self-closing tags, five named entities
plus numeric character references, attribute quoting with `"` or `'`, tolerant of whitespace.

### `lib/xmind.js` (owner: xmind-io)
```js
export function parseXmindBuffer(buffer, opts) // opts { sheetIndex=0, warnings=[] }
// -> { rootTopic, sheetTitle, sheetCount, sheets: [{ id, title }], format: 'json'|'xml', warnings }
// Detection: parse content.json if present; accept it only when it yields >=1 sheet with a rootTopic
// (a placeholder/empty content.json must fall through to content.xml). Otherwise parse content.xml.
// XMind 8 sheet title = <sheet><title>; XMind 2020 sheet title = sheet.title.
export function buildXmindBuffer(rootTopic, opts) // opts { sheetTitle='Sheet 1', warnings=[] }
// -> Buffer. Entries, in order: mimetype (store), content.json, content.xml, metadata.json,
// manifest.json, META-INF/manifest.xml. content.xml is a compatibility stub carrying the same tree.
// content.json: [{ id, class:'sheet', title, rootTopic }] using XMind 2020 topic shape.
export function buildContentJson(rootTopic, sheetTitle) // -> object (for tests)
export function buildContentXml(rootTopic, sheetTitle) // -> string (compat stub with same tree)
// XMind node mapping (both directions):
//   title -> <title>/title; notes -> notes.plain.content/<notes><plain>; href -> href;
//   labels -> labels[]/<labels><label>; children.attached -> children.attached / <children><topics type="attached">
// Unknown raw fields are dropped; every dropped/unsupported thing appends one Chinese warning.
```

### `lib/fsio.js` (owner: host-tools)
```js
export function resolveAbsolute(input, opts) // opts { ext: ['.xmind'], kind: 'file'|'dir', label }
// -> normalized absolute path. Throws TypeError with a Chinese message when:
//   not a string, empty, not absolute, any raw segment === '..', wrong extension.
// Does NOT touch the filesystem.
export async function readBuffer(filePath, signal) // fs.readFile + signal; checks signal first
export async function readUtf8(filePath, signal)
export async function readBaseline(filePath, signal) // -> { sha256, size, mtimeMs }
export async function assertBaseline(filePath, baseline, signal)
// throws Error('目标文件在读取后已被修改，已拒绝覆盖: <path>') when file is missing/changed
export async function writeIfAbsentOrSame(filePath, data, signal)
// throws Error('目标文件已存在且内容不同，已拒绝覆盖: <path>') when exists && differs
export async function writeGuarded(filePath, data, baseline, signal)
// baseline required; assertBaseline first, then writeFile (atomic temp+rename in same dir)
export function sha256(data) // hex
export function throwIfAborted(signal)
```

### `lib/tools.js` (owner: host-tools)
```js
export const TOOL_PAYLOAD_VERSION = 1
export function createToolDefinitions(opts) // opts { deps?, config? } -> Array<ToolDefinition-ish>
// deps defaults to the real modules; tests pass fakes:
// { tree, markdown, mermaid, xmind, fsio, now? }
// index.js maps each entry through defineTool(). createToolDefinitions returns plain option objects
// ({ name, description, parameters, output, execute }) so contract tests can compile them with the
// real defineTool too.
```
The four tool option objects are specified in section 4.

### `index.js` (owner: host-tools + Lead integration)
```js
import { createToolDefinitions } from './lib/tools.js'
import { compileTool } from './lib/define-tool.js'
export const inject = ['tools']
export async function apply(ctx) {
  const defineTool = await resolveDefineTool() // real @deepseek-ai/dsh-tools when resolvable
  for (const options of createToolDefinitions({})) ctx.tools.register(defineTool(options))
}
```
`resolveDefineTool()` dynamically imports `@deepseek-ai/dsh-tools` and uses its `defineTool` when the
deployment lets a profile plugin resolve Harness packages. Profile plugins loaded from outside the DSH
installation may not resolve Harness packages at runtime (this profile has no anchor), so it falls back
to `lib/define-tool.js`, which produces byte-identical raw JSON Schema for the authoring DSL this plugin
uses and wraps the same argument validation around `execute`. `test/fallback-contract.test.js` compiles
all four tools with both compilers and deep-compares the results against the vendored shipped
`defineTool`.
No `ctx.effect` around registration. No other listeners/services. No file handles are held open.

### `client.js` (owner: client-card)
Self-contained browser module (no relative imports, no Harness Client packages). Format:
```js
window.__ModuleLoader__.load({
  id: 'dsh-xmind-mindmap',
  factory(require) {
    const React = require('react')
    // ... implementation ...
    return { name: 'dsh-xmind-mindmap', inject: ['slots', 'locale'], apply(ctx) { ... },
             __internals: { layoutTree, escapeHtml?, parseMeta, outlineRows, truncate } }
  },
})
```
Registers the same component under four keys:
```js
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: TOOL_NAME, locale: 'xmind' }, Card))
```
Register locale dictionaries with `ctx.effect(() => ctx.locale.register('xmind', { zh, en }), '...')`.
The component receives ui-tool owner props: `{ phase: 'preparing'|'start'|'result', block, callId,
toolName, cwd, home, inspect, openFile, t }` and may use `block.meta` (our payload), `block.content`,
`block.isError`, `block.error`, `block.call?.argsRaw` / `block.argsRaw`.

## 3. Markdown ↔ tree mapping (exact; the acceptance tests encode every row)

Markdown input → tree:
1. Root = the **first** `# ` ATX heading (level 1) in the file. Any later `#` heading becomes a child
   of the root (it is not the root). If no level-1 heading exists, root title = file name without
   extension (`opts.fileName`, fallback `'Untitled'`).
2. `##`..`######` headings become child topics. Heading level maps to depth: `##` = depth 2 under the
   root, ... `######` = depth 6. Headings deeper than level 6 (none in ATX Markdown, but be tolerant)
   attach under the nearest depth-6 node keeping their own extra depth.
3. Headings with level > 6 handled as children of the nearest level-6 heading, preserving relative
   nesting (the "超过 6 级" rule for XMind-origin trees).
4. Unordered list items (`-`, `*`, `+` with indentation) become child topics. Indentation unit is
   **2 spaces or 1 tab**; mixed indentation in the same file is rejected with a warning and the file
   is parsed with the first-seen unit. Depth = root depth of the current heading + 1 + indentLevel.
5. Ordered list items (`1.`, `1)`) behave exactly like unordered items; the marker is dropped from the
   title.
6. A paragraph (non-empty, non-heading, non-list, non-fenced) immediately following a heading or a
   list item becomes that node's `notes` (first paragraph only; subsequent paragraphs of the same node
   append with `\n\n`). A paragraph with no preceding heading/list item becomes an independent child
   of the root: `title` = first 80 characters of its first line (single-line, whitespace collapsed),
   `notes` = full paragraph text.
7. Links: a heading or list item whose text is exactly one Markdown link `[text](url)` gets
   `title = text`, `href = url`. A link mixed with other text keeps the literal text in `title`
   (the URL is not extracted) — deterministic and documented.
8. Fenced code blocks, tables, images, blockquotes: degrade. Keep a node for the enclosing
   heading/list item when one exists; append the raw Markdown slice to that node's `notes` prefixed
   with `该内容类型暂不支持 XMind 结构映射:` on its own line, and push a warning naming the element
   kind and line. When there is no enclosing node, attach the degraded block as a root child whose
   `title` is `代码块` / `表格` / `图片` / `引用块` and whose `notes` carries the raw slice.
9. Empty/whitespace-only input → single root node titled by rule 1, `warnings` gets
   `文件为空或只包含空白字符`.
10. Node ids for Markdown trees: `md-<n>` in document pre-order, root is `md-1`.
11. Warnings are Chinese, one per degraded/ignored element, and never throw.

Tree → Markdown:
- Root → `# <title>` (plus `[title](href)` when href, plus trailing ` #label` tokens? NO — labels are
  rendered as inline `#label` text after the title only when the title came from XMind and labels
  exist; keep deterministic: append ` #label1 #label2` to the heading text).
- Depth d (2..6) → `'#'.repeat(d) + ' ' + title`.
- Depth > 6 → `'###### ' + title` and the node's notes get the line `原始层级深度: <d>` prepended
  (once, before other notes).
- notes → blank line + notes paragraph(s) after the heading/list line.
- href → `[title](href)` instead of bare title.
- children use headings for heading-derived nodes; for list-derived nodes the original list shape is
  not preserved (documented limitation) — always emit headings, which round-trips through XMind.
- Output ends with one trailing newline; exactly one blank line between blocks; no CRLF.

## 4. Tool definitions (exact, model-facing)

Common: all descriptions are concise English + one Chinese sentence. `timeoutMs: 30000`.

### 4.1 `view_xmind`
- description: `Read an .xmind workbook (XMind 2020+ content.json or XMind 8 content.xml) and render
  its topic tree as an interactive read-only mindmap card in the chat. 读取 .xmind 文件并在聊天中直接渲染可交互导图卡片。`
- parameters:
  - `xmindPath`: `{ type:'string', required:true, description:'Absolute path to the .xmind file.' }`
  - `sheetIndex`: `{ type:'integer', description:'0-based sheet index; default 0.' }` (default applied in execute)
- output.schema:
  ```
  { type:'object', additionalProperties:false, properties:{
      rootTopic:{type:'json', description:'Normalized TreeNode of the sheet root topic.'},
      sheetTitle:{type:'string'},
      sheetCount:{type:'integer'},
      warnings:{type:'array', items:{type:'string'}} },
    required-props: all four }
  ```
- execute: resolve path (`.xmind`), read buffer with `exec.signal`, `parseXmindBuffer`, return
  `{ rootTopic, sheetTitle, sheetCount, warnings }`.
- render: blocks:
  1. `{type:'text', text: \`XMind: <sheetTitle> (sheet <i+1>/<n>) · <count> nodes · <notes> notes\n<warnings as '- ...'>\n\n\` + '```mermaid\n' + mermaid + '\n```'}`
     — mermaid truncated to 8000 chars with `… [mermaid truncated]` marker; when no warnings omit that block.
  2. If `sheetCount > 1`, append `\n提示：该文件共有 N 个 Sheet；调用 view_xmind 并传 sheetIndex 可切换。`
- presentationMeta: `{ v:1, kind:'tree', sourcePath, format, sheetTitle, sheetCount, sheetIndex,
  rootTopic, mermaid, warnings }` (client card payload).

### 4.2 `markdown_to_mindmap`
- description: `Convert a Markdown file to the shared tree schema; optionally write an .xmind workbook.
  将 Markdown 转换为树形导图；可选写出 .xmind。`
- parameters: `mdPath` string required; `outputXmindPath` string optional.
- output.schema `{rootTopic: json, warnings: string[]}` (both required).
- execute: read .md, `parseMarkdown` with `fileName`, if `outputXmindPath` given resolve output
  (`.xmind`, no `..`), build buffer, `writeIfAbsentOrSame` (never silent-overwrite a different file),
  push warning `已写出 .xmind: <path>` ONLY as metadata (not warnings — warnings are for degradations).
- render: `Markdown 导图: <root title> · <count> nodes` + warnings + mermaid fence (same limits) +
  `\n已写出: <path>` when written.
- presentationMeta: same payload plus `writtenPath`.

### 4.3 `edit_mindmap_node`
- description: `Incrementally edit one node of a tree loaded from .xmind or .md (update_title /
  add_child / delete_node / move_node) and return the edited full tree. 增量编辑导图节点，不重写整个文件。`
- parameters:
  - `sourcePath` string required (`Absolute .xmind or .md path.`)
  - `nodeId` string required
  - `action` `{type:'string', enum:['update_title','add_child','delete_node','move_node'], required:true}`
  - `payload` `{type:'object', additionalProperties:true, properties:{
        title:{type:'string'}, notes:{type:'string'}, href:{type:'string'},
        labels:{type:'array', items:{type:'string'}},
        parentId:{type:'string'}, index:{type:'integer'} }}`
- output.schema: `{rootTopic: json, warnings: string[]}` (both required).
- execute rules:
  - Load ('.xmind' → parse sheet 0 + build buffer write-back; '.md' → parseMarkdown).
  - `update_title`: payload.title must exist and `trim() !== ''` else throw `标题不能为空或纯空白`.
  - `add_child`: payload.title required non-empty; new node id from `generateId`; append (or insert at
    `payload.index` when 0<=index<=len).
  - `delete_node`: root id → throw `不能删除根节点`; remove node + subtree.
  - `move_node`: payload.parentId required; target must exist; reject `parentId === nodeId` and moving
    into own descendant (`不能把节点移动到它自己的子树下`); reject root move (`不能移动根节点`);
    optional index insertion.
  - Re-validate tree (`assertTree`), unique ids, root present.
  - Write back: `.xmind` → rebuild buffer **only** if source is .xmind and the file passed baseline;
    `.md` → `treeToMarkdown` and write guarded. Both read-before-write with `readBaseline`; throw
    `目标文件在读取后已被修改，已拒绝覆盖: <path>` when changed.
  - Add warning `已按结构化规则重新序列化 Markdown` for .md writes.
- render: `已编辑: <action> · <nodeId> → <title>\n<tree outline (max 40 lines)>\n` + warnings.
- presentationMeta: payload + `action`, `nodeId`, `writtenPath`.

### 4.4 `xmind_to_markdown`
- description: `Convert an .xmind workbook to Markdown; optionally write the .md file.
  将 .xmind 转换为 Markdown；可选写回 .md 文件。`
- parameters: `xmindPath` required; `outputMdPath` optional.
- output.schema: `{ type:'string' }` — canonical value is exactly the Markdown text.
- execute: parse, `treeToMarkdown`. When `outputMdPath` given: resolve `.md`, `writeIfAbsentOrSame`.
- render: `[{type:'text', text: markdown}]` (full text, the file itself).
- presentationMeta: `{v:1, kind:'markdown', sourcePath, writtenPath, markdown, sheetTitle, sheetCount,
  warnings}`.

## 5. Client card requirements (owner: client-card)

### 5a. Right Sidebar document preview

Two registrations share this slot; both bodies render the same `MindmapCard` with `variant: 'preview'`.

**`.xmind` (bytes-complete)**
- Register with `ctx.documentPreviews.register({ id: PREVIEW_ID, extensions: ['xmind'],
  binaryExtensions: ['xmind'], priority: 'extension', title: () => t('preview.title'),
  loading: 'bytes-complete', wrap: false })` inside `ctx.effect`.
- Register the body in the keyed `sidebar.right.tab.document` slot under `PREVIEW_ID`, locale `xmind`.
- The body receives `{ content: { kind: 'bytes', data }, resourceAddress, t, ... }`; parse the bytes
  in the browser: ZIP via `DecompressionStream('deflate-raw')`, `content.json` first, else
  `content.xml`, into the same canonical tree and card payload. Multi-sheet files get a selector.

**`.md` / `.markdown` (bytes-complete)**
- Register with `ctx.documentPreviews.register({ id: MARKDOWN_PREVIEW_ID, extensions: ['md',
  'markdown'], priority: 'extension', title: () => t('preview.markdownTitle'), loading:
  'bytes-complete', wrap: false })` inside `ctx.effect`. No `binaryExtensions`: the suffix stays
  readable text for the host.
- `bytes-complete`, not `text-pages`: the host's paged mode loads page 1 and the rest only on
  scroll, which cannot build a whole-document tree. The same loader as the `.xmind` preview is used.
- `priority: 'extension'` ranks before the host's builtin Markdown renderer
  (`rank = priority === 'builtin' ? 0 : 1`), so the mindmap is the default view while the builtin
  text preview (which switches the pane back to `text-pages`) stays selectable in the header dropdown.
- Register the body under `MARKDOWN_PREVIEW_ID`, locale `xmind`. It accepts both content shapes:
  `{ kind: 'bytes', data }` (bytes-complete, decoded as UTF-8) and `{ kind: 'text', pages, text,
  eof }` (text-pages), so a renderer switch does not blank the pane.
- The body owns an in-pane view toggle, because both ways of reading the file were requested:
  `preview.markdownViewMap` (导图 / Mindmap, the default) renders the `MindmapCard`, and
  `preview.markdownViewSource` (原文 / Source) renders the file's own Markdown **as Markdown**.
  `MARKDOWN_VIEWS = { MAP: 'map', SOURCE: 'source' }`; the view bar is a `role="toolbar"`
  with two `aria-pressed` buttons (`aria-label` = the locale labels) that stay mounted in both views
  so switching back never requires leaving the pane. The choice is kept per document path in the
  module-level `MARKDOWN_VIEW_MEMORY` map (cleared past 50 paths), so a remounted panel returns to the
  last view; no storage API is used (the read-only test forbids `localStorage`).
- The source view renders through the host primitive `MarkdownText` from the platform seed module
  `@deepseek-ai/dsh-client-ui-primitives` (the same renderer the builtin `.md` preview uses), so the
  「原文」 reading is real formatted Markdown rather than a raw dump. The request is made once at
  factory time inside `try/catch` into `hostMarkdownText`; a host without that seed word, or a
  renderer that throws (caught by the `HostMarkdownBoundary` error boundary), degrades to the verbatim
  UTF-8 Markdown in a scrollable `<pre>` — the only other `require` besides `react`, and it must stay
  optional so the card always loads. Code-block chrome and footnote labels are supplied from this
  plugin's own dictionary (`preview.mdCodeCopy` / `mdCodeCopied` / `mdCodeLabel` / `mdCodeWrap` /
  `mdCodeUnwrap` / `mdFootnotes`), one key per label, in both `zh` and `en`.
- `client.js` may not import host modules, so `parseMarkdownText` is a verbatim mirror of
  `parseMarkdown` in `lib/markdown.js`; `test/preview.test.js` cross-checks both on the same sources.
  Any behaviour change must be applied to both files. (The optional seed-module `require` above is a
  runtime lookup, not an import, so this rule still holds.)
- Documents above `MARKDOWN_MAX_BYTES` (8 MiB) and empty/blank documents render readable Chinese
  states instead of a tree. These states replace the pane before the view bar, since neither view can
  be shown.

**Shared**
- Render the existing `MindmapCard` with `variant: 'preview'` (fills the pane, no card border).
- Invalid workbooks, unreadable content and non-matching loading modes render readable Chinese
  states; never throw.

### 5b. Chat card

- Keys: `view_xmind`, `markdown_to_mindmap`, `edit_mindmap_node`, `xmind_to_markdown`.
- `phase === 'preparing'`: compact row: icon + title (`mindmap.scanning`).
- `phase === 'start'` / `'result'`: header row (icon, title, 节点数/Sheet/警告 badges), expandable body.
- Body layout:
  - Toolbar: `导图` / `大纲` toggle, `适应` (fit), zoom `−` `+`, `全部展开` / `全部收起`,
    `Mermaid` source toggle (copyable `<pre>`), warnings list.
  - Mindmap: horizontal tidy tree drawn as SVG: rounded rect nodes, bezier links, node click toggles
    collapse, selected node shows a side panel with `notes`, `href` (link), `labels`.
  - Outline: collapsible `<ul>` rows equivalent to the tree.
  - Read-only: no drag-editing of the tree; editing happens through `edit_mindmap_node`.
  - Pan: pointer drag on the SVG; zoom: wheel + buttons (0.3x..3x); fit resets.
  - Notes badge on nodes that have notes. `[备注]` marker in node text.
  - Degradation: when `meta` is absent or malformed, fall back to rendering `block.content` text
    blocks (generic card look) — never crash, never blank the slot.
- Styling: inline styles only; use `var(--dsw-alias-*)` theme tokens with literal fallbacks
  (e.g. `var(--dsw-alias-label-primary, #1f2328)`); no global CSS, no `document.body` writes.
- Accessibility: buttons with `aria-label`, `aria-expanded` on disclosure rows, keyboard Enter/Space
  toggling for rows, `role="tree"`/`role="treeitem"` on the outline.
- Must be testable from node: `__internals.layoutTree(root, {collapsed})` returns
  `{ nodes:[{id,x,y,w,h,depth,title,...}], links:[{from,to}], width, height }`; assert determinism and
  that children never overlap their parent or siblings vertically.
- Locale: zh + en dictionaries registered as namespace `xmind`.

## 6. Layout / conventions

```
plugins/dsh-xmind-mindmap/
  package.json                (Lead)
  cordis.patch.yml            (Lead)
  index.js                    (host-tools)
  client.js                   (client-card)
  icon.svg                    (Lead)
  locale/{en,zh}.json         (Lead)
  lib/{tree,mermaid,markdown,zip,xml,xmind,fsio,tools}.js
  test/{tree,mermaid,markdown,zip,xml,xmind,fsio,tools,client,contract}.test.js
  test/support/               (Lead: vendored real defineTool + dsh-llm stub for contract tests)
  scripts/                    (Lead: install-profile.mjs, restore-profile.mjs)
  README.md                   (Lead)
```

- ESM `import` only; relative imports end in `.js`. No npm packages in runtime code.
- Every file starts with a one-line responsibility comment. JSDoc on exported functions.
- Chinese user-facing strings in warnings/errors, English in code comments where natural.
- Tests use `node:test` + `node:assert/strict`, are hermetic (write only under `test/.tmp/`), and do
  not require network.
- Run tests with:
  `& "D:\DSH_Data\Home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --test test/*.test.js`
  (PowerShell). Never install node_modules.
- Do not modify files outside your write scope. Report progress to the Lead with the files you own,
  what passed, and any interface deviation.
