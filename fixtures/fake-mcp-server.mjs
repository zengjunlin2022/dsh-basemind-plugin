#!/usr/bin/env node
/**
 * Minimal MCP stdio server used by the plugin's own tests.
 *
 * It answers newline-delimited JSON-RPC 2.0 on stdin/stdout and mimics the parts
 * of BaseMind the bridge depends on: initialize, tools/list (paginated on demand),
 * tools/call, resources/*, `notifications/tools/list_changed`, and a crash mode.
 * Behaviour is driven by the `tools/call` arguments so a test can mutate the
 * advertised tool set on a live connection.
 *
 * Environment:
 *   FAKE_MCP_REJECT_VERSIONS  comma-separated protocol versions answered with -32602
 *   FAKE_MCP_PAGE_TOKENS      when set, tools/list returns two pages
 *   FAKE_MCP_IGNORE_STDIN_CLOSE when set, the server keeps running after stdin
 *                             ends (BaseMind's real behaviour; proves teardown
 *                             must terminate the child)
 *
 * Do not import this file: it is a subprocess fixture.
 */
import { createInterface } from 'node:readline'

const rejectVersions = new Set(
  (process.env.FAKE_MCP_REJECT_VERSIONS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== ''),
)
const paginate = (process.env.FAKE_MCP_PAGE_TOKENS ?? '') !== ''

const profile = (process.env.FAKE_MCP_PROFILE ?? '').trim()

/** Tools the 0.29-era profile advertises (mode dispatch). */
const legacyTools = [
  {
    name: 'code',
    description: 'Fake code intelligence tool.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['outline', 'symbols'] },
        path: { type: ['string', 'null'], default: null },
      },
    },
  },
  {
    name: 'admin',
    description: 'Fake admin tool.',
    inputSchema: {
      type: 'object',
      required: ['mode'],
      properties: { mode: { type: 'string' } },
    },
  },
]

/**
 * Tools the 0.34.0 profile advertises: verb tools, no `mode` dispatch and no
 * retired name. Shapes follow the real 0.34.0 `tools/list` capture.
 */
const verbTools = [
  {
    name: 'code_outline',
    title: 'Outline a file',
    description: 'Use to list the symbols in one file.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  },
  {
    name: 'code_grep',
    title: 'Search code',
    description: 'Use to grep the indexed code.',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: { pattern: { type: 'string' }, regex: { type: 'boolean' } },
    },
  },
  {
    name: 'code_read',
    title: 'Read code',
    description: 'Use to read a symbol or a line range from one file.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        symbol: { type: 'string' },
        line: { type: 'integer' },
        end_line: { type: 'integer' },
      },
    },
  },
  {
    name: 'find_files',
    title: 'Find files',
    description: 'Use to locate files by name.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'index_status',
    title: 'Index status',
    description: 'Use to read the index status of the workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
]

/** Live advertised tool list; `admin` can append to it on request. */
let tools = [...(profile === '0.34' ? verbTools : legacyTools)]

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

const toolListResult = (cursor) => {
  if (!paginate) return { tools }
  if (cursor === undefined || cursor === '') return { tools: tools.slice(0, 1), nextCursor: 'page-2' }
  if (cursor === 'page-2') return { tools: tools.slice(1) }
  return { tools: [] }
}

/**
 * Answer the verb-tool profile the way BaseMind 0.34.0 does: line-oriented or
 * TOON text plus `structuredContent`, and a fixable problem as an `isError`
 * result carrying `{ error, retryable }`.
 */
const handleVerbCall = (id, name, args) => {
  switch (name) {
    case 'code_grep':
      reply(id, {
        content: [{ type: 'text', text: '# src/math.js\n## add\n1: function add(a, b)' }],
        // Real 0.34.0 groups hits by path and then by symbol: { "<path>": { "<symbol>": ["<line>: <text>"] } }.
        structuredContent: { hits: { 'src/math.js': { add: ['1: function add(a, b)'] } } },
      })
      return
    case 'code_outline':
      reply(id, {
        content: [{ type: 'text', text: `path: ${String(args.path)}\nsymbols[1]{name,kind}:\n  add,function` }],
        structuredContent: { path: args.path, symbols: [{ name: 'add', kind: 'function' }] },
      })
      return
    case 'code_read':
      if (typeof args.symbol !== 'string' && typeof args.line !== 'number') {
        reply(id, {
          content: [{ type: 'text', text: '`code_read`: neither `symbol` nor `line` was given' }],
          structuredContent: { error: 'invalid_argument', retryable: false },
          isError: true,
        })
        return
      }
      reply(id, {
        content: [{ type: 'text', text: 'function add(a, b) {}' }],
        structuredContent: { path: args.path },
      })
      return
    case 'find_files':
      reply(id, {
        content: [{ type: 'text', text: 'files[1]: src/math.js' }],
        structuredContent: { files: ['src/math.js'] },
      })
      return
    case 'index_status':
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ root: process.cwd(), schema_version: 34 }) }],
        structuredContent: { root: process.cwd(), schema_version: 34 },
      })
      return
    default:
      fail(id, -32602, `unknown tool: ${String(name)}`)
  }
}

