/**
 * Dashboard service: the only place the plugin turns Dashboard requests into
 * BaseMind CLI work.
 *
 * Design constraints (plan §8, §18, §27, §30):
 * - Only an explicit request runs a query; nothing runs on `apply()` or while no
 *   Dashboard is open. There is no timer and no polling loop in the Host.
 * - At most one read-only BaseMind query is in flight; identical queries coalesce,
 *   the queue is bounded, and results live in a small TTL cache.
 * - Scans are explicit, serialised per workspace, never cancelled by a client
 *   disconnect, and their finished summaries are bounded to ten per workspace.
 *
 * @module dsh-basemind-plugin/lib/dashboard/service
 */
import { randomUUID } from 'node:crypto'

import {
  HISTORY_LIMIT,
  TELEMETRY_WINDOWS,
  asText,
  normalizeCacheStats,
  normalizeDoctor,
  normalizeScanSummary,
  normalizeScopePaths,
  normalizeStatus,
  normalizeTelemetry,
  parseJsonText,
} from './contracts.js'
import { workspaceKey } from './history.js'

/** Fresh enough for an open Dashboard refresh cycle, short enough to stay honest. */
const SNAPSHOT_TTL_MS = 5_000
const MAX_SNAPSHOTS = 8
const MAX_QUEUE = 4
const READ_TIMEOUT_MS = 20_000
const DOCTOR_TIMEOUT_MS = 30_000
const SCAN_TIMEOUT_MS = 30 * 60_000
const MAX_JOBS = 8

/** A request-level failure with the HTTP status and machine code the route returns. */
export class DashboardError extends Error {
  /**
   * @param {string} message - user-facing text
   * @param {number} status - HTTP status
   * @param {string} code - machine-readable code
   */
  constructor(message, status = 500, code = 'dashboard-error') {
    super(message)
    this.name = 'DashboardError'
    this.status = status
    this.code = code
  }
}

