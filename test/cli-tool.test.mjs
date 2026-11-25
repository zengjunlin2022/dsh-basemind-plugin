import assert from 'node:assert/strict'
import test from 'node:test'

import { createCliTool } from '../lib/cli-tool.js'

const EXE = 'C:/Tools/basemind/basemind.exe'
const SETTINGS = { toolCallTimeoutMs: 120000 }
const DEFAULT_AGENT = { id: 'agent-default' }

/** A scripted subprocess handle shaped like the DSH one. */
function makeHandle(options) {
  const opts = options ?? {}
  const state = {
    stdout: opts.stdout ?? '',
    stderr: opts.stderr ?? '',
    stdoutLossy: opts.stdoutLossy === true,
    spillPath: opts.spillPath,
    exitCode: opts.exitCode ?? 0,
    signal: opts.signal ?? null,
  }
  let settle
  let fail
  const done = new Promise((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const handle = {
    done,
    terminateCalls: 0,
    waitForExitCalls: 0,
    terminate() {
      handle.terminateCalls += 1
      settle({ exitCode: null, signal: 'SIGTERM' })
    },
    async waitForExit() {
      handle.waitForExitCalls += 1
      return true
    },
    collected: {
      stdout: {
        readFrom() {
          return { text: state.stdout, lossy: state.stdoutLossy, spillPath: state.spillPath }
        },
      },
      stderr: {
        readFrom() {
          return { text: state.stderr, lossy: false }
        },
      },
    },
    resolve(info) {
      settle(info === undefined ? { exitCode: state.exitCode, signal: state.signal } : info)
    },
    reject(error) {
      fail(error)
    },
  }
  if (opts.auto !== false) {
    queueMicrotask(() => settle({ exitCode: state.exitCode, signal: state.signal }))
  }
  return handle
}

/** A ctx exposing only what the CLI tool touches. */
function fakeContext(options) {
  const opts = options ?? {}
  const state = { ensured: [], specs: [], spawnReceiver: undefined }
  const ctx = {
    get(key) {
      if (key === 'agents' && opts.initiator !== null) {
        return {
          currentInitiator: () => (opts.initiator === undefined ? DEFAULT_AGENT : opts.initiator),
        }
      }
      return undefined
    },
    workingDirectory: {
      async ensure(agent, signal) {
        state.ensured.push({ agent, signal })
        return opts.root ?? 'D:/repo'
      },
    },
    subprocess: {
      spawn(spec) {
        state.spawnReceiver = this
        state.specs.push(spec)
        if (opts.onSpawn !== undefined) opts.onSpawn(spec)
        return opts.handle === undefined ? makeHandle() : opts.handle
      },
    },
  }
  return { ctx, state }
}

/** Build one definition against a fresh fake context. */
function setup(options) {
  const opts = options ?? {}
  const fake = fakeContext(opts)
  const definition = createCliTool({
    serverName: 'basemind',
    binary: opts.binary === undefined ? { path: EXE } : opts.binary,
    ctx: fake.ctx,
    config: opts.config === undefined ? SETTINGS : opts.config,
    logger: opts.logger,
  })
  return { definition, ctx: fake.ctx, state: fake.state }
}

test('the definition matches the plan (name, schema, timeout, concurrency)', () => {
  const { definition } = setup()
  assert.equal(definition.name, 'mcp__basemind__cli')
  assert.match(definition.description, /advanced analysis/)
  assert.match(definition.description, /Read-only verbs only/)
  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.parameters.required, ['args'])
  assert.equal(definition.parameters.properties.args.type, 'array')
  assert.equal(definition.parameters.properties.args.items.type, 'string')
  assert.equal(definition.parameters.properties.timeout_ms.type, 'integer')
  assert.equal(definition.parameters.properties.timeout_ms.minimum, 1000)
  assert.equal(definition.parameters.properties.timeout_ms.maximum, 600000)
  assert.equal(definition.timeoutMs, 125000)
  assert.equal(definition.isConcurrencySafe(), true)
  const blocks = definition.output.render({}, { text: 'hello', content: [], isError: false })
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }])

  const short = setup({ config: { toolCallTimeoutMs: 1000 } })
  assert.equal(short.definition.timeoutMs, 6000)
})

