import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { UPSTREAM } from '../lib/upstream.js'
import { createScanHistory } from '../lib/dashboard/history.js'
import { createDashboardService } from '../lib/dashboard/service.js'

/**
 * Real-BaseMind Dashboard gate.
 *
 * Opt-in because a fresh isolated data home downloads BaseMind's tree-sitter
 * grammar bundle (tens of MB): ordinary `npm test` must stay offline. The gate
 * needs both a binary and an isolated data home that already holds grammars:
 *
 *   BASEMIND_DASHBOARD_INTEGRATION=1
 *   BASEMIND_DASHBOARD_DATA_HOME=<isolated basemind data home>
 *   BASEMIND_BIN=<optional explicit binary>
 */
function binaryPath() {
  if (typeof process.env.BASEMIND_BIN === 'string' && process.env.BASEMIND_BIN !== '') return process.env.BASEMIND_BIN
  const cache = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const platform = process.platform === 'win32' ? 'windows-x64' : process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64'
  const binary = process.platform === 'win32' ? 'basemind.exe' : 'basemind'
  return path.join(cache, 'cache', 'dsh-basemind-plugin', 'managed-binaries', UPSTREAM.version, platform, binary)
}

const BINARY = binaryPath()
const DATA_HOME = process.env.BASEMIND_DASHBOARD_DATA_HOME
const SKIP = process.env.BASEMIND_DASHBOARD_INTEGRATION !== '1'
  ? 'set BASEMIND_DASHBOARD_INTEGRATION=1 to run the real BaseMind Dashboard gate'
  : !fs.existsSync(BINARY)
    ? 'no BaseMind binary at ' + BINARY
    : DATA_HOME === undefined || DATA_HOME === ''
      ? 'set BASEMIND_DASHBOARD_DATA_HOME to an isolated data home that holds the grammar bundle'
      : false

/** A synchronous runner over node:child_process (the Host uses ctx.subprocess). */
function syncRunner(env) {
  const calls = []
  return {
    calls,
    async run({ cwd, args, timeoutMs }) {
      calls.push({ cwd, args })
      const result = spawnSync(BINARY, args, {
        cwd,
        env: { ...process.env, ...env, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      })
      return {
        ok: result.error === undefined,
        exitCode: typeof result.status === 'number' ? result.status : null,
        signal: result.signal ?? null,
        stdout: (result.stdout ?? '').slice(0, 256 * 1024),
        stderr: (result.stderr ?? '').slice(0, 16 * 1024),
        message: result.error ? String(result.error) : undefined,
      }
    },
  }
}

const SELECTION = {
  ok: true,
  source: 'test',
  path: BINARY,
  version: UPSTREAM.version,
  compatible: true,
  verified: true,
  policy: 'exact',
  reason: 'match',
}

function workspacesOf(repoPath) {
  const items = [{ id: 'ws-1', title: 'Dashboard gate', path: repoPath, name: 'ws' }]
  return { list: () => ({ source: 'workspace-registry', items }), find: (id) => items.find((item) => item.id === id) }
}

async function waitFor(check, label, attempts = 600) {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('timed out waiting for ' + label)
}

test('the real Dashboard reads, scans and records on an isolated BaseMind home', { skip: SKIP, timeout: 600_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bm-dashboard-gate-'))
  const repo = path.join(root, 'ws')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export function a() { return 1; }\n')
  fs.writeFileSync(path.join(repo, 'src', 'b.js'), "import { a } from './a.js';\nexport function b() { return a() + 1; }\n")
  fs.writeFileSync(path.join(repo, 'README.md'), '# gate\n')
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  git(['add', '-A'])
  git(['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'])

  try {
    const runner = syncRunner({ BASEMIND_DATA_HOME: DATA_HOME, BASEMIND_COMMS_DIR: path.join(DATA_HOME, 'comms') })
    const history = createScanHistory({ root: path.join(root, 'history') })
    const service = createDashboardService({
      workspaces: workspacesOf(repo),
      history,
      runner,
      selection: () => SELECTION,
      plugin: { version: '0.2.1', serverName: 'basemind' },
    })

    // 1. An unindexed project is reported as such, and the read does not build an index.
    const before = await service.overview('ws-1', { refresh: true })
    assert.equal(before.status.indexState, 'not-indexed')
    assert.equal(before.status.fileCount, 0)
    assert.equal(before.binary.ready, true)

    // 2. A full scan is explicit, reports its own summary, and lands in history.
    await service.startScan({ workspaceId: 'ws-1', mode: 'full' })
    await waitFor(async () => (await service.scanState('ws-1')).job?.state === 'completed', 'the full scan')
    const scanned = await service.scanState('ws-1')
    assert.equal(scanned.job.summary.scanned, 3)
    assert.equal(scanned.history.length, 1)
    assert.equal(scanned.history[0].status, 'completed')

    // 3. The next Overview sees the indexed files.
    const after = await service.overview('ws-1', { refresh: true })
    assert.equal(after.status.indexState, 'ready')
    assert.equal(after.status.fileCount, 2)
    assert.deepEqual(after.status.languages.map((row) => row.language), ['javascript'])

    // 4. An incremental scan of one path is accepted and summarised.
    await service.startScan({ workspaceId: 'ws-1', mode: 'incremental', paths: ['src/a.js'] })
    await waitFor(async () => (await service.scanState('ws-1')).job?.state === 'completed', 'the incremental scan')
    const incremental = await service.scanState('ws-1')
    assert.equal(incremental.job.scanType, 'incremental')
    assert.deepEqual(incremental.job.scope, ['src/a.js'])
    assert.equal(incremental.history.length, 2)

    // 5. Diagnostics carries BaseMind's own checks.
    const diagnostics = await service.diagnostics('ws-1')
    const checks = diagnostics.doctor.checks.map((check) => check.name)
    assert.ok(checks.includes('root'))
    assert.ok(checks.includes('index'))
    assert.equal(diagnostics.doctor.checks.find((check) => check.name === 'root').status, 'ok')

    // 6. Statistics keeps the machine-global scope labels honest.
    const statistics = await service.statistics('ws-1', { window: '1h' })
    assert.equal(statistics.window, '1h')
    assert.equal(typeof statistics.cache.totalBytes, 'number')
    assert.match(statistics.scopes.cache, /machine-global/)
    assert.match(statistics.capabilities.tokenAccounting, /heuristic/)

    // 7. A path outside the workspace is refused before any CLI call.
    const callsBefore = runner.calls.length
    await assert.rejects(
      () => service.startScan({ workspaceId: 'ws-1', mode: 'incremental', paths: ['../escape.js'] }),
      /inside the workspace/,
    )
    assert.equal(runner.calls.length, callsBefore)

    await service.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
