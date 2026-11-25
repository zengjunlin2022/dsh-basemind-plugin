import assert from 'node:assert/strict'
import test from 'node:test'

import { DashboardError, createDashboardService } from '../lib/dashboard/service.js'

const STATUS = {
  file_count: 3,
  blob_count: 3,
  total_size_bytes: 90,
  languages: { javascript: 3 },
  large_files: { threshold_lines: 2000, count: 0 },
  most_imported: [],
  root: 'C:/repo',
  branch: 'main',
  head_short_sha: 'abc1234',
  admission: { heavy: { limit: 4, in_use: 0, queued: 0 }, medium: { limit: 8, in_use: 0, queued: 0 }, queue_wait_ms: 2000 },
}

function workspacesOf(entries) {
  const items = entries.map((entry) => ({ id: entry.id, title: entry.title ?? entry.id, path: entry.path, name: entry.path }))
  return {
    list: () => ({ source: 'workspace-registry', items }),
    find: (id) => items.find((item) => item.id === id),
  }
}

function historyOf(enabled = true) {
  const store = new Map()
  return {
    enabled,
    recorded: [],
    async read(workspacePath) {
      return store.get(workspacePath) ?? []
    },
    async record(workspacePath, entry) {
      this.recorded.push(entry)
      const next = [entry, ...(store.get(workspacePath) ?? [])].slice(0, 10)
      store.set(workspacePath, next)
      return next
    },
  }
}

function runnerOf(handler) {
  const calls = []
  return {
    calls,
    async run(call) {
      calls.push(call)
      return handler(call, calls.length)
    },
  }
}

function selection() {
  return { ok: true, source: 'managed', path: 'C:/bin/basemind.exe', version: '0.34.0', compatible: true, verified: true, policy: 'exact', reason: 'match' }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function waitFor(check, label, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value === true) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for ' + label)
}

test('overview normalises status and serves a fresh cache entry', async () => {
  const runner = runnerOf(() => ({ ok: true, exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' }))
  const service = createDashboardService({
    workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]),
    history: historyOf(),
    runner,
    selection,
  })
  const first = await service.overview('ws-1')
  assert.equal(first.status.fileCount, 3)
  assert.equal(first.status.indexState, 'ready')
  assert.equal(first.workspace.id, 'ws-1')
  assert.equal(first.activeScan, null)
  assert.equal(first.capabilities.progress, false)
  assert.equal(runner.calls[0].cwd, 'C:/repo')
  assert.deepEqual(runner.calls[0].args, ['status', '--json', '--root', '.'])

  await service.overview('ws-1')
  assert.equal(runner.calls.length, 1, 'the second read must reuse the cache')

  await service.overview('ws-1', { refresh: true })
  assert.equal(runner.calls.length, 2)
})

test('two identical concurrent reads coalesce into one CLI call', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const runner = runnerOf(async () => {
    await gate
    return { ok: true, exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' }
  })
  const service = createDashboardService({
    workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]),
    history: historyOf(),
    runner,
    selection,
  })
  const one = service.overview('ws-1')
  const two = service.overview('ws-1')
  release()
  const [a, b] = await Promise.all([one, two])
  assert.equal(a, b)
  assert.equal(runner.calls.length, 1)
})

