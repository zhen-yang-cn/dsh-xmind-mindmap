// Tree schema helpers: normalize loose mindmap nodes into the canonical TreeNode shape, traverse, and validate.

/** The only recursive-safe value schema node available to tool definitions. */
export const TREE_NODE_JSON_SCHEMA = { type: 'json' }

const MAX_WALK_DEPTH = 512

/**
 * @param {unknown} value
 * @returns {boolean} true for plain objects ({}-prototype or null-prototype), false for arrays/class instances.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Return the string only when it carries non-whitespace content.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
  return isNonEmptyString(value) ? value : undefined
}

/**
 * Extract the raw child array from either `{ attached: [] }` or a bare array.
 * @param {unknown} children
 * @returns {unknown[]}
 */
function extractChildren(children) {
  if (Array.isArray(children)) return children
  if (isPlainObject(children) && Array.isArray(children.attached)) return children.attached
  return []
}

/**
 * Trim, drop empty entries and de-duplicate labels while preserving first-seen order.
 * @param {unknown} labels
 * @returns {string[]}
 */
function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return []
  const seen = new Set()
  const out = []
  for (const label of labels) {
    if (typeof label !== 'string') continue
    const trimmed = label.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Build a canonical TreeNode from a partial/loose object.
 * Fills `children.attached`, drops empty optional fields and de-duplicates labels.
 * Missing ids fall back to `'node'`; use {@link normalizeTree} when unique ids are needed.
 * @param {object} [partial]
 * @returns {{id: string, title: string, children: {attached: object[]}, notes?: string, href?: string, labels?: string[]}}
 */
export function createNode(partial = {}) {
  const source = isPlainObject(partial) ? partial : {}
  const id = isNonEmptyString(source.id) ? source.id : 'node'
  const title = isNonEmptyString(source.title) ? source.title.trim() : 'Untitled'
  const node = { id, title, children: { attached: [] } }
  for (const child of extractChildren(source.children)) {
    if (isPlainObject(child)) node.children.attached.push(createNode(child))
  }
  const notes = optionalString(source.notes)
  if (notes !== undefined) node.notes = notes
  const href = optionalString(source.href)
  if (href !== undefined) node.href = href.trim()
  const labels = normalizeLabels(source.labels)
  if (labels.length > 0) node.labels = labels
  return node
}

/**
 * Normalize a loose XMind-ish tree (or a bare array style) into the canonical schema.
 * Generates collision-free ids, falls back to `Untitled`, drops empty optional fields and
 * truncates beyond `maxDepth` (each degradation appends one Chinese warning).
 * @param {unknown} raw
 * @param {{idPrefix?: string, maxDepth?: number, warnings?: string[]}} [opts]
 * @returns {{root: object, warnings: string[]}}
 */
export function normalizeTree(raw, opts = {}) {
  const idPrefix = isNonEmptyString(opts.idPrefix) ? opts.idPrefix : 't'
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : 64
  const warnings = Array.isArray(opts.warnings) ? opts.warnings : []
  const usedIds = new Set()
  let counter = 0

  /** @returns {string} */
  function nextId() {
    let candidate
    do {
      counter += 1
      candidate = `${idPrefix}${counter}`
    } while (usedIds.has(candidate))
    return candidate
  }

  /**
   * @param {unknown} input
   * @param {number} depth
   * @returns {object}
   */
  function normalizeNode(input, depth) {
    if (!isPlainObject(input)) {
      warnings.push('节点数据无效，已使用占位节点')
      const id = nextId()
      usedIds.add(id)
      return createNode({ id, title: 'Untitled' })
    }

    let id
    if (isNonEmptyString(input.id)) {
      if (usedIds.has(input.id)) {
        warnings.push(`节点 id 重复，已重新生成: ${input.id}`)
        id = nextId()
      } else {
        id = input.id
      }
    } else {
      id = nextId()
    }
    usedIds.add(id)

    let title = ''
    if (isNonEmptyString(input.title)) title = input.title.trim()
    else warnings.push('节点标题为空，已使用默认标题')
    if (!title) title = 'Untitled'

    const node = { id, title, children: { attached: [] } }
    const notes = optionalString(input.notes)
    if (notes !== undefined) node.notes = notes
    const href = optionalString(input.href)
    if (href !== undefined) node.href = href.trim()
    const labels = normalizeLabels(input.labels)
    if (labels.length > 0) node.labels = labels

    const children = extractChildren(input.children)
    if (children.length === 0 && input.children !== undefined && !Array.isArray(input.children)) {
      const attached = isPlainObject(input.children) ? input.children.attached : undefined
      if (!Array.isArray(attached)) warnings.push('节点 children 字段不是数组，已忽略')
    }

    if (children.length > 0 && depth >= maxDepth) {
      warnings.push(`导图层级超过 ${maxDepth} 层，已截断更深节点`)
      return node
    }

    for (const child of children) {
      if (!isPlainObject(child)) {
        warnings.push('子节点数据无效，已忽略')
        continue
      }
      node.children.attached.push(normalizeNode(child, depth + 1))
    }
    return node
  }

  const root = normalizeNode(raw, 1)
  return { root, warnings }
}

/**
 * Pre-order traversal, capped at depth 512 so a cyclic tree cannot hang.
 * @param {object | null | undefined} root
 * @param {(node: object, depth: number, parent: object | null) => void} visit
 * @returns {number} number of visited nodes
 */
export function walkTree(root, visit) {
  if (!isPlainObject(root) || typeof visit !== 'function') return 0
  let count = 0
  /** @type {Array<[object, number, object | null]>} */
  const stack = [[root, 1, null]]
  while (stack.length > 0) {
    const [node, depth, parent] = stack.pop()
    if (depth > MAX_WALK_DEPTH) continue
    count += 1
    visit(node, depth, parent)
    const children = extractChildren(node.children)
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]
      if (isPlainObject(child)) stack.push([child, depth + 1, node])
    }
  }
  return count
}

