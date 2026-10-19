/** Host entry: register the four mindmap tools with the harness tool registry. */
import { createToolDefinitions } from './lib/tools.js'
import { compileTool } from './lib/define-tool.js'

export const inject = ['tools']

/**
 * Resolve the Harness `defineTool` helper when the deployment lets a profile
 * plugin import Harness packages; otherwise fall back to the shipped compiler
 * that produces the same definition shape (see lib/define-tool.js).
 * @returns {Promise<Function>} the tool compiler to use.
 */
async function resolveDefineTool() {
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    if (typeof module.defineTool === 'function') return module.defineTool
  } catch {
    // Profile plugins loaded from outside the DSH installation may not resolve
    // Harness packages; the local compiler is contract-equivalent.
  }
  return compileTool
}

/**
 * Register every mindmap tool option object through the Harness tool compiler.
 * Registration is not wrapped in ctx.effect: the tool registry owns its lifecycle.
 * @param {{ tools: { register(definition: object): unknown } }} ctx host plugin context.
 */
export async function apply(ctx) {
  const defineTool = await resolveDefineTool()
  for (const options of createToolDefinitions({})) ctx.tools.register(defineTool(options))
}
