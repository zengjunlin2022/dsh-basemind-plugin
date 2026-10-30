import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply, name, inject } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, '..', 'fixtures')
const FAKE_SERVER = path.join(FIXTURES, 'fake-mcp-server.mjs')
const ROOT_A = path.resolve(here, '..')
const ROOT_B = FIXTURES

/** Poll until `predicate` is truthy or the deadline passes. */
async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Adapt a real node child process to the DSH `SubprocessHandle` shape. */
function adapt(child) {
  const done = new Promise((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal: signal ?? null }))
    child.once('error', () => resolve({ exitCode: null, signal: null }))
  })
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected: {},
    done,
    terminate() {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already exited.
      }
    },
    async waitForExit(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return true
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3_000)
        timer.unref?.()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve(true)
        })
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve(false)
        })
      })
    },
  }
}

/**
 * A cordis-shaped context with the DSH surfaces the plugin uses, backed by the
 * real subprocess API shape and a scripted MCP server process.
 */
function createFakeContext({ defaultDirectory = ROOT_A, launchable = true, failRoots = [], rejectRegistration = false } = {}) {
  const tools = new Map()
  const spawned = []
  const warnings = []
  const sections = []
  const providers = new Map()
  const listeners = new Map()
  const current = { directory: defaultDirectory }

  const ctx = {
    warnings,
    spawned,
    tools: {
      register(definition) {
        if (rejectRegistration) throw new Error(`fake registry rejected ${definition.name}`)
        if (tools.has(definition.name)) throw new Error(`duplicate tool name ${definition.name}`)
        tools.set(definition.name, definition)
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          if (tools.get(definition.name) === definition) tools.delete(definition.name)
        }
      },
      get(toolName) {
        return tools.get(toolName)
      },
      schemas() {
        return [...tools.values()]
      },
    },
    systemPrompt: {
      section(section) {
        if (sections.some((existing) => existing.name === section.name)) {
          throw new Error(`duplicate prompt section ${section.name}`)
        }
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      getSectionOrder(sectionName) {
        if (sectionName !== 'MCP_SERVERS') throw new Error(`unknown section ${sectionName}`)
        return 3_100
      },
    },
    workingDirectory: {
      defaultDirectory,
      async ensure() {
        return current.directory
      },
    },
    mcpResources: {
      register(server, provider) {
        if (providers.has(server)) throw new Error(`duplicate resource server ${server}`)
        providers.set(server, provider)
        return () => providers.delete(server)
      },
    },
    logger: {
      warn: (message) => warnings.push(String(message)),
      error: (message) => warnings.push(String(message)),
      debug: () => {},
      info: () => {},
    },
    get(key) {
      if (key === 'mcpResources') return ctx.mcpResources
      return undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const currentList = listeners.get(event) ?? []
        const index = currentList.indexOf(listener)
        if (index >= 0) currentList.splice(index, 1)
      }
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    effect(callback) {
      const cleanup = callback()
      ctx.cleanups.push(cleanup)
      return cleanup
    },
    cleanups: [],
    subprocess: {
      async resolveExecutable(command, env, signal) {
        signal?.throwIfAborted?.()
        if (!launchable) throw new Error(`fake subprocess: command ${String(command)} was not found on PATH`)
        if (typeof command === 'string' && /[\\/]/.test(command)) return command
        if (command === 'cmd.exe' || command === process.env.ComSpec) return command
        throw new Error(`fake subprocess: command ${String(command)} was not found on PATH`)
      },
      spawn(spec) {
        if (failRoots.some((root) => root.toLowerCase() === String(spec.cwd).toLowerCase())) {
          throw new Error(`fake subprocess: cannot start a relay in ${String(spec.cwd)}`)
        }
        // Honour the spec's stdio dispositions: the version probe spawns with
        // stdin 'ignore', and a piped stdin there would keep the child alive.
        const mode = (value) => (value === 'ignore' || value === 'inherit' ? value : 'pipe')
        const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          env: spec.env,
          stdio: [mode(spec.stdio?.stdin), mode(spec.stdio?.stdout), mode(spec.stdio?.stderr)],
          windowsHide: true,
        })
        const handle = adapt(child)
        spawned.push(handle)
        return handle
      },
    },
    sections,
    providers,
    setDirectory(directory) {
      current.directory = directory
    },
  }
  return ctx
}

/**
 * Row config that launches the scripted MCP server with the ambient node binary.
 * `agent-first` keeps the eager-discovery tests unchanged; the shipped default is
 * `agent`, which is covered by its own tests.
 */
