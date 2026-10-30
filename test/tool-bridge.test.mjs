import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolDefinition } from '../lib/tool-bridge.js'

const SETTINGS = { toolCallTimeoutMs: 1_000 }

/** Minimal raw MCP tool with the BaseMind 0.29.3 `code` shape. */
function rawTool(overrides = {}) {
  return {
    name: 'code',
    description: 'Code intelligence.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['outline', 'symbols'] },
        path: { type: ['string', 'null'], default: null, format: 'uri-reference' },
      },
    },
    ...overrides,
  }
}

/** A pool whose single session is scripted by the test. */
function fakePool(session) {
  const calls = []
  return {
    calls,
    async clientFor(root, signal) {
      calls.push({ root, signal })
      return session
    },
  }
}

/** An Agent-shaped object; tool-bridge only passes it through. */
const AGENT = { id: 'agent-1' }

/** A ctx whose only jobs are workingDirectory.ensure and optional agents lookup. */
function fakeContext({ root = 'D:\\repo', initiator } = {}) {
  const ensured = []
  return {
    ensured,
    get(key) {
      if (key === 'agents' && initiator !== undefined) return { currentInitiator: () => initiator }
      return undefined
    },
    workingDirectory: {
      async ensure(agent, signal) {
        ensured.push({ agent, signal })
        return root
      },
    },
  }
}

/** A session whose callTool result is scripted. */
function fakeSession({ result, error, has = true } = {}) {
  const calls = []
  return {
    calls,
    hasTool: () => has,
    async callTool(rawName, args, options) {
      calls.push({ rawName, args, options })
      if (error !== undefined) throw error
      return result
    },
  }
}

test('a discovered tool becomes an mcp__<server>__<tool> definition', () => {
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(fakeSession()),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  assert.equal(definition.name, 'mcp__basemind__code')
  assert.equal(definition.description, 'Code intelligence.')
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.properties.mode.enum, ['outline', 'symbols'])
  assert.equal(definition.parameters.properties.path.type, 'string')
  assert.deepEqual(definition.parameters.required, ['mode'])
  assert.equal(JSON.stringify(definition.parameters).includes('format'), false)
  assert.equal(definition.timeoutMs, 6_000)
  assert.equal(definition.isConcurrencySafe(), false)
})

test('a tool without a description gets a generated one', () => {
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool({ description: '   ' }),
    pool: fakePool(fakeSession()),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  assert.equal(definition.description, 'basemind code')
})

test('unusable or unnamed tool entries are rejected', () => {
  for (const bad of [null, [], 'code', { name: '' }, { name: 7 }]) {
    assert.throws(
      () => createToolDefinition({ serverName: 'basemind', rawTool: bad, pool: fakePool({}), ctx: fakeContext(), config: SETTINGS }),
      /BaseMind tool/,
    )
  }
})

test('a hostile input schema degrades to an unconstrained object parameter schema', () => {
  const warnings = []
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool({ inputSchema: { type: 'object', properties: { weird: { anyOf: [{ type: 'string' }, { type: 'number' }] } } } }),
    pool: fakePool(fakeSession()),
    ctx: fakeContext(),
    config: SETTINGS,
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  assert.equal(definition.parameters.type, 'object')
  assert.equal(Array.isArray(definition.parameters.properties.weird.oneOf), true)
})

test('output.render projects text and diagnostics, never a raw image block', () => {
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(fakeSession()),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  const blocks = definition.output.render(
    {},
    {
      text: 'hello',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
      isError: false,
    },
  )
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, 'hello')
  assert.equal(blocks.some((block) => block.type === 'image'), false)
  assert.equal(JSON.stringify(blocks).includes('aGVsbG8='), false)
})