test('a legacy npx selection keeps its package spec in front of the argv', async () => {
  const { definition, state } = setup({ binary: { path: 'npx.exe', extraArgs: ['-y', 'basemind@latest'] } })
  await definition.execute({ args: ['status'] }, {})

  assert.equal(state.specs.length, 1)
  assert.deepEqual(state.specs[0].argv.slice(0, 6), ['npx.exe', '-y', 'basemind@latest', 'status', '--root', '.'])
})

test('allowed read-only verbs run the verified binary with argv and --root .', async () => {
  const cases = [
    ['code', 'outline', 'lib/x.js'],
    ['code', 'symbols'],
    ['code', 'read', 'lib/x.js'],
    ['code', 'grep', 'needle'],
    ['code', 'refs', 'lib/x.js'],
    ['code', 'callers'],
    ['code', 'implementations'],
    ['code', 'dependents'],
    ['code', 'definition'],
    ['code', 'find'],
    ['code', 'files'],
    ['code', 'chunk'],
    ['code', 'impact', 'lib/x.js'],
    ['code', 'cycles'],
    ['code', 'explain', 'lib/x.js'],
    ['code', 'deadcode'],
    ['code', 'migration', 'check'],
    ['git', 'log'],
    ['git', 'blame', 'lib/x.js'],
    ['git', 'diff'],
    ['git', 'status'],
    ['git', 'recent'],
    ['git', 'touching'],
    ['git', 'search'],
    ['git', 'show'],
    ['git', 'symbol-history'],
    ['git', 'blame-symbol'],
    ['git', 'diff-outline'],
    ['git', 'churn'],
    ['git', 'hotspots'],
    ['git', 'by-path'],
    ['memory', 'search'],
    ['memory', 'get'],
    ['memory', 'list'],
    ['docs', 'search'],
    ['cache', 'stats'],
    ['admin', 'repo'],
    ['admin', 'telemetry'],
    ['admin', 'tokens'],
    ['admin', 'eval'],
    ['status'],
    ['doctor'],
    ['overview'],
    ['statusline'],
    ['sessions'],
    ['manual'],
    ['man'],
    ['completions'],
    ['upgrade', '--plan'],
  ]
  for (const argv of cases) {
    const handle = makeHandle({ stdout: 'ok' })
    const { definition, state } = setup({ handle })
    const result = await definition.execute({ args: argv }, {})
    assert.equal(result.isError, false, 'expected allowed: ' + argv.join(' '))
    assert.equal(result.text, 'ok')
    assert.deepEqual(result.content, [])
    assert.equal(result.isError, false)
    assert.equal(state.specs.length, 1)
    const spec = state.specs[0]
    assert.deepEqual(spec.argv, [EXE, ...argv, '--root', '.'])
    assert.equal(spec.cwd, 'D:/repo')
    assert.equal(spec.graceMs, 2000)
    assert.deepEqual(spec.stdio.stdout, { maxBytes: 65536, spill: { maxBytes: 2097152 } })
    assert.deepEqual(spec.stdio.stderr, { maxBytes: 8192 })
    assert.equal(Object.hasOwn(spec.stdio, 'stdin'), false)
  }
})

