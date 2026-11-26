import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_FILE = path.join(import.meta.dirname, '..', 'lib', 'dashboard', 'client.js')
const SOURCE = fs.readFileSync(CLIENT_FILE, 'utf8')

/**
 * A minimal React stand-in: element trees and hook slots, no effects run.
 *
 * It enforces React's hook rule between `beginRender()` and `endRender()`: a render
 * that calls a different number of hooks than the previous one throws, exactly as
 * the real renderer does. That is what makes an inline `ScanView(...)` call inside
 * DashboardPage fail here instead of only in a browser.
 */
function createReact() {
  const hooks = []
  const setters = new Map()
  let cursor = 0
  let expected = null
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
      if (!setters.has(index)) {
        setters.set(index, (value) => {
          hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
        })
      }
      return [hooks[index], setters.get(index)]
    },
    useEffect() {
      cursor += 1
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    Fragment: 'Fragment',
  }
  return {
    React,
    setters,
    beginRender() {
      cursor = 0
    },
    endRender() {
      if (expected !== null && expected !== cursor) {
        throw new Error('Rendered ' + String(cursor) + ' hooks but expected ' + String(expected))
      }
      expected = cursor
    },
    hookCount() {
      return cursor
    },
    clear() {
      hooks.length = 0
      setters.clear()
      cursor = 0
      expected = null
    },
  }
}

/** Every element in a tree, depth first. */
function elementsOf(node, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const item of node) elementsOf(item, found)
    return found
  }
  if (node.type !== undefined) found.push(node)
  elementsOf(node.children, found)
  return found
}

/** Load the client bundle once and return its registered spec plus exports. */
function loadBundle() {
  let spec
  const sandbox = {
    window: { __ModuleLoader__: { load(next) { spec = next } } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Date,
    AbortController,
    fetch: () => Promise.reject(new Error('network disabled in tests')),
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: CLIENT_FILE })
  assert.ok(spec, 'the bundle must register itself with window.__ModuleLoader__')
  const stub = createReact()
  const exports = spec.factory((name) => {
    assert.equal(name, 'react', 'the bundle may only require react')
    return stub.React
  })
  return { spec, exports, stub }
}

/** All text in a rendered tree. */
function textOf(node) {
  const parts = []
  const walk = (value) => {
    if (value === null || value === undefined || value === false) return
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value.children) walk(value.children)
    if (value.props) {
      for (const key of Object.keys(value.props)) {
        if (key === 'style') continue
        const prop = value.props[key]
        if (typeof prop === 'string' || typeof prop === 'number') parts.push(String(prop))
        else if (Array.isArray(prop) || (prop !== null && typeof prop === 'object' && prop.type !== undefined)) walk(prop)
      }
    }
  }
  walk(node)
  return parts.join(' | ')
}

function keysOf(dictionary) {
  return Object.keys(dictionary).sort()
}

const { spec, exports, stub } = loadBundle()

test('the bundle registers the package id in the DSH module-loader format', () => {
  assert.equal(spec.id, 'dsh-basemind-plugin')
  assert.equal(typeof spec.factory, 'function')
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.DashboardPage, 'function')
})