test('execute resolves the workspace root from the calling agent at call time', async () => {
  const session = fakeSession({ result: { content: [{ type: 'text', text: 'outline ok' }], isError: false } })
  const pool = fakePool(session)
  const ctx = fakeContext({ root: 'D:\\repo-a' })
  const definition = createToolDefinition({ serverName: 'basemind', rawTool: rawTool(), pool, ctx, config: SETTINGS })
  const controller = new AbortController()
  const value = await definition.execute({ mode: 'outline', path: 'src/x.ts' }, { agent: AGENT, signal: controller.signal })

  assert.equal(ctx.ensured.length, 1)
  assert.equal(ctx.ensured[0].agent, AGENT)
  assert.equal(pool.calls[0].root, 'D:\\repo-a')
  assert.equal(session.calls[0].rawName, 'code')
  assert.deepEqual(session.calls[0].args, { mode: 'outline', path: 'src/x.ts' })
  assert.equal(session.calls[0].options.timeoutMs, 1_000)
  assert.deepEqual(value, {
    text: 'outline ok',
    content: [{ type: 'text', text: 'outline ok' }],
    isError: false,
  })
})

test('execute falls back to the initiator agent when the execution context has none', async () => {
  const session = fakeSession({ result: { content: [{ type: 'text', text: 'x' }] } })
  const ctx = fakeContext({ root: 'D:\\repo-b', initiator: AGENT })
  const definition = createToolDefinition({ serverName: 'basemind', rawTool: rawTool(), pool: fakePool(session), ctx, config: SETTINGS })
  await definition.execute({ mode: 'symbols' }, { signal: new AbortController().signal })
  assert.equal(ctx.ensured[0].agent, AGENT)
})

test('execute fails closed when no agent can be resolved', async () => {
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(fakeSession()),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  await assert.rejects(() => definition.execute({ mode: 'outline' }, { signal: new AbortController().signal }), /needs a live Agent/)
})

test('execute rejects non-object arguments', async () => {
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(fakeSession()),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  await assert.rejects(
    () => definition.execute(['mode'], { agent: AGENT, signal: new AbortController().signal }),
    /requires a JSON object/,
  )
})

test('execute treats missing arguments as an empty object', async () => {
  const session = fakeSession({ result: { content: [{ type: 'text', text: 'ok' }] } })
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(session),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  await definition.execute(undefined, { agent: AGENT, signal: new AbortController().signal })
  assert.deepEqual(session.calls[0].args, {})
})

test('execute rejects immediately when the call is already aborted', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled by test'))
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(fakeSession()),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  await assert.rejects(
    () => definition.execute({ mode: 'outline' }, { agent: AGENT, signal: controller.signal }),
    /cancelled by test/,
  )
})

test('execute reports a tool the running BaseMind does not expose', async () => {
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(fakeSession({ has: false })),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  await assert.rejects(
    () => definition.execute({ mode: 'outline' }, { agent: AGENT, signal: new AbortController().signal }),
    /is not exposed/,
  )
})

test('execute turns an isError result into a tool error carrying the text', async () => {
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(fakeSession({ result: { content: [{ type: 'text', text: 'no such file' }], isError: true } })),
    ctx: fakeContext(),
    config: SETTINGS,
  })
  await assert.rejects(
    () => definition.execute({ mode: 'outline' }, { agent: AGENT, signal: new AbortController().signal }),
    /no such file/,
  )
})

test('execute wraps transport failures with the tool name and workspace root', async () => {
  const definition = createToolDefinition({
    serverName: 'basemind',
    rawTool: rawTool(),
    pool: fakePool(fakeSession({ error: new Error('relay exited (7)') })),
    ctx: fakeContext({ root: 'D:\\repo-c' }),
    config: SETTINGS,
  })
  await assert.rejects(
    () => definition.execute({ mode: 'outline' }, { agent: AGENT, signal: new AbortController().signal }),
    (error) => {
      assert.match(error.message, /code/)
      assert.equal(error.message.includes('D:\\repo-c'), true)
      assert.match(error.message, /relay exited \(7\)/)
      return true
    },
  )
})
