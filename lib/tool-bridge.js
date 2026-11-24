/**
 * Map one discovered BaseMind MCP tool onto a DSH `ToolDefinition`.
 *
 * Every call resolves the workspace root from the calling Agent at call time, so
 * a `cd` inside a session routes the next call to that directory's relay. There
 * is no cached cwd: guessing one would risk reading or writing the wrong repo.
 *
 * @module dsh-basemind-plugin/lib/tool-bridge
 */
import { resultText, projectContent } from './result.js'
import { normalizeInputSchema, publicToolName, validateJsonSchemaNode } from './schema.js'

/** Result envelope shared by every bridged tool; `text` is what the model reads. */
const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    content: { type: 'array', items: { description: 'MCP content block.' } },
    isError: { type: 'boolean' },
    structuredContent: {
      description: 'MCP structuredContent for this result, when the server sends one.',
    },
  },
  required: ['text', 'content', 'isError'],
})

/** Degraded parameter schema used when a BaseMind schema cannot be represented. */
const UNCONSTRAINED_OBJECT = Object.freeze({ type: 'object', properties: {} })

/** @returns {boolean} whether a value is a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @returns {string} a short message for an unknown thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render the BaseMind failure code carried by `structuredContent`.
 *
 * 0.34.0 reports a fixable failure as an `isError` tool result whose
 * `structuredContent` is `{ error, retryable }`; the text stays the server's own
 * message, and the code is appended so the model can tell `busy` from
 * `invalid_argument`. Older servers send no `structuredContent`, so nothing is
 * appended and the message is the plain text.
 *
 * @param {unknown} structuredContent
 * @returns {string} a ` [error=<code>(, retryable)?]` suffix, or `''`.
 */
function errorCodeSuffix(structuredContent) {
  if (!isPlainObject(structuredContent)) return ''
  const code = typeof structuredContent.error === 'string' ? structuredContent.error : undefined
  if (code === undefined || code === '') return ''
  return ` [error=${code}${structuredContent.retryable === true ? ', retryable' : ''}]`
}

/**
 * Render the JSON-RPC error code of a transport failure, when one is present.
 *
 * `lib/stdio-client.js` keeps `error.code` for JSON-RPC errors, so a retired tool
 * (`-32602`) or an upgrade-window daemon (`-32003`) stays diagnosable.
 *
 * @param {unknown} error
 * @returns {string} a ` [jsonrpc=<code>]` suffix, or `''`.
 */
function jsonRpcCodeSuffix(error) {
  const code = isPlainObject(error) || error instanceof Error ? error.code : undefined
  return typeof code === 'number' ? ` [jsonrpc=${code}]` : ''
}

/**
 * Normalize a BaseMind input schema, degrading a single unusable tool instead of
 * failing the whole tool generation.
 */
function parameterSchema(serverName, rawTool, logger) {
  const normalized = normalizeInputSchema(rawTool.inputSchema)
  const validation = validateJsonSchemaNode(normalized)
  if (validation.ok) return normalized
  logger?.warn?.(
    `[dsh-basemind-plugin] schema for ${serverName}/${rawTool.name} is not representable (${validation.errors.slice(0, 3).join('; ')}); degrading to an unconstrained object`,
  )
  return { ...UNCONSTRAINED_OBJECT }
}

/**
 * Resolve the Agent whose working directory owns this call.
 * @returns the Agent, or `undefined` when neither the execution context nor the initiator chain has one.
 */
function resolveAgent(ctx, exec) {
  if (exec?.agent !== undefined && exec.agent !== null) return exec.agent
  try {
    return ctx.get?.('agents')?.currentInitiator?.()
  } catch {
    return undefined
  }
}

/**
 * Build the DSH tool definition for one BaseMind tool.
 * @param options - the owning server name, the raw MCP tool, the workspace pool,
 *   the plugin's cordis context, resolved settings and an optional logger.
 * @returns a complete `ToolDefinition` ready for `ctx.tools.register`.
 */
export function createToolDefinition({ serverName, rawTool, pool, ctx, config, logger }) {
  if (!isPlainObject(rawTool)) throw new Error('BaseMind tool entry must be an object')
  if (typeof rawTool.name !== 'string' || rawTool.name === '') {
    throw new Error('BaseMind tool entry has no usable name')
  }
  const rawName = rawTool.name
  const name = publicToolName(serverName, rawName)
  const description =
    typeof rawTool.description === 'string' && rawTool.description.trim() !== ''
      ? rawTool.description
      : `${serverName} ${rawName}`

  return {
    name,
    description,
    parameters: parameterSchema(serverName, rawTool, logger),
    output: {
      schema: RESULT_SCHEMA,
      render(_args, value) {
        return projectContent(value)
      },
    },
    // Declared only; the stdio client enforces its own per-request timer.
    timeoutMs: config.toolCallTimeoutMs + 5_000,
    // BaseMind tools include writes (memory put, scrape, shell, rescan) and the
    // installed version cannot be classified statically, so calls serialize.
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted === true) {
        throw exec.signal.reason instanceof Error ? exec.signal.reason : new Error('BaseMind call cancelled')
      }
      const parsed = args === undefined || args === null ? {} : args
      if (!isPlainObject(parsed)) {
        throw new Error(`BaseMind tool ${rawName} requires a JSON object argument`)
      }
      const agent = resolveAgent(ctx, exec)
      if (agent === undefined) {
        throw new Error(
          `BaseMind tool ${rawName} needs a live Agent to resolve its workspace; none was available for this call`,
        )
      }
      const root = await ctx.workingDirectory.ensure(agent, exec?.signal)
      const session = await pool.clientFor(root, exec?.signal)
      if (typeof session.hasTool === 'function' && !session.hasTool(rawName)) {
        throw new Error(
          `BaseMind tool ${rawName} is not exposed by the BaseMind version serving ${root}; call again after the relay restarts or upgrade BaseMind`,
        )
      }
      let result
      try {
        result = await session.callTool(rawName, parsed, {
          signal: exec?.signal,
          timeoutMs: config.toolCallTimeoutMs,
        })
      } catch (error) {
        throw new Error(
          `BaseMind tool ${rawName} failed in ${root}: ${describe(error)}${jsonRpcCodeSuffix(error)}`,
        )
      }
      if (result?.isError === true) {
        const text = resultText(result)
        const message = text === '' ? `BaseMind tool ${rawName} failed in ${root}` : text
        throw new Error(`${message}${errorCodeSuffix(result?.structuredContent)}`)
      }
      const value = {
        text: resultText(result),
        content: Array.isArray(result?.content) ? result.content : [],
        isError: false,
      }
      // Optional: older BaseMind versions never send structuredContent, and the
      // envelope must not gain an `undefined` key for them.
      if (result?.structuredContent !== undefined) value.structuredContent = result.structuredContent
      return value
    },
  }
}
