# DSH XMind Mindmap

A plugin that browses Markdown and .xmind trees as interactive mindmap cards.

## View

- `view_xmind` reads .xmind workbooks
- `markdown_to_mindmap` converts Markdown
- `edit_mindmap_node` edits one node
- `xmind_to_markdown` writes Markdown

## Notes

Paragraphs directly under a heading become node notes.

| capability | state |
| --- | --- |
| XMind 2020 | supported |
| XMind 8 | supported |

```js
const map = view_xmind({ xmindPath })
```

## Roadmap

- Phase 1
  - parse both formats
  - shared tree schema
- Phase 2
  - write-back
  - round-trip tests