test('apply registers both dictionaries with the same keys and one row-config entry', () => {
  const registered = []
  const dictionaries = []
  let slot = null
  const ctx = {
    effect(fn, label) {
      assert.equal(typeof label, 'string')
      return fn()
    },
    locale: {
      register(name, dicts) {
        dictionaries.push({ name, dicts })
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        slot = { name, disposer: callback() }
        return () => {}
      },
      register(options, Component) {
        registered.push({ options, Component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].name, 'dshBasemindDashboard')
  assert.deepEqual(keysOf(dictionaries[0].dicts.zh), keysOf(dictionaries[0].dicts.en))
  assert.ok(keysOf(dictionaries[0].dicts.zh).length > 40)
  assert.equal(slot.name, 'plugins.row.config')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'plugins.row.config')
  assert.equal(registered[0].options.key, 'dsh-basemind-plugin#dsh-basemind')
  assert.equal(registered[0].options.locale, 'dshBasemindDashboard')
  assert.equal(registered[0].Component, exports.DashboardPage)
})

test('the page renders nothing for the summary view and a shell for the page view', () => {
  stub.clear()
  const summary = exports.DashboardPage({ t: (key) => key, view: 'summary' })
  assert.equal(summary, null)
  stub.clear()
  const page = exports.DashboardPage({ t: (key) => key, view: 'page' })
  assert.ok(page, 'the page view must render')
  assert.equal(page.type, 'div')
})

test('every tab body is an element, so no view runs inside the page render', () => {
  const views = exports.__internals
  const tabs = [
    ['overview', views.OverviewView],
    ['scan', views.ScanView],
    ['diagnostics', views.DiagnosticsView],
    ['statistics', views.StatisticsView],
  ]
  for (const [tab, Component] of tabs) {
    stub.beginRender()
    const element = views.TabBody({
      tab,
      t: (key) => key,
      overview: { state: 'idle' },
      activeScan: null,
      scan: { state: 'idle' },
      workspace: null,
      diagnostics: { state: 'idle' },
      statistics: { state: 'idle' },
      window: 'today',
    })
    assert.equal(stub.hookCount(), 0, tab + ' must not execute its view component during the page render')
    stub.endRender()
    assert.equal(typeof element.type, 'function')
    assert.equal(element.type, Component)
  }
})

test('switching to the Scan tab keeps DashboardPage hook order stable', () => {
  stub.clear()
  const t = (key) => key
  stub.beginRender()
  const first = exports.DashboardPage({ t, view: 'page' })
  stub.endRender()
  assert.equal(first.type, 'div')
  assert.equal(elementsOf(first).some((element) => element.type === exports.__internals.TabBody), false, 'an empty workspace list renders no tab body')

  // Load one workspace, select it, then switch to Scan — the exact transition that
  // used to add ScanView's four hooks to DashboardPage's chain.
  stub.setters.get(0)({ source: 'workspace-registry', items: [{ id: 'ws-1', title: 'Repo', path: 'C:/repo', name: 'repo' }] })
  stub.setters.get(2)('ws-1')
  stub.beginRender()
  const overviewPage = exports.DashboardPage({ t, view: 'page' })
  stub.endRender()
  assert.ok(elementsOf(overviewPage).some((element) => element.type === exports.__internals.TabBody), 'the tab body must be an element')

  stub.setters.get(3)('scan')
  stub.beginRender()
  const scanPage = exports.DashboardPage({ t, view: 'page' })
  stub.endRender()
  assert.ok(elementsOf(scanPage).some((element) => element.type === exports.__internals.TabBody))
})

const READY_OVERVIEW = {
  workspace: { id: 'ws-1', title: 'Repo', path: 'C:/repo' },
  status: {
    indexState: 'ready',
    fileCount: 120,
    blobCount: 118,
    totalSizeBytes: 802816,
    languages: [
      { language: 'javascript', files: 90, share: 0.75 },
      { language: 'typescript', files: 30, share: 0.25 },
    ],
    mostImported: [{ path: 'src/base.js', importers: 40 }],
    largeFiles: { thresholdLines: 2000, count: 0 },
    notice: null,
    branch: 'main',
    head: 'abcdef0',
  },
  activeScan: null,
  lastDashboardScan: null,
  binary: { ready: true, version: '0.34.0', source: 'managed' },
  capabilities: {},
}

test('OverviewView renders real counts, the language share and unavailable fields', () => {
  const tree = exports.__internals.OverviewView({
    t: (key) => key,
    state: { state: 'ready', data: READY_OVERVIEW },
    activeScan: null,
    onRefresh: () => {},
    onScan: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /120/)
  assert.match(text, /118/)
  assert.match(text, /784 KB/)
  assert.match(text, /javascript/)
  assert.match(text, /75%/)
  assert.match(text, /src\/base\.js/)
  assert.match(text, /main \/ abcdef0/)
  assert.match(text, /overview\.noScan/)
})

test('OverviewView reports an empty index and a BaseMind notice without inventing numbers', () => {
  const tree = exports.__internals.OverviewView({
    t: (key) => key,
    state: {
      state: 'ready',
      data: {
        ...READY_OVERVIEW,
        status: {
          ...READY_OVERVIEW.status,
          indexState: 'not-indexed',
          fileCount: null,
          blobCount: null,
          totalSizeBytes: null,
          languages: [],
          mostImported: [],
          notice: { state: 'empty_index', message: 'nothing scanned', retry: true },
        },
      },
    },
    activeScan: null,
    onRefresh: () => {},
    onScan: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /health\.not-indexed/)
  assert.match(text, /state\.unavailable/)
  assert.match(text, /nothing scanned/)
})

test('ScanView renders the job, the confirm copy and the ten-entry history', () => {
  stub.clear()
  const history = Array.from({ length: 12 }, (_, index) => ({
    taskId: 'task-' + String(index),
    scanType: 'full',
    status: 'completed',
    startedAt: '2026-11-25T00:00:00.000Z',
    finishedAt: '2026-11-25T00:00:02.000Z',
    durationMs: 2000,
    summary: { scanned: 3, updated: 2, removed: 0, skippedUnchanged: 0, extractFailed: 0, elapsedMs: 1900 },
  }))
  const tree = exports.__internals.ScanView({
    t: (key) => key,
    state: {
      state: 'ready',
      data: {
        job: {
          taskId: 't1',
          scanType: 'incremental',
          scope: ['src/a.js'],
          state: 'running',
          startedAt: new Date(Date.now() - 5000).toISOString(),
          finishedAt: null,
          durationMs: null,
          summary: null,
          error: null,
        },
        history,
        historyEnabled: true,
        admission: null,
      },
    },
    workspace: { id: 'ws-1', path: 'C:/repo' },
    onStart: async () => {},
    onReload: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /scan\.state\.running/)
  assert.match(text, /scan\.type\.incremental/)
  assert.match(text, /src\/a\.js/)
  assert.match(text, /action\.startScan/)
  assert.match(text, /scan\.busy/)
  assert.match(text, /task-9/)
  assert.equal(text.includes('task-10'), false, 'history is capped at ten rows')
})

test('ScanView marks a disabled history and an empty job', () => {
  stub.clear()
  const tree = exports.__internals.ScanView({
    t: (key) => key,
    state: { state: 'ready', data: { job: null, history: [], historyEnabled: false, admission: null } },
    workspace: { id: 'ws-1', path: 'C:/repo' },
    onStart: async () => {},
    onReload: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /scan\.none/)
  assert.match(text, /scan\.historyDisabled/)
  assert.match(text, /scan\.progressUnavailable/)
})

test('a zero scan count renders as 0, and a finished scan keeps a translated state', () => {
  stub.clear()
  const zero = { scanned: 0, updated: 0, removed: 0, skippedUnchanged: 0, extractFailed: 0, elapsedMs: 5 }
  const tree = exports.__internals.ScanView({
    t: (key) => key,
    state: {
      state: 'ready',
      data: {
        job: { taskId: 't-zero', scanType: 'incremental', scope: ['src/a.js'], state: 'completed', startedAt: '2026-11-25T00:00:00.000Z', finishedAt: '2026-11-25T00:00:05.000Z', durationMs: 5, summary: zero, error: null },
        history: [{ taskId: 't-zero', scanType: 'incremental', status: 'completed', finishedAt: '2026-11-25T00:00:05.000Z', durationMs: 5, summary: zero }],
        historyEnabled: true,
        admission: null,
      },
    },
    workspace: { id: 'ws-1', path: 'C:/repo' },
    onStart: async () => {},
    onReload: () => {},
  })
  const text = textOf(tree)
  // A measured zero must stay 0: count(0) is the non-empty string "0", so the
  // "|| '—'" fallback only fires for a missing value.
  assert.match(text, /scan\.summary\.scanned 0/)
  assert.match(text, /scan\.summary\.updated 0/)
  assert.match(text, /scan\.summary\.removed 0/)
  assert.equal(/scan\.summary\.scanned —/.test(text), false)
  assert.equal(text.includes('null'), false)

  const overview = exports.__internals.OverviewView({
    t: (key) => key,
    state: {
      state: 'ready',
      data: {
        ...READY_OVERVIEW,
        lastDashboardScan: { taskId: 't-zero', scanType: 'full', status: 'completed', finishedAt: '2026-11-25T00:00:05.000Z', durationMs: 5, summary: zero },
      },
    },
    activeScan: null,
    onRefresh: () => {},
    onScan: () => {},
  })
  const overviewText = textOf(overview)
  assert.match(overviewText, /scan\.state\.completed/)
  assert.equal(overviewText.includes('| completed |'), false, 'the last-scan status must be translated, not a raw token')
})

test('DiagnosticsView renders each check with its own verdict', () => {
  stub.clear()
  const tree = exports.__internals.DiagnosticsView({
    t: (key) => key,
    state: {
      state: 'ready',
      data: {
        plugin: { version: '0.2.1', serverName: 'basemind' },
        binary: { ready: true, version: '0.34.0', source: 'managed', reason: 'match' },
        doctor: {
          ok: false,
          checks: [
            { name: 'root', status: 'ok', detail: 'C:/repo' },
            { name: 'index', status: 'FAIL', detail: 'no index yet' },
          ],
          failing: [{ name: 'index', status: 'FAIL', detail: 'no index yet' }],
        },
        index: { state: 'not-indexed', notice: null, fileCount: null, branch: 'main', head: 'abcdef0' },
        relay: { relays: 1, workspaces: ['C:/repo'] },
        capabilities: {},
      },
    },
    onReload: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /root/)
  assert.match(text, /FAIL/)
  assert.match(text, /no index yet/)
  assert.match(text, /1 diagnostics\.relayUnit/)
  assert.match(text, /diagnostics\.readonly/)
})

/** One ready Statistics payload, as the Host sends it (scope strings included). */
function statisticsData() {
  return {
    window: '24h',
    cache: { totalBytes: 4096, components: [{ name: 'views', bytes: 2048 }], cliProcessPeakRssBytes: 84230144, blobCount: 2, orphanBlobCount: 0, blobAccountingOk: true, repoGroups: 1, legacyIndexes: 0, lastGc: null, views: [] },
    telemetry: { window: '24h', totalCalls: 12, totalResponseBytes: 900, estimatedTokensSaved: 42, perTool: [{ tool: 'code_outline', calls: 12, estTokensSaved: 42 }], perBaseline: [], truncated: true, note: 'heuristic' },
    scopes: { cache: 'machine-global cache', telemetry: 'machine-global telemetry', processMemory: 'the query process' },
    capabilities: {},
  }
}

test('StatisticsView labels the machine-global scope and the heuristic estimate', () => {
  stub.clear()
  const tree = exports.__internals.StatisticsView({
    t: (key) => key,
    state: { state: 'ready', data: statisticsData() },
    window: '24h',
    onWindow: () => {},
    onReload: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /statistics\.truncated/)
  assert.match(text, /code_outline/)
  assert.match(text, /statistics\.global/)
  assert.match(text, /statistics\.heuristic/)
  assert.match(text, /statistics\.scope\.cache/)
  assert.match(text, /statistics\.scope\.telemetry/)
  // The payload's own scope strings are Host data, not UI copy: rendering them
  // verbatim is how English used to leak into a Chinese page.
  assert.doesNotMatch(text, /machine-global telemetry/)
  assert.match(text, /views/)
})

test('StatisticsView renders the scope copy in the UI language, not the payload text', () => {
  stub.clear()
  const dictionaries = []
  exports.apply({
    effect: (fn) => fn(),
    locale: {
      register(_name, dicts) {
        dictionaries.push(dicts)
        return () => {}
      },
    },
    slots: {
      inject(_name, callback) {
        callback()
        return () => {}
      },
      register() {
        return () => {}
      },
    },
  })
  const zh = dictionaries[0].zh
  const tree = exports.__internals.StatisticsView({
    t: (key) => zh[key] ?? key,
    state: { state: 'ready', data: statisticsData() },
    window: '24h',
    onWindow: () => {},
    onReload: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /快取目錄是整台機器共用的/)
  assert.match(text, /未依工作區分開計算/)
  assert.doesNotMatch(text, /machine-global/)
})