function fakeSettings(extra = {}) {
  return {
    command: process.execPath,
    args: [FAKE_SERVER],
    discoveryRoot: 'agent-first',
    env: { FAKE_MCP_IGNORE_STDIN_CLOSE: '1', ...(extra.env ?? {}) },
    ...extra,
    ...(extra.env === undefined ? {} : { env: { FAKE_MCP_IGNORE_STDIN_CLOSE: '1', ...extra.env } }),
  }
}

/** Call one registered tool through its definition, the way the registry would. */
function call(ctx, toolName, args, { agent = { id: 'agent-1' } } = {}) {
  const definition = ctx.tools.get(toolName)
  assert.ok(definition, `tool ${toolName} is registered`)
  return definition.execute(args, { agent, signal: new AbortController().signal })
}

/** Unload every effect the plugin registered. */
async function unload(ctx) {
  for (const cleanup of [...ctx.cleanups].reverse()) {
    if (typeof cleanup === 'function') await cleanup()
  }
  ctx.cleanups.length = 0
}

test('the module exports the documented plugin entry', () => {
  assert.equal(name, 'dsh-basemind-plugin')
  assert.deepEqual(inject, ['tools', 'subprocess', 'workingDirectory', 'systemPrompt'])
})

test('registers discovered tools, the instructions section and the resource provider', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())

  await waitFor(() => ctx.tools.get('mcp__basemind__code') !== undefined, { label: 'tools to register' })
  assert.ok(ctx.tools.get('mcp__basemind__admin'))

  const section = ctx.sections.find((entry) => entry.name === 'mcp:basemind')
  assert.ok(section, 'the instructions section is registered')
  assert.equal(section.order, 3_100)
  assert.equal(section.interpolate, false)
  assert.match(section.text, /FAKE BASEMIND INSTRUCTIONS/)

  assert.ok(ctx.providers.has('basemind'), 'the resource provider is registered')
  const provider = ctx.providers.get('basemind')
  const listed = await provider.request(
    { method: 'resources/list' },
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
  )
  assert.equal(listed.resources[0].uri, 'fake://status')
  const read = await provider.request(
    { method: 'resources/read', uri: 'fake://status' },
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
  )
  assert.match(read.contents[0].text, /fake:\/\/status/)
})

test('routes each call to the relay of the calling workspace directory', async (t) => {
  const ctx = createFakeContext({ defaultDirectory: ROOT_A })
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())
  await waitFor(() => ctx.tools.get('mcp__basemind__admin') !== undefined, { label: 'tools to register' })

  const first = await call(ctx, 'mcp__basemind__admin', { mode: 'status' })
  assert.equal(JSON.parse(first.text).root, ROOT_A)

  ctx.setDirectory(ROOT_B)
  const second = await call(ctx, 'mcp__basemind__admin', { mode: 'status' })
  assert.equal(JSON.parse(second.text).root, ROOT_B)
})

test('re-registers the tool generation when BaseMind announces a tool list change', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())
  await waitFor(() => ctx.tools.get('mcp__basemind__admin') !== undefined, { label: 'tools to register' })

  await call(ctx, 'mcp__basemind__admin', { mode: 'add-tool' })
  await waitFor(() => ctx.tools.get('mcp__basemind__extra') !== undefined, { label: 'the new tool to register' })
  assert.ok(ctx.tools.get('mcp__basemind__code'), 'the other tools survive the re-sync')
})

test('stays inactive when another provider already registered the tool names', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  const foreign = { name: 'mcp__basemind__code', description: 'foreign', parameters: { type: 'object', properties: {} } }
  ctx.tools.register(foreign)

  apply(ctx, fakeSettings())
  await waitFor(() => ctx.warnings.some((message) => /already registered/.test(message)), {
    label: 'the collision warning',
  })
  assert.equal(ctx.tools.schemas().length, 1)
  assert.equal(ctx.tools.get('mcp__basemind__code'), foreign, 'the existing provider keeps its tool')
  assert.equal(ctx.sections.length, 0, 'nothing else is registered on a collision')
})

test('keeps the harness usable when BaseMind cannot be launched', async (t) => {
  const ctx = createFakeContext({ launchable: false })
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())

  await waitFor(() => ctx.warnings.some((message) => /startup failed/.test(message)), {
    label: 'the startup warning',
  })
  assert.equal(ctx.tools.schemas().length, 0)
  assert.equal(ctx.sections.length, 0)
  assert.equal(ctx.providers.size, 0)
})

