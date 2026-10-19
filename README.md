# dsh-xmind-mindmap

A DeepSeek Harness plugin for browsing and editing Markdown and XMind trees as
read-only, interactive mindmap cards inside the chat stream.

- **Host half** (`index.js`): `export const inject = ['tools']` + four tools registered through
  `ctx.tools.register(defineTool(...))`. It uses the Harness `defineTool` when the deployment lets a
  profile plugin resolve `@deepseek-ai/dsh-tools`, and otherwise falls back to the local
  contract-equivalent compiler in `lib/define-tool.js` (byte-identical schema output, same argument
  validation; verified against the shipped compiler in `test/fallback-contract.test.js`).
- **Client half** (`client.js`): registers a card for those four tool names in the keyed
  `tool.call.toolview` slot, using React from the Harness module table and inline theme-token styles.
- **No runtime dependencies.** ZIP read/write uses `node:zlib`, XML uses a small built-in parser,
  Markdown uses a built-in block parser. Nothing is installed at runtime and no file handle is kept
  open between calls.

## Tools

| Tool | Purpose | Arguments |
|---|---|---|
| `view_xmind` | Read `.xmind` (XMind 2020+ `content.json` **or** XMind 8 `content.xml`) and render the topic tree as a read-only interactive mindmap card. | `xmindPath` (absolute, required), `sheetIndex` (0-based, default 0) |
| `markdown_to_mindmap` | Convert Markdown to the shared tree schema; optionally write an `.xmind` workbook. | `mdPath` (required), `outputXmindPath` (optional) |
| `edit_mindmap_node` | Incrementally edit one node of an `.xmind` or `.md` tree and return the edited tree. | `sourcePath`, `nodeId`, `action` (`update_title` / `add_child` / `delete_node` / `move_node`), `payload` |
| `xmind_to_markdown` | Convert `.xmind` to Markdown; optionally write the `.md` file. | `xmindPath` (required), `outputMdPath` (optional) |

Every tool shares one canonical tree shape:

```json
{
  "id": "t1",
  "title": "Root topic",
  "children": { "attached": [] },
  "notes": "optional",
  "href": "https://optional",
  "labels": ["optional"]
}
```

`output.render` returns compact text (a summary line plus a Mermaid `mindmap` fence) for the model
and for UIs without a client card. `output.presentationMeta` carries the full tree, Mermaid source,
sheet metadata and warnings to the Web card through the persisted result `meta` field, so the model
never receives a wall of JSON.

## Right Sidebar `.xmind` preview

Open any `.xmind` from the Files sidebar (or click a `.xmind` path) and the right
Sidebar renders it directly — no chat turn, no tool call:

- registered with `ctx.documentPreviews.register({ extensions: ['xmind'],
  binaryExtensions: ['xmind'], loading: 'bytes-complete', priority: 'extension' })`
  plus a body in the keyed `sidebar.right.tab.document` slot;
- reads the workbook's bytes in the browser, unzips them with `DecompressionStream`
  (`deflate-raw`), and parses `content.json` first, falling back to `content.xml`
  (XMind 8). The browser parser is tested against the host parser on both formats;
- multiple sheets get a selector above the map; the map supports fit, zoom, pan,
  expand/collapse, 导图/大纲 and the node details panel with notes/href/labels;
- unsupported or corrupt workbooks show a readable Chinese error instead of
  "该格式文件暂时无法预览".

## The card

- Header badges: node count, sheet `i/n`, warning count.
- **导图 / 大纲** toggle: an SVG horizontal tidy tree (pan by dragging, wheel/buttons zoom, fit,
  expand/collapse all, per-node collapse) or a collapsible outline.
- Clicking a node opens its `notes`, `href` and `labels`; nodes with notes are marked `[备注]`.
- **Mermaid** toggle shows the exact `mindmap` source (copyable).
- Read-only: the canvas never edits the tree. Edits go through `edit_mindmap_node`; the card
  re-renders from the new tool result.
- If `meta` is absent (old sessions, other UIs) the card falls back to the recorded text blocks.
- No Mermaid renderer is required. If the target DSH profile does have one, the emitted
  `mindmap` source can be rendered elsewhere; this plugin does not implement a canvas engine.

## Markdown ↔ tree mapping

Markdown → tree:

- The **first** `#` heading is the root; later `#` headings become its children. With no `#`, the
  root title is the file name without extension.
- `##`–`######` map to depths 2–6; headings deeper than 6 attach under the nearest depth-6 node and
  keep their extra depth in `notes` on the way back.