const handleCall = (id, params) => {
  const name = params?.name
  const args = params?.arguments ?? {}
  if (profile === '0.34') {
    handleVerbCall(id, name, args)
    return
  }
  if (name === 'code') {
    if (args.mode === 'fail') {
      reply(id, { content: [{ type: 'text', text: 'boom from fake BaseMind' }], isError: true })
      return
    }
    reply(id, {
      content: [
        { type: 'text', text: `code:${String(args.mode)}:${String(args.path ?? '')}` },
        { type: 'resource_link', name: 'status', uri: 'fake://status' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
      structuredContent: { mode: args.mode },
    })
    return
  }
  if (name === 'admin') {
    switch (args.mode) {
      case 'status':
        reply(id, { content: [{ type: 'text', text: JSON.stringify({ root: process.cwd() }) }] })
        return
      case 'add-tool':
        if (!tools.some((tool) => tool.name === 'extra')) {
          tools = [
            ...tools,
            {
              name: 'extra',
              description: 'Fake tool added at runtime.',
              inputSchema: { type: 'object', properties: {} },
            },
          ]
        }
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
        reply(id, { content: [{ type: 'text', text: 'added' }] })
        return
      case 'crash':
        process.exit(7)
        return
      case 'delay':
        setTimeout(() => {
          reply(id, { content: [{ type: 'text', text: 'late' }] })
        }, Number(args.ms ?? 10))
        return
      case 'bad-payload':
        reply(id, {
          content: [
            { type: 'audio', mimeType: 'audio/wav', data: 'aGVsbG8=' },
            { type: 'resource', resource: { uri: 'fake://embedded', text: 'x' } },
            { type: 'mystery' },
            'not-an-object',
          ],
        })
        return
      default:
        reply(id, { content: [{ type: 'text', text: 'unknown admin mode' }], isError: true })
    }
    return
  }
  fail(id, -32602, `unknown tool: ${String(name)}`)
}

const handle = (message) => {
  const { id, method, params } = message
  if (typeof method !== 'string') {
    if (id !== undefined) fail(id, -32600, 'missing method')
    return
  }
  if (id === undefined) {
    // Notification: `notifications/initialized` and friends need no answer.
    return
  }
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      if (rejectVersions.has(requested)) {
        fail(id, -32602, `unsupported protocol version ${String(requested)}`)
        return
      }
      reply(id, {
        protocolVersion: requested ?? '2025-06-18',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'fake-basemind', version: '0.0.0-fake' },
        instructions: 'FAKE BASEMIND INSTRUCTIONS: prefer the fake code tool.',
      })
      return
    }
    case 'tools/list':
      reply(id, toolListResult(params?.cursor))
      return
    case 'tools/call':
      handleCall(id, params)
      return
    case 'resources/list':
      reply(id, { resources: [{ uri: 'fake://status', name: 'status' }] })
      return
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] })
      return
    case 'resources/read':
      reply(id, { contents: [{ uri: params?.uri, text: JSON.stringify({ ok: true, uri: params?.uri }) }] })
      return
    case 'ping':
      reply(id, {})
      return
    default:
      fail(id, -32601, `method not found: ${method}`)
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    send({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } })
    return
  }
  try {
    handle(message)
  } catch (error) {
    if (message.id !== undefined) fail(message.id, -32603, error instanceof Error ? error.message : String(error))
  }
})
lines.on('close', () => {
  if ((process.env.FAKE_MCP_IGNORE_STDIN_CLOSE ?? '') !== '') return
  process.exit(0)
})