test('the denylist wins and refuses destructive machine-global verbs', async () => {
  const cases = [
    ['init'],
    ['scan'],
    ['rescan'],
    ['watch'],
    ['serve'],
    ['hook'],
    ['lang'],
    ['daemon'],
    ['comms'],
    ['agent'],
    ['workspace'],
    ['memory', 'put'],
    ['memory', 'documents'],
    ['memory', 'delete'],
    ['memory', 'clear'],
    ['cache', 'gc'],
    ['cache', 'clear'],
    ['upgrade'],
    ['admin', 'reset'],
    ['code', 'rescan'],
  ]
  for (const argv of cases) {
    const { definition, state } = setup()
    const result = await definition.execute({ args: argv }, {})
    assert.equal(result.isError, true, 'expected refusal: ' + argv.join(' '))
    assert.equal(state.specs.length, 0)
    assert.match(result.text, /^dsh-basemind-plugin: /)
    assert.ok(result.text.includes('Allowed:'))
  }

  const { definition } = setup()
  const cacheClear = await definition.execute({ args: ['cache', 'clear'] }, {})
  assert.ok(cacheClear.text.includes('destructive machine-global command'))
  const upgrade = await definition.execute({ args: ['upgrade'] }, {})
  assert.ok(upgrade.text.includes('--plan'))
  const admin = await definition.execute({ args: ['admin', 'reset'] }, {})
  assert.ok(admin.text.includes('not a read-only admin subcommand'))

  for (const argv of [['status', '--root', 'C:/other'], ['status', '--root=C:/other']]) {
    const rooted = setup()
    const refused = await rooted.definition.execute({ args: argv }, {})
    assert.equal(refused.isError, true)
    assert.equal(rooted.state.specs.length, 0)
    assert.ok(refused.text.includes('workspace always comes from the session Agent'))
  }
})

test('unknown or malformed verbs are refused without spawning', async () => {
  const cases = [['frobnicate'], ['code'], ['code', 'nuke'], ['git', 'push'], ['docs', 'delete'], ['code', 'migration', 'apply']]
  for (const argv of cases) {
    const { definition, state } = setup()
    const result = await definition.execute({ args: argv }, {})
    assert.equal(result.isError, true, 'expected refusal: ' + argv.join(' '))
    assert.equal(state.specs.length, 0)
    assert.match(result.text, /^dsh-basemind-plugin: /)
  }
})

test('invalid inputs are refused as isError results instead of thrown errors', async () => {
  const inputs = [undefined, null, {}, { args: 'code' }, { args: [] }, { args: [1] }, { args: ['status', 5] }, { args: ['status', ''] }]
  for (const input of inputs) {
    const { definition, state } = setup()
    const result = await definition.execute(input, undefined)
    assert.equal(result.isError, true)
    assert.equal(state.specs.length, 0)
    assert.match(result.text, /^dsh-basemind-plugin: /)
  }
})

test('the workspace root and signal come from the calling Agent', async () => {
  const agent = { id: 'agent-1' }
  const signal = new AbortController().signal
  const { definition, state } = setup({ root: 'D:/work/repo' })
  await definition.execute({ args: ['status'] }, { agent, signal })
  assert.equal(state.ensured.length, 1)
  assert.equal(state.ensured[0].agent, agent)
  assert.equal(state.ensured[0].signal, signal)

  const initiator = { id: 'agent-2' }
  const fallback = setup({ initiator })
  await fallback.definition.execute({ args: ['status'] }, { signal })
  assert.equal(fallback.state.ensured[0].agent, initiator)
})

test('a call without an Agent fails instead of guessing a workspace', async () => {
  const { definition, state } = setup({ initiator: null })
  const result = await definition.execute({ args: ['status'] }, {})
  assert.equal(result.isError, true)
  assert.ok(result.text.includes('live Agent'))
  assert.equal(state.specs.length, 0)
})

test('a nonzero exit is an isError result that keeps stdout, stderr and the code', async () => {
  const handle = makeHandle({ exitCode: 2, stdout: 'partial output', stderr: 'boom' })
  const { definition } = setup({ handle })
  const result = await definition.execute({ args: ['code', 'explain', 'lib/x.js'] }, {})
  assert.equal(result.isError, true)
  assert.ok(result.text.includes('BaseMind CLI exited with code 2.'))
  assert.ok(result.text.includes('partial output'))
  assert.ok(result.text.includes('[stderr]'))
  assert.ok(result.text.includes('boom'))
})