test('only one read runs at a time and the queue is bounded', async () => {
  const gates = []
  let running = 0
  let peak = 0
  const runner = runnerOf(
    () =>
      new Promise((resolve) => {
        running += 1
        peak = Math.max(peak, running)
        gates.push(() => {
          running -= 1
          resolve({ ok: true, exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' })
        })
      }),
  )
  const entries = Array.from({ length: 6 }, (_, index) => ({ id: 'ws-' + String(index), path: 'C:/repo' + String(index) }))
  const service = createDashboardService({ workspaces: workspacesOf(entries), history: historyOf(), runner, selection })
  const settled = entries.map((entry) => service.overview(entry.id).then(() => 'ok', (error) => error))
  await flush()
  assert.equal(runner.calls.length, 1, 'one read at a time')
  const results = await Promise.all(settled.slice(1).map((promise) => Promise.race([promise, flush().then(() => 'pending')])))
  assert.ok(results.includes('pending'))
  // Drain: release each running call as it starts.
  for (let index = 0; index < 40; index += 1) {
    const gate = gates.shift()
    if (gate !== undefined) gate()
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const outcomes = await Promise.all(settled)
  assert.ok(outcomes.some((outcome) => outcome instanceof DashboardError && outcome.code === 'busy'))
  assert.equal(peak, 1, 'a refused request must never let a second read run at the same time')
})

test('an unknown workspace is a 404 and an unavailable binary is a 503', async () => {
  const runner = runnerOf(() => ({ ok: true, exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' }))
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  await assert.rejects(() => service.overview('nope'), (error) => error instanceof DashboardError && error.status === 404)

  const unavailable = createDashboardService({
    workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]),
    history: historyOf(),
    runner,
    selection: () => undefined,
  })
  await assert.rejects(() => unavailable.overview('ws-1'), (error) => error instanceof DashboardError && error.status === 503 && error.code === 'binary-unavailable')
  assert.equal(runner.calls.length, 0, 'no CLI call may happen without a binary or a known workspace')
})

test('a non-zero exit without allowNonZero becomes a 502 carrying the stderr tail', async () => {
  const runner = runnerOf(() => ({ ok: true, exitCode: 1, stdout: '', stderr: 'Error: refusing to use C:/x as a workspace root\n' }))
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  await assert.rejects(
    () => service.overview('ws-1'),
    (error) => error instanceof DashboardError && error.status === 502 && /refusing to use/.test(error.message),
  )
})

test('doctor keeps its JSON verdict even though a failing check exits 1', async () => {
  const doctor = { ok: false, checks: [{ check: 'root', status: 'FAIL', detail: 'refused' }] }
  const runner = runnerOf((call) =>
    call.args[0] === 'doctor'
      ? { ok: true, exitCode: 1, stdout: JSON.stringify(doctor), stderr: 'Error: doctor found problems\n' }
      : { ok: true, exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' },
  )
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  const diagnostics = await service.diagnostics('ws-1')
  assert.equal(diagnostics.doctor.ok, false)
  assert.deepEqual(diagnostics.doctor.failing.map((check) => check.name), ['root'])
  assert.equal(diagnostics.capabilities.automaticRepair, false)
  assert.equal(diagnostics.binary.version, '0.34.0')
})

test('an unknown telemetry window falls back to today', async () => {
  const runner = runnerOf((call) => {
    if (call.args[0] === 'cache') return { ok: true, exitCode: 0, stdout: JSON.stringify({ total_bytes: 1 }), stderr: '' }
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ window: 'today', total_calls: 0 }), stderr: '' }
  })
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  const statistics = await service.statistics('ws-1', { window: 'bogus' })
  assert.equal(statistics.window, 'today')
  assert.deepEqual(runner.calls[1].args, ['admin', 'telemetry', '--window', 'today', '--json', '--root', '.'])
  assert.equal(statistics.scopes.processMemory, 'the short-lived BaseMind CLI process that answered this query')
})

test('a full scan runs scan --json, records history and invalidates the snapshot', async () => {
  const summary = { scanned: 3, updated: 2, elapsed_ms: 30, root: 'C:/repo' }
  const runner = runnerOf((call) =>
    call.args[0] === 'scan'
      ? { ok: true, exitCode: 0, stdout: JSON.stringify(summary), stderr: '' }
      : { ok: true, exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' },
  )
  const history = historyOf()
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history, runner, selection })
  await service.overview('ws-1')
  const job = await service.startScan({ workspaceId: 'ws-1', mode: 'full' })
  assert.equal(job.scanType, 'full')
  assert.equal(job.state, 'queued')
  await waitFor(async () => (await service.scanState('ws-1')).job?.state === 'completed', 'scan completion')
  const state = await service.scanState('ws-1')
  assert.equal(state.job.summary.scanned, 3)
  assert.equal(state.history.length, 1)
  assert.equal(history.recorded.length, 1)
  assert.equal(runner.calls.filter((call) => call.args[0] === 'scan').length, 1)
  await service.overview('ws-1')
  assert.equal(runner.calls.filter((call) => call.args[0] === 'status').length, 2, 'the scan must invalidate the overview snapshot')
})

test('an incremental scan sends only validated repo-relative paths', async () => {
  const runner = runnerOf(() => ({ ok: true, exitCode: 0, stdout: JSON.stringify({ scanned: 1 }), stderr: '' }))
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  await service.startScan({ workspaceId: 'ws-1', mode: 'incremental', paths: ['src/a.js'] })
  await waitFor(async () => (await service.scanState('ws-1')).job?.state === 'completed', 'incremental completion')
  assert.deepEqual(runner.calls[0].args, ['rescan', 'src/a.js', '--json', '--root', '.'])
  await assert.rejects(
    () => service.startScan({ workspaceId: 'ws-1', mode: 'incremental', paths: ['../escape.js'] }),
    (error) => error instanceof DashboardError && error.status === 400 && error.code === 'bad-scope',
  )
  await assert.rejects(
    () => service.startScan({ workspaceId: 'ws-1', mode: 'incremental', paths: [] }),
    (error) => error instanceof DashboardError && error.code === 'bad-scope',
  )
  await assert.rejects(
    () => service.startScan({ workspaceId: 'ws-1', mode: 'sideways' }),
    (error) => error instanceof DashboardError && error.code === 'bad-mode',
  )
})

test('a second scan of the same workspace is refused while the first runs', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const runner = runnerOf(async () => {
    await gate
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ scanned: 1 }), stderr: '' }
  })
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  await service.startScan({ workspaceId: 'ws-1', mode: 'full' })
  await assert.rejects(
    () => service.startScan({ workspaceId: 'ws-1', mode: 'full' }),
    (error) => error instanceof DashboardError && error.status === 409 && error.code === 'scan-busy',
  )
  release()
  await waitFor(async () => (await service.scanState('ws-1')).job?.state === 'completed', 'completion')
})