/**
 * Flatten the tree in pre-order.
 * @param {object | null | undefined} root
 * @returns {Array<{node: object, depth: number, parent: object | null, index: number}>}
 */
export function flattenTree(root) {
  const out = []
  if (!isPlainObject(root)) return out
  /** @type {Array<[object, number, object | null, number]>} */
  const stack = [[root, 1, null, -1]]
  while (stack.length > 0) {
    const [node, depth, parent, index] = stack.pop()
    if (depth > MAX_WALK_DEPTH) continue
    out.push({ node, depth, parent, index })
    const children = extractChildren(node.children)
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]
      if (isPlainObject(child)) stack.push([child, depth + 1, node, i])
    }
  }
  return out
}

/**
 * Find a node by id.
 * @param {object | null | undefined} root
 * @param {string} id
 * @returns {{node: object, parent: object | null, index: number, depth: number} | null}
 */
export function findNode(root, id) {
  if (!isNonEmptyString(id)) return null
  for (const entry of flattenTree(root)) {
    if (entry.node.id === id) return entry
  }
  return null
}

/**
 * @param {object | null | undefined} root
 * @returns {number}
 */
export function countNodes(root) {
  let count = 0
  walkTree(root, () => {
    count += 1
  })
  return count
}

/**
 * Maximum tree depth (root = 1, empty tree = 0).
 * @param {object | null | undefined} root
 * @returns {number}
 */
export function treeDepth(root) {
  let max = 0
  walkTree(root, (_node, depth) => {
    if (depth > max) max = depth
  })
  return max
}

/**
 * @param {object | null | undefined} root
 * @returns {Set<string>}
 */
export function collectIds(root) {
  const ids = new Set()
  walkTree(root, (node) => {
    if (typeof node.id === 'string') ids.add(node.id)
  })
  return ids
}

/**
 * Generate the first `${prefix}${n}` id (n starting at 1) that is not already used.
 * @param {Iterable<string> | ArrayLike<string> | null | undefined} existingIds
 * @param {string} [prefix]
 * @returns {string}
 */
