/**
 * Harness-compatible tool compiler.
 *
 * The contract-correct path is `defineTool` from `@deepseek-ai/dsh-tools`, and the
 * host entry tries that import first. This module exists because a profile plugin
 * loaded from outside the DSH installation may not be able to resolve Harness
 * packages at runtime (no package-resolution anchor for profile plugins). The
 * compiler below reproduces the exact raw JSON Schema that the shipped
 * `defineTool` produces for the authoring DSL this plugin uses, plus the argument
 * validation `defineTool` wraps around `execute`, so the registry sees an
 * identical definition either way. `test/fallback-contract.test.js` compiles all
 * four tools with both implementations and deep-compares the results.
 */

const ANNOTATIONS = ['description', 'title', 'default', 'examples']

function copyAnnotations(source, target) {
  for (const key of ANNOTATIONS) {
    if (Object.hasOwn(source, key)) target[key] = source[key]
  }
}

/** Compile one value-schema author node into the enforced raw JSON Schema subset. */
function compileValue(input, path = 'schema') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${path} must be a value schema object`)
  }
  const node = {}
  copyAnnotations(input, node)
  if (Object.hasOwn(input, 'oneOf')) {
    if (Object.hasOwn(input, 'type')) throw new TypeError(`${path} cannot declare both type and oneOf`)
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) {
      throw new TypeError(`${path}.oneOf must be an array of at least two value schemas`)
    }
    node.oneOf = input.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`))
    return node
  }
  const type = Object.hasOwn(input, 'type') ? input.type : undefined
  switch (type) {
    case 'json':
      return node
    case 'object': {
      if (typeof input.additionalProperties !== 'boolean') {
        throw new TypeError(`${path}.additionalProperties must be explicitly true or false`)
      }
      node.type = 'object'
      node.additionalProperties = input.additionalProperties
      if (Object.hasOwn(input, 'properties')) {
        const { properties, required } = compileProperties(input.properties, `${path}.properties`)
        node.properties = properties
        if (required !== undefined) node.required = required
      }
      return node
    }
    case 'array': {
      node.type = 'array'
      if (Object.hasOwn(input, 'items')) node.items = compileValue(input.items, `${path}.items`)
      return node
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      node.type = type
      if (Object.hasOwn(input, 'enum')) {
        if (!Array.isArray(input.enum) || input.enum.length === 0) {
          throw new TypeError(`${path}.enum must be a non-empty array of scalar values`)
        }
        node.enum = [...input.enum]
      }
      if (Object.hasOwn(input, 'const')) node.const = input.const
      return node
    }
    default:
      throw new TypeError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
  }
}

/** Compile an author property map (each value may add `required: true`). */
function compileProperties(input, path) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${path} must be an object of value schemas`)
  }
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(input)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${path}.${key} must be a value schema object`)
    }
    if (Object.hasOwn(value, 'required') && value.required !== true) {
      throw new TypeError(`${path}.${key}.required must be true when present`)
    }
    if (value.required === true) required.push(key)
    const { required: _ignored, ...schema } = value
    properties[key] = compileValue(schema, `${path}.${key}`)
  }
  return required.length > 0 ? { properties, required } : { properties, required: undefined }
}

/** Compile the implicit open parameter object into raw JSON Schema. */
export function compileParameterSchema(parameters) {
  const { properties, required } = compileProperties(parameters, 'parameters')
  return required === undefined
    ? { type: 'object', properties }
    : { type: 'object', properties, required }
}

/** Compile one output value schema into raw JSON Schema. */
export function compileValueSchema(schema) {
  return compileValue(schema, 'schema')
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    default: return true
  }
}

/**
 * Validate one value against the compiled raw schema, returning path-qualified
 * violations. Mirrors the shipped validator for the subset this plugin emits.
 */
export function validateCompiled(schema, value, path = '') {
  const violations = []
  if (schema === undefined || Object.keys(schema).length === 0) return violations
  if (schema.oneOf !== undefined) {
    const branchViolations = schema.oneOf.map((branch, index) => validateCompiled(branch, value, path))
    if (branchViolations.every((list) => list.length > 0)) {
      violations.push(`${path || 'value'} must match one of the allowed schemas`)
    }
    return violations
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    violations.push(`"${path}" must be of type ${schema.type}`)
    return violations
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    violations.push(`"${path}" must equal the declared constant`)
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    violations.push(`"${path}" must be one of the declared enum values`)
  }
  if (schema.type === 'object' && isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`missing required property "${path === '' ? key : `${path}.${key}`}"`)
    }
    const properties = schema.properties ?? {}
    for (const [key, entry] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`
      if (Object.hasOwn(properties, key)) violations.push(...validateCompiled(properties[key], entry, childPath))
      else if (schema.additionalProperties === false) violations.push(`unexpected property "${childPath}"`)
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => {
      violations.push(...validateCompiled(schema.items, entry, `${path}[${index}]`))
    })
  }
  return violations
}

/**
 * `defineTool`-compatible compiler: returns the same shape the shipped helper
 * produces for the DSL subset this plugin uses, with argument validation wrapped
 * around `execute`.
 * @param {object} options author options ({ name, description, parameters, output, execute, timeoutMs? }).
 * @returns {object} a registry-ready definition.
 */
export function compileTool(options) {
  const name = options?.name
  if (typeof name !== 'string' || name === '') throw new TypeError('defineTool(name) must be a non-empty string')
  if (typeof options.description !== 'string') throw new TypeError(`defineTool(${name}): description must be a string`)
  if (typeof options.output?.render !== 'function') throw new TypeError(`defineTool(${name}): output.render must be a function`)
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new TypeError(`defineTool(${name}): timeoutMs must be a positive finite number`)
  }
  const parameters = compileParameterSchema(options.parameters ?? {})
  const outputSchema = compileValueSchema(options.output.schema)
  const render = options.output.render
  const presentationMeta = options.output.presentationMeta
  return {
    name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return render(args, value)
      },
      ...(presentationMeta !== undefined
        ? { presentationMeta(args, value) { return presentationMeta(args, value) } }
        : {}),
    },
    ...(options.deferLoading === true ? { deferLoading: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validateCompiled(parameters, args)
      if (violations.length > 0) {
        const error = new Error(`invalid arguments: ${violations.join('; ')}`)
        error.name = 'ToolArgsError'
        error.code = 'INVALID_ARGS'
        error.violations = violations
        throw error
      }
      return options.execute(args, exec)
    },
  }
}