test('a failing scan keeps its diagnostic and is recorded as failed', async () => {
  const runner = runnerOf(() => ({ ok: true, exitCode: 2, stdout: '', stderr: 'Error: invalid rescan path(s):\n  "nope" does not exist\n' }))
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  await service.startScan({ workspaceId: 'ws-1', mode: 'incremental', paths: ['nope'] })
  await waitFor(async () => (await service.scanState('ws-1')).job?.state === 'failed', 'failure')
  const state = await service.scanState('ws-1')
  assert.match(state.job.error, /does not exist/)
  assert.equal(state.history[0].status, 'failed')
})

test('dispose marks a running scan interrupted and records it', async () => {
  const runner = runnerOf(
    (call) =>
      new Promise((resolve) => {
        call.signal?.addEventListener('abort', () => {
          resolve({ ok: false, code: 'aborted', message: 'cancelled', stdout: '', stderr: '' })
        })
      }),
  )
  const history = historyOf()
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history, runner, selection })
  await service.startScan({ workspaceId: 'ws-1', mode: 'full' })
  await flush()
  await service.dispose()
  await flush()
  assert.equal(history.recorded.length, 1)
  assert.equal(history.recorded[0].status, 'interrupted')
})

test('dispose rejects every queued read so nothing hangs', async () => {
  const runner = runnerOf(
    (call) =>
      new Promise((resolve) => {
        call.signal?.addEventListener('abort', () => {
          resolve({ ok: false, code: 'aborted', message: 'cancelled', stdout: '', stderr: '' })
        })
      }),
  )
  const entries = Array.from({ length: 3 }, (_, index) => ({ id: 'ws-' + String(index), path: 'C:/repo' + String(index) }))
  const service = createDashboardService({ workspaces: workspacesOf(entries), history: historyOf(), runner, selection })
  const pending = entries.map((entry) => service.overview(entry.id).then(() => 'ok', (error) => error))
  await flush()
  await service.dispose()
  const outcomes = await Promise.all(pending)
  assert.ok(outcomes.every((outcome) => outcome instanceof DashboardError))
  assert.ok(outcomes.filter((outcome) => outcome.code === 'disposed').length >= 2, 'the queued reads must be refused on dispose')
})

