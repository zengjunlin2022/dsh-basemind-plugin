import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply, name, inject } from '../index.js'

// The binary manager writes state.json under $DSH_HOME; a unit test must never
// touch the real one. Own the directory for this test process.
const TEST_DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-basemind-home-'))
process.env.DSH_HOME = TEST_DSH_HOME
after(() => {
  fs.rmSync(TEST_DSH_HOME, { recursive: true, force: true })
})

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, '..', 'fixtures')
const FAKE_SERVER = path.join(FIXTURES, 'fake-mcp-server.mjs')
const FAKE_BASEMIND = path.join(FIXTURES, process.platform === 'win32' ? 'fake-basemind.cmd' : 'fake-basemind.sh')

/**
 * Path to the fake BaseMind launcher that actually runs here: Windows uses the
 * .cmd wrapper, POSIX copies the shell launcher to a temp dir and marks it
 * executable (the repository does not carry an exec bit).
 * @returns {string}
 */
let fakeBasemindPath
function fakeBasemind() {
  if (process.platform === 'win32') return FAKE_BASEMIND
  if (fakeBasemindPath !== undefined) return fakeBasemindPath
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-basemind-'))
  const copy = path.join(directory, 'fake-basemind.sh')
  fs.copyFileSync(FAKE_BASEMIND, copy)
  fs.chmodSync(copy, 0o755)
  fakeBasemindPath = copy
  return copy
}
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
  const outChunks = []
  const errChunks = []
  child.stdout?.on?.('data', (chunk) => outChunks.push(Buffer.from(chunk)))
  child.stderr?.on?.('data', (chunk) => errChunks.push(Buffer.from(chunk)))
  const collected = {
    stdout: {
      readFrom() {
        return { text: Buffer.concat(outChunks).toString('utf8'), lossy: false, spillPath: undefined }
      },
    },
    stderr: {
      readFrom() {
        return { text: Buffer.concat(errChunks).toString('utf8'), lossy: false, spillPath: undefined }
      },
    },
  }
  const done = new Promise((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal: signal ?? null }))
    child.once('error', () => resolve({ exitCode: null, signal: null }))
  })
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected,
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
  const commands = new Map()
  const skillProviders = new Set()
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
    commands: {
      register(definition) {
        if (commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
      get(name) {
        return commands.get(name)
      },
      keys() {
        return [...commands.keys()]
      },
    },
    skills: {
      registerProvider(factory) {
        const control = { invalidations: 0, invalidate() { control.invalidations += 1 } }
        const provider = factory(control)
        skillProviders.add(provider)
        return () => skillProviders.delete(provider)
      },
    },
    skillProviders,
    get(key) {
      if (key === 'mcpResources') return ctx.mcpResources
      if (key === 'commands') return ctx.commands
      if (key === 'skills') return ctx.skills
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
    // Unit tests never touch the network or the user's managed cache: the
    // scripted MCP server is an "any" binary, and downloading is off.
    binaryPolicy: 'any',
    binaryDownload: false,
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
  apply(ctx, { command: process.execPath, args: [FAKE_SERVER], binaryPolicy: 'any', binaryDownload: false })

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

test('a 0.34 profile registers the verb tools and none of the retired names', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings({ env: { FAKE_MCP_PROFILE: '0.34' } }))
  await waitFor(() => ctx.tools.get('mcp__basemind__code_grep') !== undefined, { label: 'the verb tools' })

  for (const name of ['code_outline', 'code_grep', 'code_read', 'find_files', 'index_status']) {
    assert.ok(ctx.tools.get(`mcp__basemind__${name}`), `${name} is registered`)
  }
  for (const retired of ['code', 'git', 'memory', 'admin', 'graph', 'web', 'shell', 'workspace', 'agents']) {
    assert.equal(ctx.tools.get(`mcp__basemind__${retired}`), undefined, `${retired} must not be registered`)
  }
})

test('a 0.34 call keeps structuredContent in the tool envelope', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings({ env: { FAKE_MCP_PROFILE: '0.34' } }))
  await waitFor(() => ctx.tools.get('mcp__basemind__code_grep') !== undefined, { label: 'the verb tools' })

  const value = await call(ctx, 'mcp__basemind__code_grep', { pattern: 'add' })
  assert.match(value.text, /^# src\/math\.js/)
  assert.equal(value.isError, false)
  assert.deepEqual(value.structuredContent.hits, { 'src/math.js': { add: ['1: function add(a, b)'] } })
})

