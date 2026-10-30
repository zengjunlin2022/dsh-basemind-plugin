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

const baseTools = [
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

/** Live advertised tool list; `admin` can append to it on request. */
let tools = [...baseTools]

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

const handleCall = (id, params) => {
  const name = params?.name
  const args = params?.arguments ?? {}
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