- `-`/`*`/`+` and `1.` list items become children; indentation is 2 spaces or 1 tab, and the marker
  never enters the title. Mixed indentation produces a warning.
- A paragraph right after a heading/list item becomes that node's `notes`; a standalone paragraph
  becomes a root child with an 80-character title and the full text in `notes`.
- A heading/list item whose text is exactly one `[label](url)` link gets `href`.
- Fenced code blocks, tables, images and blockquotes are preserved verbatim in `notes` with the
  `该内容类型暂不支持 XMind 结构映射:` marker, plus a warning naming the element.

Tree → Markdown: root → `#`, depth 2–6 → the matching heading, deeper → `######` with
`原始层级深度: <n>` in notes, `notes` after the heading, `href` rendered as a link, labels as
trailing `#label` tokens.

## `.xmind` handling

- Reads ZIP entries through the central directory; supports stored and deflated entries.
- Format detection: a usable `content.json` wins (XMind 2020+); when it is missing, empty,
  a placeholder or invalid, parsing falls back to `content.xml` (XMind 8 / Classic). A new-version
  file whose `content.xml` is only a placeholder therefore still works.
- Multi-sheet files return `sheetCount` and the selected sheet; the card tells the user to call
  `view_xmind` again with `sheetIndex` to switch.
- Writes a workbook containing `mimetype` (**first entry, uncompressed**), `content.json`,
  a compatible `content.xml`, `metadata.json`, `manifest.json` and `META-INF/manifest.xml`.
- Notes, labels, href and `children.attached` are preserved in both directions.

## Safety

- Every path must be absolute and may not contain `..` segments; extensions are checked per tool.
- `execute` observes `exec.signal` before and after file work and ZIP compression.
- Existing output files are never silently overwritten: an existing `.md`/`.xmind` target with
  different bytes fails the call.
- In-place edits read a baseline (size, mtime, SHA-256) first and refuse to write when the file
  changed after it was read.
- `delete_node` never removes the root; `update_title` rejects empty/whitespace titles;
  `move_node` refuses to move a node into its own subtree; ids stay unique.
- Tool registration is not wrapped in `ctx.effect` — the tool registry owns the lifecycle. No
  `ctx.effect`, listener or file handle holds anything after unload/reload.

## Install

The distribution bundle (`dsh-xmind-mindmap-<version>.zip` / `.tgz`) contains this whole directory.
Unzip it on the target machine and follow [INSTALL.md](INSTALL.md) (Chinese). The short version:

```powershell
# in the unzipped dsh-xmind-mindmap directory
node scripts/install-profile.mjs verify
node scripts/install-profile.mjs apply                 # finds $DSH_PROFILE_DIR / $DSH_HOME
# or: node scripts/install-profile.mjs apply --profile-dir "C:\Users\me\.dsh\profiles\desktop"
# then restart DeepSeek Harness once

node scripts/install-profile.mjs status
node scripts/install-profile.mjs restore               # roll back the latest install
node scripts/install-profile.mjs uninstall             # remove links + manifest entries
```

`apply` edits only `<profile>/package.json` (dependency + `dsh.profile.bundles`), links (Windows
junction / symlink elsewhere) the directory under `<profile>/node_modules/dsh-xmind-mindmap`, and
keeps a timestamped backup under `<profile>/.dsh-xmind-mindmap-backups/`. The profile is resolved
from `--profile-dir`, then `$DSH_PROFILE_DIR`, then `$DSH_HOME/profiles/<name>` (default `desktop`).
A newly added profile bundle is loaded by a fresh composition: restart the Desktop app once.

If the target deployment exposes `plugin_manager`, installing the directory as a bundle works too;
confirm that `dsh.profile.bundles` contains `dsh-xmind-mindmap` afterwards.

Rebuild the distribution archives with:

```powershell
node scripts/build-package.mjs   # writes ../../dist/dsh-xmind-mindmap-<version>.{zip,tgz} + SHA256SUMS
```

## Tests

```powershell
$NODE = "D:\DSH_Data\Home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $NODE --test test/*.test.js
```

- `test/contract.test.js` compiles every tool with the **real shipped**
  `@deepseek-ai/dsh-tools` `defineTool`/validator (vendored test-only under
  `test/support/vendor`), then validates arguments, output values, render blocks,
  `presentationMeta` and cancellation.
- `test/acceptance.test.js` is the seven-criterion acceptance matrix from the delivery brief.
- Module tests cover the Markdown mapping, Mermaid serialization, ZIP/XML/XMind I/O, edit
  semantics, path safety and the client card layout/harness.
