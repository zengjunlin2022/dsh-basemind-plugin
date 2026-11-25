/**
 * Bounded, atomic scan-history storage for the Dashboard.
 *
 * Only scans the Dashboard itself submitted are recorded (plan §32). The file
 * lives in the plugin's own cache directory (`$DSH_HOME/cache/dsh-basemind-plugin`),
 * never in the repository or in BaseMind's index. `dashboardHistory: false`
 * turns every read and write into a no-op (AGENTS.md: a cache-writing surface
 * must be switchable off).
 *
 * @module dsh-basemind-plugin/lib/dashboard/history
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { HISTORY_LIMIT, MAX_SCOPE_PATHS, asCount, asText, asObject } from './contracts.js'

const SCHEMA_VERSION = 1
const MAX_WORKSPACES = 50

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Stable map key for one canonical workspace path (Windows paths are case-insensitive). */
export function workspaceKey(workspacePath) {
  const text = String(workspacePath ?? '')
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/** Validate one stored entry; anything malformed is dropped, never repaired into a fake row. */
function readEntry(raw) {
  const input = asObject(raw)
  const taskId = asText(input.taskId)
  const scanType = input.scanType === 'full' || input.scanType === 'incremental' ? input.scanType : null
  const status = asText(input.status)
  if (taskId === null || scanType === null || status === null) return undefined
  const scopeRaw = Array.isArray(input.scope) ? input.scope : []
  const summary = isPlainObject(input.summary) ? input.summary : null
  return {
    taskId,
    workspaceId: asText(input.workspaceId),
    workspacePath: asText(input.workspacePath),
    scanType,
    scope: scopeRaw.filter((item) => typeof item === 'string').slice(0, MAX_SCOPE_PATHS),
    startedAt: asText(input.startedAt),
    finishedAt: asText(input.finishedAt),
    durationMs: asCount(input.durationMs),
    status,
    summary,
    baseMindVersion: asText(input.baseMindVersion),
    error: asText(input.error),
  }
}

/**
 * Create the history store.
 * @param {{ root: string, enabled?: boolean, limit?: number, logger?: any }} options
 */
export function createScanHistory({ root, enabled = true, limit = HISTORY_LIMIT, logger } = {}) {
  const file = path.join(root, 'dashboard-history.json')
  const cap = Math.max(1, Math.min(HISTORY_LIMIT, Math.trunc(limit)))
  let cache
  let writeChain = Promise.resolve()

  async function load() {
    if (!enabled) return { version: SCHEMA_VERSION, workspaces: {} }
    if (cache !== undefined) return cache
    try {
      const text = await fsp.readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      const workspaces = {}
      const source = isPlainObject(parsed) && isPlainObject(parsed.workspaces) ? parsed.workspaces : {}
      for (const key of Object.keys(source)) {
        const entriesRaw = Array.isArray(source[key]) ? source[key] : []
        const entries = entriesRaw.map(readEntry).filter((entry) => entry !== undefined).slice(0, cap)
        if (entries.length > 0) workspaces[key] = entries
      }
      cache = { version: SCHEMA_VERSION, workspaces }
      return cache
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.('[dsh-basemind-plugin] dashboard: scan history could not be read: ' + message(error))
      }
      cache = { version: SCHEMA_VERSION, workspaces: {} }
      return cache
    }
  }

  async function persist(state) {
    if (!enabled) return
    const temporary = file + '.tmp-' + String(process.pid)
    await fsp.mkdir(root, { recursive: true })
    await fsp.writeFile(temporary, JSON.stringify(state, null, 1), 'utf8')
    await fsp.rename(temporary, file)
  }

  /** Read the finished scans of one workspace, newest first. */
  async function read(workspacePath) {
    const state = await load()
    return state.workspaces[workspaceKey(workspacePath)] ?? []
  }

  /**
   * Append one finished scan and keep the newest `limit` entries.
   * @returns the workspace's entries after the write (newest first).
   */
  async function record(workspacePath, entry) {
    if (!enabled) return []
    const validated = readEntry(entry)
    if (validated === undefined) throw new Error('dashboard: refusing a malformed scan-history entry')
    const key = workspaceKey(workspacePath)
    const run = writeChain.then(async () => {
      const state = await load()
      const entries = [validated, ...(state.workspaces[key] ?? [])].slice(0, cap)
      const keys = Object.keys(state.workspaces)
      const workspaces = { ...state.workspaces, [key]: entries }
      if (!keys.includes(key) && keys.length >= MAX_WORKSPACES) {
        // Evict the least recently written workspace, keeping the map bounded.
        const ordered = keys.map((name) => ({ name, at: workspaces[name]?.[0]?.finishedAt ?? '' }))
        ordered.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        for (const victim of ordered.slice(0, keys.length - MAX_WORKSPACES + 1)) delete workspaces[victim.name]
      }
      const next = { version: SCHEMA_VERSION, workspaces }
      await persist(next)
      cache = next
      return entries
    })
    writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return { enabled, file, read, record }
}