test('an agent creation retries a failed startup immediately', async (t) => {
  const ctx = createFakeContext({ launchable: false })
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())
  await waitFor(() => ctx.warnings.some((message) => /startup failed/.test(message)), {
    label: 'the first failure',
  })
  const before = ctx.warnings.length
  ctx.emit('agent/created', { agent: { id: 'agent-2' } })
  await waitFor(() => ctx.warnings.length > before, { label: 'the retry attempt', timeoutMs: 5_000 })
  assert.match(ctx.warnings[ctx.warnings.length - 1], /startup failed/)
})

test('adopts an Agent working directory when the deployment default is not a usable root', async (t) => {
  // BaseMind refuses a root that is not a project, and the deployment fallback
  // directory is often not one; discovery must then follow a real session.
  const ctx = createFakeContext({ defaultDirectory: ROOT_B, failRoots: [ROOT_B] })
  ctx.setDirectory(ROOT_A)
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())
  await waitFor(() => ctx.warnings.some((message) => /startup failed/.test(message)), {
    label: 'the fallback-root failure',
  })
  assert.equal(ctx.tools.schemas().length, 0)

  ctx.emit('agent/created', { agent: { id: 'agent-3' } })
  await waitFor(() => ctx.tools.get('mcp__basemind__admin') !== undefined, { label: 'tools from the agent root' })

  const status = await call(ctx, 'mcp__basemind__admin', { mode: 'status' })
  assert.equal(JSON.parse(status.text).root, ROOT_A)
})

test('the shipped discoveryRoot default starts nothing before a session exists', async (t) => {
  // `dsh web` started from a checkout has the checkout as its deployment default
  // directory; the default mode must not index it before a session picks a root.
  const ctx = createFakeContext({ defaultDirectory: ROOT_A })
  t.after(() => unload(ctx))
  apply(ctx, { command: process.execPath, args: [FAKE_SERVER] })

  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(ctx.spawned.filter((handle) => handle.stdin !== null).length, 0, 'no relay was spawned')
  assert.equal(ctx.tools.schemas().length, 0)
  assert.equal(ctx.sections.length, 0)
  assert.equal(ctx.providers.size, 0)

  ctx.setDirectory(ROOT_A)
  ctx.emit('agent/created', { agent: { id: 'agent-4' } })
  await waitFor(() => ctx.tools.get('mcp__basemind__admin') !== undefined, { label: 'tools after the first session' })
  assert.ok(ctx.sections.length > 0)
  assert.ok(ctx.providers.has('basemind'))
})

test('discoveryRoot: default ignores Agent directories and stays on the deployment default', async (t) => {
  const ctx = createFakeContext({ defaultDirectory: ROOT_B, failRoots: [ROOT_B] })
  ctx.setDirectory(ROOT_A)
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings({ discoveryRoot: 'default' }))
  await waitFor(() => ctx.warnings.some((message) => /startup failed/.test(message)), {
    label: 'the deployment-default failure',
  })

  ctx.emit('agent/created', { agent: { id: 'agent-5' } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(ctx.tools.schemas().length, 0, 'the Agent directory is not a candidate in this mode')
  assert.equal(
    ctx.warnings.some((message) => message.includes(`startup failed for ${ROOT_A}:`)),
    false,
    'no attempt was made against the Agent working directory',
  )
})

test('a failed tool registration leaves no instructions section and no resource provider', async (t) => {
  const ctx = createFakeContext({ rejectRegistration: true })
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())
  await waitFor(() => ctx.warnings.some((message) => /tool registration failed/.test(message)), {
    label: 'the registration failure',
  })
  assert.equal(ctx.tools.schemas().length, 0)
  assert.equal(ctx.sections.length, 0, 'instructions are registered only after tools exist')
  assert.equal(ctx.providers.size, 0, 'the resource provider is registered only after tools exist')
})

test('unload removes every registration and terminates the spawned relays', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())
  await waitFor(() => ctx.tools.get('mcp__basemind__code') !== undefined, { label: 'tools to register' })
  assert.ok(ctx.spawned.length >= 1, 'the relay was spawned')

  await unload(ctx)
  assert.equal(ctx.tools.schemas().length, 0)
  assert.equal(ctx.sections.length, 0)
  assert.equal(ctx.providers.size, 0)
  for (const handle of ctx.spawned) {
    assert.equal(await handle.waitForExit(AbortSignal.timeout(5_000)), true, 'the relay exited')
  }
})

test('failOnStartupError surfaces an unresolvable launcher from apply', async () => {
  const ctx = createFakeContext({ launchable: false })
  ctx.effect = (callback) => callback()
  ctx.cleanups = []
  await assert.rejects(
    async () => apply(ctx, fakeSettings({ failOnStartupError: true })),
    /was not found on PATH/,
  )
  await unload(ctx)
})
