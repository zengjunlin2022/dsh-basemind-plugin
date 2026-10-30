import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULTS, resolveConfig } from '../lib/config.js'

/** Collect warnings so assertions can check that a correction was reported once. */
function recorder() {
  const warnings = []
  return { warnings, logger: { warn: (message) => warnings.push(String(message)) } }
}

test('an empty config resolves to the documented defaults', () => {
  const settings = resolveConfig({})
  assert.equal(settings.serverName, 'basemind')
  assert.equal(settings.command, 'basemind')
  assert.deepEqual(settings.args, ['serve'])
  assert.deepEqual(settings.env, {})
  assert.equal(settings.toolCallTimeoutMs, 120_000)
  assert.equal(settings.startupTimeoutMs, 60_000)
  assert.equal(settings.maxClients, 32)
  assert.equal(settings.autoProvision, false)
  assert.equal(settings.npxSpec, 'basemind@latest')
  assert.equal(settings.failOnStartupError, false)
  assert.equal(settings.logStderr, true)
})

test('missing, null and array configs fall back to defaults without throwing', () => {
  for (const raw of [undefined, null, [], 'nonsense', 42]) {
    const settings = resolveConfig(raw)
    assert.equal(settings.serverName, DEFAULTS.serverName)
    assert.deepEqual(settings.args, ['serve'])
  }
})

test('the resolved settings object is frozen', () => {
  const settings = resolveConfig({})
  assert.equal(Object.isFrozen(settings), true)
  assert.equal(Object.isFrozen(settings.args), true)
  assert.equal(Object.isFrozen(settings.env), true)
})

test('an invalid serverName warns once and falls back to basemind', () => {
  const { warnings, logger } = recorder()
  const settings = resolveConfig({ serverName: 'bad name!' }, { logger })
  assert.equal(settings.serverName, 'basemind')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /serverName/)
})

test('a valid serverName is preserved verbatim', () => {
  assert.equal(resolveConfig({ serverName: 'basemind-repo_2' }).serverName, 'basemind-repo_2')
})

test('args keep only strings and default when not an array', () => {
  assert.deepEqual(resolveConfig({ args: ['serve', '--verbose', 7, null] }).args, ['serve', '--verbose'])
  assert.deepEqual(resolveConfig({ args: 'serve' }).args, ['serve'])
})

test('a configured --root in args is preserved here and stripped later by resolveLaunch', () => {
  assert.deepEqual(resolveConfig({ args: ['serve', '--root', '/tmp/x'] }).args, ['serve', '--root', '/tmp/x'])
})

test('env keeps string values only and merges into a fresh object', () => {
  const settings = resolveConfig({ env: { BASEMIND_LOG: 'debug', PORT: 7 } })
  assert.deepEqual(settings.env, { BASEMIND_LOG: 'debug' })
  assert.deepEqual(resolveConfig({ env: 'x' }).env, {})
})

test('timeouts and maxClients are clamped into their supported ranges', () => {
  assert.equal(resolveConfig({ toolCallTimeoutMs: 10 }).toolCallTimeoutMs, 1_000)
  assert.equal(resolveConfig({ toolCallTimeoutMs: 9_999_999 }).toolCallTimeoutMs, 3_600_000)
  assert.equal(resolveConfig({ toolCallTimeoutMs: '5000' }).toolCallTimeoutMs, 5_000)
  assert.equal(resolveConfig({ startupTimeoutMs: 1 }).startupTimeoutMs, 1_000)
  assert.equal(resolveConfig({ startupTimeoutMs: 10_000_000 }).startupTimeoutMs, 600_000)
  assert.equal(resolveConfig({ maxClients: 0 }).maxClients, 1)
  assert.equal(resolveConfig({ maxClients: 999 }).maxClients, 256)
})

test('a non-numeric timeout warns and keeps the default', () => {
  const { warnings, logger } = recorder()
  const settings = resolveConfig({ toolCallTimeoutMs: 'soon' }, { logger })
  assert.equal(settings.toolCallTimeoutMs, DEFAULTS.toolCallTimeoutMs)
  assert.equal(warnings.length, 1)
})

test('booleans accept real booleans and the strings true/false', () => {
  assert.equal(resolveConfig({ autoProvision: true }).autoProvision, true)
  assert.equal(resolveConfig({ autoProvision: 'true' }).autoProvision, true)
  assert.equal(resolveConfig({ logStderr: 'false' }).logStderr, false)
  assert.equal(resolveConfig({ failOnStartupError: 'false' }).failOnStartupError, false)
})

test('an invalid boolean warns and keeps the default', () => {
  const { warnings, logger } = recorder()
  const settings = resolveConfig({ autoProvision: 3 }, { logger })
  assert.equal(settings.autoProvision, DEFAULTS.autoProvision)
  assert.equal(warnings.length, 1)
})

test('empty strings for command and npxSpec fall back to defaults', () => {
  assert.equal(resolveConfig({ command: '   ' }).command, 'basemind')
  assert.equal(resolveConfig({ npxSpec: '' }).npxSpec, 'basemind@latest')
})

test('a custom command and npxSpec survive validation', () => {
  const settings = resolveConfig({ command: 'C:\\Tools\\basemind.exe', npxSpec: 'basemind@0.31.0' })
  assert.equal(settings.command, 'C:\\Tools\\basemind.exe')
  assert.equal(settings.npxSpec, 'basemind@0.31.0')
})

test('discoveryRoot defaults to agent and keeps every known strategy', () => {
  assert.equal(resolveConfig({}).discoveryRoot, 'agent')
  for (const mode of ['agent', 'agent-first', 'default']) {
    assert.equal(resolveConfig({ discoveryRoot: mode }).discoveryRoot, mode)
  }
})

test('an unknown discoveryRoot warns once and falls back to agent', () => {
  const { warnings, logger } = recorder()
  const settings = resolveConfig({ discoveryRoot: 'launch-directory' }, { logger })
  assert.equal(settings.discoveryRoot, 'agent')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /discoveryRoot/)
})
