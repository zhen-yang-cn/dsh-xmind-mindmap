// Mermaid mindmap serialization for the shared tree schema (degradation text for environments with a renderer).

const SPECIAL_CHARACTERS = new Set(['(', ')', '[', ']', '{', '}', '<', '>', '"', "'", ':', ';', '#', '`'])
const DEFAULT_MAX_NODES = 800
const DEFAULT_INDENT = '  '
const TRUNCATED_MARKER = '... (truncated)'

/**
 * Escape characters Mermaid treats as shapes/syntax and flatten newlines to spaces.
 * Characters `()[]{}<>"':;#`` are prefixed with a backslash; `\r\n`, `\r` and `\n` become a space.
 * @param {unknown} text
 * @returns {string}
 */
export function escapeMermaidLabel(text) {
  if (text === null || text === undefined) return ''
  const source = String(text).replace(/\r\n|\r|\n/g, ' ')
  let out = ''
  for (const character of source) {
    out += SPECIAL_CHARACTERS.has(character) ? `\\${character}` : character
  }
  return out
}

/**
 * @param {object} node
 * @returns {string} escaped title + ` [备注]` when notes exist + ` #label` tokens.
 */
function formatNodeLine(node) {
  const rawTitle = typeof node.title === 'string' ? node.title.trim() : ''
  let line = escapeMermaidLabel(rawTitle || 'Untitled')
  if (typeof node.notes === 'string' && node.notes.trim() !== '') line += ' [备注]'
  if (Array.isArray(node.labels)) {
    for (const label of node.labels) {
      if (typeof label !== 'string' || label.trim() === '') continue
      line += ` #${escapeMermaidLabel(label.trim())}`
    }
  }
  return line
}

/**
 * Serialize the tree as a Mermaid `mindmap` source string.
 * Deterministic pre-order; two-space indentation per level by default. When more than `maxNodes`
 * nodes exist, the first `maxNodes` are emitted followed by a final `... (truncated)` leaf.
 * Warnings are intentionally not produced here (the caller owns them).
 * @param {object | null | undefined} root
 * @param {{maxNodes?: number, indent?: string}} [opts]
 * @returns {string} starts with `mindmap\n`
 */
export function treeToMermaid(root, opts = {}) {
  const indent = typeof opts.indent === 'string' ? opts.indent : DEFAULT_INDENT
  const maxNodes =
    Number.isFinite(opts.maxNodes) && opts.maxNodes >= 0 ? Math.floor(opts.maxNodes) : DEFAULT_MAX_NODES

  let output = 'mindmap\n'
  if (!root || typeof root !== 'object') return output

  const lines = []
  let emitted = 0
  let truncated = false
  let lastDepth = 1

  /** @param {object} node @param {number} depth */
  function visit(node, depth) {
    if (truncated) return
    if (emitted >= maxNodes) {
      truncated = true
      return
    }
    if (!node || typeof node !== 'object') return
    lines.push(`${indent.repeat(depth - 1)}${formatNodeLine(node)}`)
    emitted += 1
    lastDepth = depth
    const children = node.children && Array.isArray(node.children.attached) ? node.children.attached : []
    for (const child of children) {
      if (truncated) break
      if (child && typeof child === 'object') visit(child, depth + 1)
    }
  }

  visit(root, 1)
  output += lines.join('\n')
  if (lines.length > 0) output += '\n'
  if (truncated) output += `${indent.repeat(lastDepth)}${TRUNCATED_MARKER}\n`
  return output
}

/**
 * Whether this DSH profile has a Mermaid renderer available (it does not; kept for degradation rules).
 * @returns {false}
 */
export function isMindmapSupported() {
  return false
}