export function generateId(existingIds, prefix = 'n') {
  const safePrefix = isNonEmptyString(prefix) ? prefix : 'n'
  const used = existingIds instanceof Set ? existingIds : new Set(Array.isArray(existingIds) ? existingIds : [])
  let index = 1
  let candidate = `${safePrefix}${index}`
  while (used.has(candidate)) {
    index += 1
    candidate = `${safePrefix}${index}`
  }
  return candidate
}

/**
 * Deep clone a tree (works on the JSON-safe canonical shape).
 * @template T
 * @param {T} root
 * @returns {T}
 */
export function cloneTree(root) {
  return structuredClone(root)
}

/**
 * Validate the canonical invariants.
 * @param {unknown} root
 * @returns {string[]} violations; empty means valid
 */
export function validateTree(root) {
  const violations = []
  if (!isPlainObject(root)) {
    violations.push('根节点必须是普通对象')
    return violations
  }

  const ids = new Set()
  const path = new Set()

  /**
   * @param {unknown} node
   * @param {number} depth
   */
  function checkNode(node, depth) {
    if (depth > MAX_WALK_DEPTH) {
      violations.push(`节点层级超过 ${MAX_WALK_DEPTH}，可能存在循环引用`)
      return
    }
    if (!isPlainObject(node)) {
      violations.push(`第 ${depth} 层节点必须是普通对象`)
      return
    }
    if (path.has(node)) {
      violations.push('导图中存在循环引用')
      return
    }
    path.add(node)

    const label = isNonEmptyString(node.id) ? `节点 ${node.id}` : `第 ${depth} 层节点`

    if (!isNonEmptyString(node.id)) {
      violations.push(`${label} 缺少非空字符串 id`)
    } else if (ids.has(node.id)) {
      violations.push(`节点 id 重复: ${node.id}`)
    } else {
      ids.add(node.id)
    }

    if (typeof node.title !== 'string' || node.title.trim() === '') {
      violations.push(`${label} 的 title 必须是非空字符串`)
    }

    if ('notes' in node && optionalString(node.notes) === undefined) {
      violations.push(`${label} 的 notes 必须是非空字符串（空值应省略）`)
    }
    if ('href' in node && optionalString(node.href) === undefined) {
      violations.push(`${label} 的 href 必须是非空字符串（空值应省略）`)
    }
    if ('labels' in node) {
      const labels = node.labels
      if (!Array.isArray(labels) || labels.length === 0) {
        violations.push(`${label} 的 labels 必须是非空数组（空值应省略）`)
      } else {
        const seen = new Set()
        for (const item of labels) {
          if (!isNonEmptyString(item) || item !== item.trim()) {
            violations.push(`${label} 的 labels 必须是非空且已去空白的字符串`)
            break
          }
          if (seen.has(item)) {
            violations.push(`${label} 的 labels 存在重复项: ${item}`)
            break
          }
          seen.add(item)
        }
      }
    }

    if (!isPlainObject(node.children) || !Array.isArray(node.children.attached)) {
      violations.push(`${label} 的 children.attached 必须是数组`)
    } else {
      for (const child of node.children.attached) checkNode(child, depth + 1)
    }

    path.delete(node)
  }

  checkNode(root, 1)
  return violations
}

/**
 * Throw when the tree violates the canonical invariants.
 * @param {unknown} root
 * @throws {Error} `invalid tree: <violations joined by '; '>`
 */
export function assertTree(root) {
  const violations = validateTree(root)
  if (violations.length > 0) throw new Error(`invalid tree: ${violations.join('; ')}`)
}

/**
 * Count nodes that carry a non-empty value for `field` (used by render summaries).
 * @param {object | null | undefined} root
 * @param {'notes' | 'href' | 'labels' | string} field
 * @returns {number}
 */
export function countWithField(root, field) {
  let count = 0
  walkTree(root, (node) => {
    const value = node[field]
    if (typeof value === 'string') {
      if (value.trim() !== '') count += 1
    } else if (Array.isArray(value)) {
      if (value.length > 0) count += 1
    } else if (value !== undefined && value !== null) {
      count += 1
    }
  })
  return count
}