test('a timeout terminates the process and reports the clamped timeout', async () => {
  const handle = makeHandle({ auto: false })
  const { definition } = setup({ handle })
  const started = Date.now()
  const result = await definition.execute({ args: ['status'], timeout_ms: 50 }, {})
  assert.equal(result.isError, true)
  assert.match(result.text, /timed out after 1000 ms/)
  assert.equal(handle.terminateCalls, 1)
  assert.equal(handle.waitForExitCalls, 1)
  assert.ok(Date.now() - started >= 900)
})

test('an aborted call terminates the process and returns a cancellation result', async () => {
  const controller = new AbortController()
  const handle = makeHandle({ auto: false })
  const { definition } = setup({ handle, onSpawn: () => queueMicrotask(() => controller.abort()) })
  const result = await definition.execute({ args: ['status'] }, { signal: controller.signal })
  assert.equal(result.isError, true)
  assert.match(result.text, /cancelled/)
  assert.equal(handle.terminateCalls, 1)

  const preAborted = new AbortController()
  preAborted.abort()
  const second = setup()
  const early = await second.definition.execute({ args: ['status'] }, { signal: preAborted.signal })
  assert.equal(early.isError, true)
  assert.ok(early.text.includes('cancelled before it started'))
  assert.equal(second.state.specs.length, 0)
})

test('truncated stdout keeps the spill path and a narrowing hint', async () => {
  const handle = makeHandle({ stdout: 'line1\nline2\n', stdoutLossy: true, spillPath: 'C:/tmp/spill.log' })
  const { definition } = setup({ handle })
  const result = await definition.execute({ args: ['overview'] }, {})
  assert.equal(result.isError, false)
  assert.ok(result.text.includes('line1'))
  assert.ok(result.text.includes('[output truncated; full stream: C:/tmp/spill.log]'))
  assert.ok(result.text.includes('--limit'))
})

test('a stream rejection and a spawn failure become isError results', async () => {
  const handle = makeHandle({ auto: false })
  const { definition } = setup({ handle })
  const pending = definition.execute({ args: ['status'] }, {})
  handle.reject(new Error('spawn failed later'))
  const result = await pending
  assert.equal(result.isError, true)
  assert.ok(result.text.includes('BaseMind CLI failed: spawn failed later.'))

  const broken = setup()
  broken.ctx.subprocess.spawn = () => {
    throw new Error('ENOENT')
  }
  const failed = await broken.definition.execute({ args: ['status'] }, {})
  assert.equal(failed.isError, true)
  assert.ok(failed.text.includes('could not start the BaseMind CLI: ENOENT.'))
})

test('a missing binary or a missing spawn service is reported, never thrown', async () => {
  const noBinary = setup({ binary: null })
  const first = await noBinary.definition.execute({ args: ['status'] }, {})
  assert.equal(first.isError, true)
  assert.ok(first.text.includes('no verified BaseMind binary'))

  const noSpawn = setup()
  delete noSpawn.ctx.subprocess.spawn
  const second = await noSpawn.definition.execute({ args: ['status'] }, {})
  assert.equal(second.isError, true)
  assert.ok(second.text.includes('ctx.subprocess.spawn is unavailable'))

  const asString = setup({ binary: 'D:/bin/basemind.exe' })
  await asString.definition.execute({ args: ['status'] }, {})
  assert.equal(asString.state.specs[0].argv[0], 'D:/bin/basemind.exe')
})

test('spawn keeps the subprocess provider as its receiver', async () => {
  // Regression for the Desktop D8 failure: DSH's provider is a class method that
  // reads `this` before launching, so a detached call throws
  // "Cannot read properties of undefined (reading 'selectContainmentMode')".
  const { definition, ctx, state } = setup({ binary: 'D:/bin/basemind.exe' })
  const result = await definition.execute({ args: ['status'] }, {})
  assert.equal(result.isError, false)
  assert.equal(state.spawnReceiver, ctx.subprocess, 'spawn keeps the provider as its receiver')
})