function isoNow(clock) {
  return new Date(clock()).toISOString()
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Create the Dashboard service.
 *
 * @param {{
 *   workspaces: object,
 *   history: object,
 *   runner: { run: (call: object) => Promise<object> },
 *   selection?: () => (object | undefined),
 *   plugin?: { version?: string, serverName?: string },
 *   relay?: () => object,
 *   logger?: any,
 *   now?: () => number,
 * }} options
 */
export function createDashboardService({
  workspaces,
  history,
  runner,
  selection,
  plugin,
  relay,
  logger,
  now = () => Date.now(),
} = {}) {
  if (workspaces === undefined || history === undefined || runner === undefined) {
    throw new TypeError('createDashboardService needs workspaces, history and runner')
  }

  /** @type {Map<string, { at: number, value: any }>} */
  const snapshots = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map()
  /** @type {Array<{ resolve: () => void, reject: (error: unknown) => void, signal?: AbortSignal }>} */
  const queue = []
  let active = 0
  let disposed = false
  const disposeController = new AbortController()
  /** @type {Map<string, object>} */
  const jobs = new Map()
  /** Per-workspace invalidation counter; a read that started before an
   *  invalidation must not repopulate the cache with its older result. */
  const epochs = new Map()

  function binary() {
    if (typeof selection !== 'function') return undefined
    try {
      return selection() ?? undefined
    } catch {
      return undefined
    }
  }

  /** A bounded, honest description of the selected binary; never probes or downloads. */
  function binarySummary() {
    const selected = binary()
    if (selected === undefined || selected.ok !== true) {
      return {
        ready: false,
        source: asText(selected?.source),
        version: null,
        compatible: false,
        verified: false,
        reason: asText(selected?.reason) ?? 'no binary has been selected yet',
      }
    }
    return {
      ready: selected.verified === true && selected.compatible !== false,
      source: asText(selected.source),
      version: asText(selected.version),
      compatible: selected.compatible !== false,
      verified: selected.verified === true,
      reason: asText(selected.reason),
    }
  }

  function resolveWorkspace(workspaceId) {
    const workspace = workspaces.find(workspaceId)
    if (workspace === undefined) {
      throw new DashboardError('Unknown workspace id. Pick one of the listed DSH workspaces.', 404, 'unknown-workspace')
    }
    return workspace
  }

  function cacheGet(key) {
    const hit = snapshots.get(key)
    if (hit === undefined) return undefined
    if (now() - hit.at > SNAPSHOT_TTL_MS) {
      snapshots.delete(key)
      return undefined
    }
    return hit.value
  }

  function cacheSet(key, value) {
    snapshots.set(key, { at: now(), value })
    while (snapshots.size > MAX_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value
      if (oldest === undefined) break
      snapshots.delete(oldest)
    }
  }

  function epochOf(key) {
    const separator = key.indexOf('|')
    return epochs.get(separator < 0 ? key : key.slice(0, separator)) ?? 0
  }

  function invalidate(workspacePath) {
    const prefix = workspaceKey(workspacePath) + '|'
    const workspace = prefix.slice(0, prefix.length - 1)
    epochs.set(workspace, (epochs.get(workspace) ?? 0) + 1)
    for (const key of [...snapshots.keys()]) {
      if (key.startsWith(prefix)) snapshots.delete(key)
    }
  }

  function acquire(signal) {
    if (signal?.aborted === true) return Promise.reject(new DashboardError('The Dashboard query was cancelled.', 499, 'aborted'))
    return new Promise((resolve, reject) => {
      if (active < 1) {
        active += 1
        resolve()
        return
      }
      if (queue.length >= MAX_QUEUE) {
        reject(new DashboardError('The Dashboard already has too many pending queries; try again shortly.', 429, 'busy'))
        return
      }
      queue.push({ resolve, reject, signal })
    })
  }

  function release() {
    const next = queue.shift()
    if (next === undefined) {
      active = Math.max(0, active - 1)
      return
    }
    if (next.signal?.aborted === true) {
      next.reject(new DashboardError('The Dashboard query was cancelled.', 499, 'aborted'))
      release()
      return
    }
    next.resolve()
  }

  /** Parse one CLI reply, turning every failure into a DashboardError. */
  async function runJson(cwd, args, { timeoutMs = READ_TIMEOUT_MS, signal, allowNonZero = false } = {}) {
    const selected = binary()
    if (selected === undefined || selected.ok !== true) {
      throw new DashboardError(
        'No verified BaseMind binary is selected yet. Open a BaseMind session once so the plugin selects its binary, then retry.',
        503,
        'binary-unavailable',
      )
    }
    // Dispose must also abort an in-flight read that arrived with its own client
    // signal, otherwise a route disconnect and a plugin unload both have to race.
    const signalToUse = signal === undefined
      ? disposeController.signal
      : typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, disposeController.signal])
        : signal
    const result = await runner.run({ binary: selected, cwd, args, timeoutMs, signal: signalToUse })
    if (result.ok !== true) {
      const status = result.code === 'timeout' ? 504 : result.code === 'aborted' ? 499 : 502
      throw new DashboardError(result.message ?? 'BaseMind failed.', status, result.code ?? 'baseMind-failed')
    }
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null
    if (exitCode !== null && exitCode !== 0 && allowNonZero !== true) {
      const detail = (result.stderr ?? '').trim().split('\n').filter((line) => line !== '').slice(-2).join(' ')
      throw new DashboardError('BaseMind exited with code ' + String(exitCode) + (detail === '' ? '.' : ': ' + detail), 502, 'baseMind-exit')
    }
    const parsed = parseJsonText(result.stdout ?? '')
    if (!parsed.ok) {
      throw new DashboardError('BaseMind returned output the Dashboard cannot read: ' + parsed.message, 502, 'bad-json')
    }
    return parsed.value
  }

  /**
   * Read through the cache, the coalescing map and the one-at-a-time limiter.
   * @param {string} key - cache and coalescing key
   * @param {boolean} refresh - bypass a fresh cache entry
   * @param {AbortSignal | undefined} signal - client cancellation
   * @param {() => Promise<any>} loader - the actual query
   */
  async function read(key, refresh, signal, loader) {
    if (disposed) throw new DashboardError('The Dashboard service is disposed.', 503, 'disposed')
    if (refresh !== true) {
      const cached = cacheGet(key)
      if (cached !== undefined) return cached
    }
    const existing = inflight.get(key)
    if (existing !== undefined) return existing
    const promise = (async () => {
      // Acquire outside the try: a refusal (busy/aborted) must not release a slot
      // this request never held.
      await acquire(signal)
      const epoch = epochOf(key)
      try {
        if (refresh !== true) {
          const cached = cacheGet(key)
          if (cached !== undefined) return cached
        }
        const value = await loader()
        // A scan that finished while this read ran already invalidated the
        // snapshot: answer the caller, but do not cache the stale result.
        if (epochOf(key) === epoch) cacheSet(key, value)
        return value
      } finally {
        release()
      }
    })()
    inflight.set(key, promise)
    try {
      return await promise
    } finally {
      if (inflight.get(key) === promise) inflight.delete(key)
    }
  }

  function workspacePayload(workspace) {
    return { id: workspace.id, title: workspace.title, path: workspace.path, name: workspace.name }
  }

  /** The workspace catalogue plus the capability the Host can honestly claim. */
  function listWorkspaces() {
    const listed = workspaces.list()
    return {
      source: listed.source,
      items: listed.items,
      message: listed.message,
      capabilities: {
        // No reliable "current session" resolver is exposed to a Host-only
        // plugin, so the client picks the first entry and says so (plan §11).
        followCurrentSession: false,
        worktreeIdentity: 'path',
      },
    }
  }

  function jobSnapshot(job) {
    if (job === undefined) return null
    return {
      taskId: job.taskId,
      workspaceId: job.workspaceId,
      scanType: job.scanType,
      scope: [...job.scope],
      state: job.state,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
      summary: job.summary,
      error: job.error,
    }
  }

  /** The last cached `status` reply, used to report admission without a new query. */
  function admissionOf(workspacePath) {
    const cached = cacheGet(workspaceKey(workspacePath) + '|overview')
    return isPlainObject(cached?.status) ? cached.status.admission ?? null : null
  }

  async function overview(workspaceId, { refresh = false, signal } = {}) {
    const workspace = resolveWorkspace(workspaceId)
    const key = workspaceKey(workspace.path) + '|overview'
    return read(key, refresh, signal, async () => {
      const value = await runJson(workspace.path, ['status', '--json', '--root', '.'], { signal })
      const status = normalizeStatus(value)
      const job = jobs.get(workspaceKey(workspace.path))
      // A history file that cannot be read must never fail the Overview itself.
      const historyEntries = await history.read(workspace.path).catch(() => [])
      return {
        workspace: workspacePayload(workspace),
        status,
        activeScan: job !== undefined && (job.state === 'queued' || job.state === 'running') ? jobSnapshot(job) : null,
        lastDashboardScan: historyEntries[0] ?? null,
        binary: binarySummary(),
        queriedAt: isoNow(now),
        capabilities: {
          languageCounts: true,
          languageLines: false,
          lastScanFromBaseMind: false,
          progress: false,
          note: 'Overview is one read-only `basemind status --json` call. BaseMind does not report a scan timestamp, so the last scan shown is the last Dashboard-submitted one.',
        },
      }
    })
  }

  async function diagnostics(workspaceId, { signal } = {}) {
    const workspace = resolveWorkspace(workspaceId)
    const key = workspaceKey(workspace.path) + '|diagnostics'
    return read(key, true, signal, async () => {
      const doctorValue = await runJson(workspace.path, ['doctor', '--json', '--root', '.'], {
        timeoutMs: DOCTOR_TIMEOUT_MS,
        signal,
        allowNonZero: true,
      })
      const statusValue = await runJson(workspace.path, ['status', '--json', '--root', '.'], { signal })
      const doctor = normalizeDoctor(doctorValue)
      const status = normalizeStatus(statusValue)
      return {
        workspace: workspacePayload(workspace),
        plugin: { version: asText(plugin?.version), serverName: asText(plugin?.serverName) },
        binary: binarySummary(),
        doctor,
        index: { state: status.indexState, notice: status.notice, fileCount: status.fileCount, branch: status.branch, head: status.head },
        relay: typeof relay === 'function' ? relay() : null,
        queriedAt: isoNow(now),
        capabilities: {
          automaticRepair: false,
          backgroundHealthCheck: false,
          note: 'Diagnostics is read-only: `basemind doctor --json` plus `basemind status --json`. Nothing is repaired, reconnected, downloaded or re-indexed.',
        },
      }
    })
  }

  async function statistics(workspaceId, { window = 'today', signal } = {}) {
    const workspace = resolveWorkspace(workspaceId)
    const chosen = TELEMETRY_WINDOWS.includes(window) ? window : 'today'
    const key = workspaceKey(workspace.path) + '|statistics|' + chosen
    return read(key, true, signal, async () => {
      const cacheValue = await runJson(workspace.path, ['cache', 'stats', '--json', '--root', '.'], { signal })
      const telemetryValue = await runJson(workspace.path, ['admin', 'telemetry', '--window', chosen, '--json', '--root', '.'], { signal })
      return {
        workspace: workspacePayload(workspace),
        window: chosen,
        cache: normalizeCacheStats(cacheValue),
        telemetry: normalizeTelemetry(telemetryValue),
        scopes: {
          cache: 'machine-global cache directory (shared by every workspace on this machine)',
          telemetry: 'machine-global BaseMind tool telemetry; not filtered per workspace',
          processMemory: 'the short-lived BaseMind CLI process that answered this query',
        },
        queriedAt: isoNow(now),
        capabilities: {
          projectOnlyDiskUsage: false,
          daemonMemory: false,
          tokenAccounting: 'heuristic',
          note: 'Disk usage, telemetry and RSS are machine-global (or per-query-process) figures, not this project alone. Estimated tokens saved is the BaseMind heuristic against a grep+read baseline, not API billing.',
        },
      }
    })
  }

  async function scanState(workspaceId) {
    const workspace = resolveWorkspace(workspaceId)
    const key = workspaceKey(workspace.path)
    const job = jobs.get(key)
    if (job !== undefined && job.recording !== undefined) await job.recording.catch(() => undefined)
    const entries = await history.read(workspace.path).catch(() => [])
    return {
      workspace: workspacePayload(workspace),
      job: jobSnapshot(job),
      history: entries,
      historyEnabled: history.enabled === true,
      admission: admissionOf(workspace.path),
      capabilities: {
        progress: false,
        cancel: false,
        note: 'BaseMind 0.34.0 exposes no scan progress or cancel API. The Dashboard reports the job state and elapsed time of scans it submitted; admission counters come from `basemind status`.',
      },
    }
  }

  async function recordJob(job) {
    if (history.enabled !== true) return
    try {
      await history.record(job.workspacePath, {
        taskId: job.taskId,
        workspaceId: job.workspaceId,
        workspacePath: job.workspacePath,
        scanType: job.scanType,
        scope: job.scope,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        durationMs: job.durationMs,
        status: job.state,
        summary: job.summary,
        baseMindVersion: asText(binary()?.version),
        error: job.error,
      })
    } catch (error) {
      logger?.warn?.('[dsh-basemind-plugin] dashboard: the scan summary could not be stored: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  async function execute(job) {
    const key = workspaceKey(job.workspacePath)
    job.state = 'running'
    const args = job.scanType === 'full'
      ? ['scan', '--json', '--root', '.']
      : ['rescan', ...job.scope, '--json', '--root', '.']
    let result
    try {
      result = await runner.run({ binary: binary(), cwd: job.workspacePath, args, timeoutMs: SCAN_TIMEOUT_MS, signal: disposeController.signal })
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    job.finishedAt = isoNow(now)
    job.durationMs = Math.max(0, now() - Date.parse(job.startedAt))
    if (job.settled === true) return
    if (result?.ok === true) {
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0
      if (exitCode === 0) {
        const parsed = parseJsonText(result.stdout ?? '')
        if (parsed.ok) {
          job.state = 'completed'
          job.summary = normalizeScanSummary(parsed.value)
        } else {
          job.state = 'failed'
          job.error = 'BaseMind finished but its summary is unreadable: ' + parsed.message
        }
      } else {
        job.state = 'failed'
        job.error = (result.stderr ?? '').trim().split('\n').filter((line) => line !== '').slice(-2).join(' ') || 'BaseMind exited with code ' + String(exitCode) + '.'
      }
    } else {
      job.state = result?.code === 'aborted' ? 'interrupted' : 'failed'
      job.error = result?.message ?? 'The scan could not be started.'
    }
    if (job.state === 'interrupted') job.error = job.error ?? 'The plugin was disposed while the scan was running.'
    invalidate(job.workspacePath)
    jobs.set(key, job)
    job.settled = true
    // The history row is part of what the Scan page shows for this job, so a
    // reader of a finished job waits for that write instead of racing it.
    job.recording = recordJob(job)
    await job.recording
  }

  async function startScan({ workspaceId, mode, paths } = {}) {
    if (disposed) throw new DashboardError('The Dashboard service is disposed.', 503, 'disposed')
    const workspace = resolveWorkspace(workspaceId)
    const scanType = mode === 'full' ? 'full' : mode === 'incremental' ? 'incremental' : null
    if (scanType === null) throw new DashboardError('Scan mode must be "full" or "incremental".', 400, 'bad-mode')
    const key = workspaceKey(workspace.path)
    // Dashboard scans are serialised machine-wide: BaseMind shares one daemon and
    // one machine-global cache, and the upstream write scopes of two workspaces
    // cannot be proven independent here (plan §27: be conservative).
    for (const running of jobs.values()) {
      if (running.state === 'queued' || running.state === 'running') {
        throw new DashboardError(
          'A Dashboard scan is already running for ' + running.workspacePath + '; scans are serialised.',
          409,
          'scan-busy',
        )
      }
    }
    let scope = []
    if (scanType === 'incremental') {
      const normalized = normalizeScopePaths(paths)
      if (normalized.ok !== true) throw new DashboardError(normalized.message, 400, 'bad-scope')
      if (normalized.paths.length === 0) {
        throw new DashboardError('An incremental scan needs at least one repo-relative path.', 400, 'bad-scope')
      }
      scope = normalized.paths
    }
    const selected = binary()
    if (selected === undefined || selected.ok !== true) {
      throw new DashboardError(
        'No verified BaseMind binary is selected yet. Open a BaseMind session once so the plugin selects its binary, then retry.',
        503,
        'binary-unavailable',
      )
    }
    const job = {
      taskId: randomUUID(),
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      scanType,
      scope,
      state: 'queued',
      startedAt: isoNow(now),
      finishedAt: null,
      durationMs: null,
      summary: null,
      error: null,
    }
    jobs.set(key, job)
    if (jobs.size > MAX_JOBS) {
      for (const [name, candidate] of jobs) {
        if (jobs.size <= MAX_JOBS) break
        if (candidate.state !== 'queued' && candidate.state !== 'running') jobs.delete(name)
      }
    }
    const submitted = jobSnapshot(job)
    void execute(job)
    return submitted
  }

  /** Terminate Dashboard-owned work; submitted daemon scans are left to BaseMind. */
  async function dispose() {
    if (disposed) return
    disposed = true
    disposeController.abort()
    while (queue.length > 0) {
      const waiter = queue.shift()
      waiter?.reject(new DashboardError('The Dashboard service is disposed.', 503, 'disposed'))
    }
    for (const job of jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') {
        job.state = 'interrupted'
        job.finishedAt = isoNow(now)
        job.durationMs = Math.max(0, now() - Date.parse(job.startedAt))
        job.error = 'The plugin was disposed while this scan was running.'
        job.settled = true
        job.recording = recordJob(job)
        await job.recording
      }
    }
    snapshots.clear()
  }

  return {
    listWorkspaces,
    overview,
    diagnostics,
    statistics,
    scanState,
    startScan,
    dispose,
    historyLimit: HISTORY_LIMIT,
  }
}