test('a 0.34 fixable error reaches the model with its code', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings({ env: { FAKE_MCP_PROFILE: '0.34' } }))
  await waitFor(() => ctx.tools.get('mcp__basemind__code_read') !== undefined, { label: 'the verb tools' })

  await assert.rejects(() => call(ctx, 'mcp__basemind__code_read', { path: 'src/math.js' }), /invalid_argument/)
})


test('a verified binary registers the CLI tool, bootstrap text, official skills and /basemind-status', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings({ command: fakeBasemind(), args: ['serve'], binaryPolicy: 'exact' }))

  await waitFor(() => ctx.tools.get('mcp__basemind__cli') !== undefined, { label: 'the CLI tool' })
  assert.ok(ctx.tools.get('mcp__basemind__code'), 'the MCP tools are registered too')

  const bootstrap = ctx.sections.find((entry) => entry.name === 'mcp:basemind:bootstrap')
  assert.ok(bootstrap, 'the bootstrap section is registered')
  const text = bootstrap.text()
  assert.match(text, /mcp__basemind__cli/)
  assert.match(text, /0\.34\.0/)

  assert.equal(ctx.skillProviders.size, 1, 'the skills provider is registered')
  const provider = [...ctx.skillProviders][0]
  const listed = await provider.list()
  assert.equal(listed.length, 10, 'all ten official skills are listed')
  assert.equal(listed[0].rank, 1000)
  assert.equal(listed[0].provider, 'basemind')

  const command = ctx.commands.get('basemind-status')
  assert.ok(command, '/basemind-status is registered')
  const result = await command.handler()
  assert.equal(result.kind, 'success')
  assert.match(result.text, /0\.34\.0/)
  assert.match(result.text, /present/)
})

test('an unavailable binary registers nothing but keeps /basemind-status usable', async (t) => {
  const ctx = createFakeContext({ launchable: false })
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings({ command: 'basemind' }))

  await waitFor(() => ctx.warnings.some((message) => /startup failed/.test(message)), { label: 'the startup failure' })
  assert.equal(ctx.tools.schemas().length, 0)
  assert.equal(ctx.sections.length, 0)
  assert.equal(ctx.skillProviders.size, 0)

  const command = ctx.commands.get('basemind-status')
  assert.ok(command, '/basemind-status stays available when BaseMind is not')
  const result = await command.handler()
  assert.equal(result.kind, 'success')
  assert.match(result.text, /present/)
})

test('skills:false and cliTool:false remove those surfaces without touching the relay', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings({ command: fakeBasemind(), args: ['serve'], binaryPolicy: 'exact', skills: false, cliTool: false }))

  await waitFor(() => ctx.tools.get('mcp__basemind__code') !== undefined, { label: 'the MCP tools' })
  assert.equal(ctx.tools.get('mcp__basemind__cli'), undefined)
  assert.equal(ctx.skillProviders.size, 0)
  const bootstrap = ctx.sections.find((entry) => entry.name === 'mcp:basemind:bootstrap')
  assert.ok(bootstrap, 'bootstrap is independent of the CLI switch')
  assert.doesNotMatch(bootstrap.text(), /mcp__basemind__cli/)
  assert.doesNotMatch(bootstrap.text(), /long-form playbook/, 'skills:false must not advertise the basemind skill')
})

test('the CLI tool runs the same verified binary as the relay', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings({ command: fakeBasemind(), args: ['serve'], binaryPolicy: 'exact' }))
  await waitFor(() => ctx.tools.get('mcp__basemind__cli') !== undefined, { label: 'the CLI tool' })

  const result = await call(ctx, 'mcp__basemind__cli', { args: ['status'] })
  assert.equal(result.isError, false)
  assert.match(result.text, /fake-basemind status --root \./)
})

test('binaryPolicy any keeps the MCP bridge but exposes no CLI, skills or verified bootstrap', async (t) => {
  const ctx = createFakeContext()
  t.after(() => unload(ctx))
  apply(ctx, fakeSettings())
  await waitFor(() => ctx.tools.get('mcp__basemind__code') !== undefined, { label: 'the MCP tools' })

  assert.equal(ctx.tools.get('mcp__basemind__cli'), undefined)
  assert.equal(ctx.skillProviders.size, 0)
  const bootstrap = ctx.sections.find((entry) => entry.name === 'mcp:basemind:bootstrap')
  assert.ok(bootstrap)
  const text = bootstrap.text()
  assert.match(text, /unverified/)
  assert.doesNotMatch(text, /mcp__basemind__cli/)
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