test('a scan of another workspace is refused while one runs (conservative serialising)', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const runner = runnerOf(async () => {
    await gate
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ scanned: 1 }), stderr: '' }
  })
  const service = createDashboardService({
    workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }, { id: 'ws-2', path: 'C:/other' }]),
    history: historyOf(),
    runner,
    selection,
  })
  await service.startScan({ workspaceId: 'ws-1', mode: 'full' })
  await assert.rejects(
    () => service.startScan({ workspaceId: 'ws-2', mode: 'full' }),
    (error) => error instanceof DashboardError && error.status === 409 && error.code === 'scan-busy' && /C:\/repo/.test(error.message),
  )
  release()
  await waitFor(async () => (await service.scanState('ws-1')).job?.state === 'completed', 'completion')
})

test('an unreadable history never fails Overview or scan state', async () => {
  const runner = runnerOf(() => ({ ok: true, exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' }))
  const broken = {
    enabled: true,
    async read() {
      throw new Error('EACCES')
    },
    async record() {
      return []
    },
  }
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: broken, runner, selection })
  const overview = await service.overview('ws-1')
  assert.equal(overview.lastDashboardScan, null)
  const state = await service.scanState('ws-1')
  assert.deepEqual(state.history, [])
})

test('dispose aborts an in-flight read that carried its own client signal', async () => {
  const runner = runnerOf(
    (call) =>
      new Promise((resolve) => {
        call.signal?.addEventListener('abort', () => {
          resolve({ ok: false, code: 'aborted', message: 'cancelled', stdout: '', stderr: '' })
        })
      }),
  )
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  const client = new AbortController()
  const pending = service.overview('ws-1', { signal: client.signal }).then(() => 'ok', (error) => error)
  await flush()
  await service.dispose()
  const outcome = await pending
  assert.ok(outcome instanceof DashboardError)
  assert.equal(outcome.code, 'aborted')
})

test('a read that started before a scan invalidation does not refill the cache', async () => {
  let statusCalls = 0
  let releaseStatus
  const ok = { ok: true, exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' }
  const runner = runnerOf((call) => {
    if (call.args[0] === 'status') {
      statusCalls += 1
      if (statusCalls === 1) return new Promise((resolve) => { releaseStatus = () => resolve(ok) })
      return ok
    }
    return { ok: true, exitCode: 0, stdout: JSON.stringify({ scanned: 1 }), stderr: '' }
  })
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo' }]), history: historyOf(), runner, selection })
  const first = service.overview('ws-1')
  await waitFor(() => statusCalls === 1, 'the first status call')
  await service.startScan({ workspaceId: 'ws-1', mode: 'full' })
  await waitFor(async () => (await service.scanState('ws-1')).job?.state === 'completed', 'the scan')
  releaseStatus()
  await first
  await service.overview('ws-1')
  assert.equal(
    runner.calls.filter((call) => call.args[0] === 'status').length,
    2,
    'the read that started before the invalidation must not become the cached Overview',
  )
})

test('the workspace catalogue passes the registry source and its limitation through', () => {
  const service = createDashboardService({ workspaces: workspacesOf([{ id: 'ws-1', path: 'C:/repo', title: 'Repo' }]), history: historyOf(), runner: runnerOf(() => ({})), selection })
  const listed = service.listWorkspaces()
  assert.equal(listed.source, 'workspace-registry')
  assert.equal(listed.items[0].title, 'Repo')
  assert.equal(listed.capabilities.followCurrentSession, false)
})
