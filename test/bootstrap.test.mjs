import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bootstrapText,
  registerBootstrapSection,
  sectionNameFor,
} from '../lib/prompt/bootstrap.js'

const SAMPLE = {
  ready: true,
  serverName: 'basemind',
  version: '0.34.0',
  source: 'path',
  cliToolName: 'mcp__basemind__cli',
}

/** A systemPrompt double that records sections and can fail registration. */
function fakePrompt(options) {
  const opts = options ?? {}
  const sections = new Map()
  const prompt = {
    sections,
    getSectionOrder(key) {
      if (key !== 'MCP_SERVERS') return undefined
      return opts.order === undefined ? 3100 : opts.order
    },
    section(spec) {
      if (opts.fail === true) throw new Error('systemPrompt unavailable')
      sections.set(spec.name, spec)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        sections.delete(spec.name)
      }
    },
  }
  return prompt
}

test('no bootstrap text is produced until the binary is ready', () => {
  assert.equal(bootstrapText(), '')
  assert.equal(bootstrapText({}), '')
  assert.equal(bootstrapText({ ready: false, serverName: 'basemind', version: '0.34.0' }), '')
})

test('the ready text carries the server, version, source and CLI tool name', () => {
  const text = bootstrapText(SAMPLE)
  assert.ok(text.includes('workspace-aware MCP server "basemind"'))
  assert.ok(text.includes('BaseMind 0.34.0'))
  assert.ok(text.includes('binary source: path'))
  assert.ok(text.includes('mcp__basemind__cli'))
  assert.ok(text.includes("Use the tools' own instructions first"))
  assert.ok(text.includes('Do not invoke a bare'))
  assert.ok(text.includes('PATH'))
  assert.ok(text.includes('read/grep/glob/bash'))
  assert.ok(text.includes('index_unavailable'))
  assert.ok(text.includes('workspace this session is working in'))
  assert.ok(text.includes('skill tool'))
  assert.ok(text.includes('upgrade --plan'))
})

test('the text is short, deterministic and free of instructions fragments and paths', () => {
  const first = bootstrapText(SAMPLE)
  const second = bootstrapText(SAMPLE)
  assert.equal(first, second)
  assert.ok(Buffer.byteLength(first, 'utf8') <= 1600)
  assert.equal(first.includes('code_outline {'), false)
  assert.equal(first.includes('code_outline'), false)
  assert.equal(first.includes('"path":'), false)
  assert.equal(first.includes(String.fromCharCode(92)), false)
  assert.equal(first.includes('/home/'), false)
  assert.equal(first.includes('/usr/'), false)
  assert.equal(first.includes(process.cwd()), false)
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(first), false)
})

test('the CLI tool name defaults from the server name and missing fields say unknown', () => {
  const text = bootstrapText({ ready: true, serverName: 'mind' })
  assert.ok(text.includes('server "mind"'))
  assert.ok(text.includes('mcp__mind__cli'))
  assert.ok(text.includes('BaseMind unknown'))
  assert.ok(text.includes('binary source: unknown'))
})

test('sectionNameFor names a distinct bootstrap section', () => {
  assert.equal(sectionNameFor('basemind'), 'mcp:basemind:bootstrap')
  assert.equal(sectionNameFor('mind'), 'mcp:mind:bootstrap')
  assert.equal(sectionNameFor(undefined), 'mcp:basemind:bootstrap')
  assert.notEqual(sectionNameFor('basemind'), 'mcp:basemind')
})

test('registration uses the MCP_SERVERS order plus ten and interpolates nothing', () => {
  const prompt = fakePrompt({ order: 3100 })
  const ctx = { systemPrompt: prompt }
  const dispose = registerBootstrapSection(ctx, {
    serverName: 'basemind',
    getText: () => bootstrapText(SAMPLE),
  })
  assert.equal(typeof dispose, 'function')

  const spec = prompt.sections.get('mcp:basemind:bootstrap')
  assert.ok(spec !== undefined)
  assert.equal(spec.order, 3110)
  assert.equal(spec.interpolate, false)
  assert.equal(typeof spec.text, 'function')
  assert.equal(spec.text(), bootstrapText(SAMPLE))

  dispose()
  assert.equal(prompt.sections.size, 0)
})

test('an explicit order wins over the MCP_SERVERS fallback', () => {
  const prompt = fakePrompt({ order: 3100 })
  registerBootstrapSection({ systemPrompt: prompt }, {
    serverName: 'basemind',
    order: 42,
    getText: () => 'text',
  })
  assert.equal(prompt.sections.get('mcp:basemind:bootstrap').order, 42)

  const fallback = fakePrompt()
  delete fallback.getSectionOrder
  registerBootstrapSection({ systemPrompt: fallback }, {
    serverName: 'basemind',
    getText: () => 'text',
  })
  assert.equal(fallback.sections.get('mcp:basemind:bootstrap').order, 3110)
})

test('the section reads getText on every call and never duplicates itself', () => {
  const prompt = fakePrompt()
  let text = ''
  registerBootstrapSection({ systemPrompt: prompt }, {
    serverName: 'basemind',
    getText: () => text,
  })
  const spec = prompt.sections.get('mcp:basemind:bootstrap')
  assert.equal(spec.text(), '')
  text = bootstrapText(SAMPLE)
  for (let index = 0; index < 5; index += 1) assert.equal(spec.text(), text)
  assert.equal(prompt.sections.size, 1)
})

test('a throwing getText degrades to empty text with one warning', () => {
  const prompt = fakePrompt()
  const warnings = []
  registerBootstrapSection({ systemPrompt: prompt }, {
    serverName: 'basemind',
    getText: () => {
      throw new Error('readiness exploded')
    },
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  const spec = prompt.sections.get('mcp:basemind:bootstrap')
  assert.equal(spec.text(), '')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('bootstrap text failed'))
})

test('a missing or failing systemPrompt service never breaks the caller', () => {
  const warnings = []
  const logger = { warn: (message) => warnings.push(String(message)) }
  assert.equal(typeof registerBootstrapSection(undefined, { serverName: 'basemind' }), 'function')
  assert.equal(typeof registerBootstrapSection({}, {}), 'function')

  const failing = fakePrompt({ fail: true })
  const dispose = registerBootstrapSection({ systemPrompt: failing }, {
    serverName: 'basemind',
    getText: () => 'text',
    logger,
  })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('is unavailable'))
})
