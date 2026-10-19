/* Test harness: runs client.js under node with a fake window.__ModuleLoader__, a minimal React stub and a fake plugin ctx. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const harnessDir = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(harnessDir, '..', 'client.js')

/** Minimal React stand-in: createElement returns plain { type, props } descriptors. */
export function createReactStub(stateOverrides) {
  const overrides = stateOverrides || null
  let stateIndex = 0
  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    const nextProps = Object.assign({}, props || {})
    if (children.length === 1) nextProps.children = children[0]
    else if (children.length > 1) nextProps.children = children
    return { type: type, props: nextProps }
  }
  return {
    createElement: createElement,
    Fragment: 'Fragment',
    useState: function (initial) {
      const index = stateIndex
      stateIndex += 1
      const hasOverride = overrides && Object.prototype.hasOwnProperty.call(overrides, index)
      return [hasOverride ? overrides[index] : typeof initial === 'function' ? initial() : initial, function () {}]
    },
    useEffect: function (effect) {
      effect()
    },
    useLayoutEffect: function (effect) {
      effect()
    },
    useMemo: function (factory) {
      return factory()
    },
    useCallback: function (callback) {
      return callback
    },
    useRef: function (initial) {
      return { current: initial === undefined ? null : initial }
    },
  }
}

/**
 * Execute client.js in a vm sandbox with a fake module loader.
 * @returns {{source: string, id: string, factory: Function, module: object, react: object, requireCalls: string[]}}
 */
export function loadClient(options) {
  const opts = options || {}
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const react = createReactStub(opts.stateOverrides)
  const requireCalls = []
  const captured = { id: null, factory: null }
  const window = {
    __ModuleLoader__: {
      load: function (definition) {
        captured.id = definition && definition.id
        captured.factory = definition && definition.factory
        if (window.__moduleLoaderLoadCount == null) window.__moduleLoaderLoadCount = 0
        window.__moduleLoaderLoadCount += 1
      },
    },
  }
  const requireStub = function (id) {
    requireCalls.push(id)
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  }
  // Evaluate in the host realm (not vm) so internals produce host-realm objects that deepEqual compares naturally.
  const run = new Function('window', 'console', source)
  run(window, console)
  if (typeof captured.factory !== 'function') {
    throw new Error('client.js did not call window.__ModuleLoader__.load({ id, factory })')
  }
  const moduleExports = captured.factory(requireStub)
  return {
    source: source,
    id: captured.id,
    factory: captured.factory,
    module: moduleExports,
    react: react,
    requireCalls: requireCalls,
    window: window,
  }
}

/** Fake plugin ctx capturing slot registrations, locale dictionaries and effects. */
export function createFakeCtx() {
  const state = {
    registrations: [],
    localeRegistrations: [],
    effects: [],
    injectCalls: [],
    injected: [],
    documentPreviews: [],
  }
  const ctx = {
    effect: function (callback, label) {
      state.effects.push({ label: label, callback: callback })
      return callback()
    },
    documentPreviews: {
      register: function (definition) {
        state.documentPreviews.push(definition)
        return function () {}
      },
    },
    slots: {
      inject: function (name, factory) {
        state.injectCalls.push(name)
        const value = factory()
        state.injected.push({ name: name, value: value })
        return value
      },
      register: function (target, component) {
        state.registrations.push({ target: target, component: component })
        return {
          target: target,
          component: component,
          dispose: function () {},
        }
      },
    },
    locale: {
      register: function (namespace, dictionaries) {
        state.localeRegistrations.push({ namespace: namespace, dictionaries: dictionaries })
        return function () {}
      },
    },
  }
  return { ctx: ctx, state: state }
}

/** Load client.js and run apply() against a fake ctx. */
export function setup(options) {
  const loaded = loadClient(options)
  const fake = createFakeCtx()
  loaded.module.apply(fake.ctx)
  const components = fake.state.registrations.map(function (registration) {
    return registration.component
  })
  const keys = fake.state.registrations.map(function (registration) {
    return registration.target.key
  })
  return {
    loaded: loaded,
    ctx: fake.ctx,
    state: fake.state,
    registrations: fake.state.registrations,
    components: components,
    keys: keys,
    Card: components[0],
    internals: loaded.module.__internals,
  }
}

/** Recursively collect element descriptors matching a predicate (depth-first). */
export function findElements(node, predicate, out) {
  const found = out || []
  if (node == null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) findElements(node[i], predicate, found)
    return found
  }
  if (node.props && typeof node.props === 'object') {
    if (node.type && predicate(node)) found.push(node)
    findElements(node.props.children, predicate, found)
  }
  return found
}

/** First element descriptor matching a predicate. */
export function findElement(node, predicate) {
  return findElements(node, predicate)[0] || null
}

/** Recursively collect string children from a React element descriptor tree. */
export function collectStrings(node, out) {
  const collected = out || []
  if (node == null || typeof node === 'boolean') return collected
  if (typeof node === 'string' || typeof node === 'number') {
    collected.push(String(node))
    return collected
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) collectStrings(node[i], collected)
    return collected
  }
  if (typeof node === 'object' && node.props && typeof node.props === 'object') {
    collectStrings(node.props.children, collected)
  }
  return collected
}
