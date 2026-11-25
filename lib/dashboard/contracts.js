/**
 * Dashboard data contracts: pure normalisers from BaseMind CLI JSON to bounded,
 * UI-ready shapes, plus the input validators the routes rely on.
 *
 * Every function here is deterministic and side-effect free: no spawn, no fs, no
 * clock. Unknown fields become `null` (never `0`), because the Dashboard must not
 * present a missing value as a measured zero (plan §22, §24).
 *
 * The shapes were verified against BaseMind 0.34.0 in an isolated data home:
 * `status --json`, `overview --json`, `doctor --json`, `cache stats --json`,
 * `admin telemetry --json`, `scan --json` and `rescan --json`.
 *
 * @module dsh-basemind-plugin/lib/dashboard/contracts
 */

/** Finished scan summaries kept per workspace (plan §32). */
export const HISTORY_LIMIT = 10

/** Upper bound of repo-relative paths one incremental scan may name. */
export const MAX_SCOPE_PATHS = 256

/** Telemetry windows BaseMind 0.34.0 accepts. */
export const TELEMETRY_WINDOWS = Object.freeze(['today', '1h', '24h', 'all'])

/** Health states the UI renders. Never invented: each maps to observed evidence. */
export const INDEX_STATES = Object.freeze([
  'ready',
  'not-indexed',
  'degraded',
  'error',
  'unknown',
])

/** Scan lifecycle states (plan §28). `cancelled` is absent: v1 has no cancel. */
export const SCAN_STATES = Object.freeze(['queued', 'running', 'completed', 'failed', 'interrupted'])

/** A finite number, or null. */
export function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A non-empty string, or null. */
export function asText(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A plain object, or an empty one. */
export function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** A finite non-negative integer, or null. */
export function asCount(value) {
  const number = asNumber(value)
  return number !== null && number >= 0 ? Math.trunc(number) : null
}

/**
 * Parse one stdout payload as JSON.
 * @returns `{ ok: true, value }` or `{ ok: false, message }` (never throws).
 */
export function parseJsonText(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, message: 'empty output' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: 'output is not JSON: ' + detail }
  }
}

/**
 * Map `status --json` to the Overview contract.
 *
 * `notice.state === 'empty_index'` is BaseMind's own marker for "nothing has been
 * scanned for this workspace"; it is the only not-indexed evidence the CLI offers.
 */
export function normalizeStatus(raw) {
  const input = asObject(raw)
  const noticeInput = input.notice !== null && typeof input.notice === 'object' ? asObject(input.notice) : null
  const noticeState = noticeInput === null ? null : asText(noticeInput.state)
  const fileCount = asCount(input.file_count)

  const languagesInput = asObject(input.languages)
  const languages = []
  for (const name of Object.keys(languagesInput).sort()) {
    const files = asCount(languagesInput[name])
    if (files === null) continue
    languages.push({
      language: name,
      files,
      share: fileCount !== null && fileCount > 0 ? files / fileCount : null,
    })
  }

  const largeFilesInput = asObject(input.large_files)
  const mostImportedRaw = Array.isArray(input.most_imported) ? input.most_imported : []
  const mostImported = mostImportedRaw
    .map((row) => ({ path: asText(asObject(row).path), importers: asCount(asObject(row).importers) }))
    .filter((row) => row.path !== null && row.importers !== null)

  const admissionInput = asObject(input.admission)
  const heavy = asObject(admissionInput.heavy)
  const medium = asObject(admissionInput.medium)

  return {
    root: asText(input.root),
    branch: asText(input.branch),
    head: asText(input.head_short_sha),
    indexState: noticeState === 'empty_index' ? 'not-indexed' : 'ready',
    fileCount,
    blobCount: asCount(input.blob_count),
    totalSizeBytes: asCount(input.total_size_bytes),
    languages,
    largeFiles: {
      thresholdLines: asCount(largeFilesInput.threshold_lines),
      count: asCount(largeFilesInput.count),
    },
    mostImported,
    notice: noticeInput === null
      ? null
      : { state: noticeState, message: asText(noticeInput.message), retry: noticeInput.retry === true },
    admission: {
      heavyInUse: asCount(heavy.in_use),
      heavyLimit: asCount(heavy.limit),
      heavyQueued: asCount(heavy.queued),
      mediumInUse: asCount(medium.in_use),
      mediumLimit: asCount(medium.limit),
      mediumQueued: asCount(medium.queued),
      queueWaitMs: asCount(admissionInput.queue_wait_ms),
    },
  }
}

/**
 * Map `overview --json` to the language-detail contract. Costlier than `status`
 * (it reads the index shape), so the UI asks for it only when a page needs it.
 */
export function normalizeOverview(raw) {
  const input = asObject(raw)
  const languagesRaw = Array.isArray(input.languages) ? input.languages : []
  const languages = languagesRaw
    .map((row) => {
      const item = asObject(row)
      return {
        language: asText(item.language),
        files: asCount(item.files),
        lines: asCount(item.lines),
        bytes: asCount(item.bytes),
      }
    })
    .filter((row) => row.language !== null)
  return {
    fileCount: asCount(input.files),
    lineCount: asCount(input.lines),
    totalSizeBytes: asCount(input.bytes),
    languages,
  }
}

/** Map `doctor --json`: one verdict per check, preserving BaseMind's own wording. */
export function normalizeDoctor(raw) {
  const input = asObject(raw)
  const checksRaw = Array.isArray(input.checks) ? input.checks : []
  const checks = checksRaw.map((row) => {
    const item = asObject(row)
    return {
      name: asText(item.check) ?? 'unknown',
      status: asText(item.status) ?? 'unknown',
      detail: asText(item.detail),
    }
  })
  return {
    ok: input.ok === true,
    checks,
    failing: checks.filter((check) => check.status !== 'ok'),
  }
}

/** Map `cache stats --json`; keeps the components BaseMind actually reported. */
export function normalizeCacheStats(raw) {
  const input = asObject(raw)
  const components = [
    ['blobs', asCount(input.blobs_bytes)],
    ['blobsCurrent', asCount(input.blobs_current_bytes)],
    ['views', asCount(input.views_bytes)],
    ['groupIndex', asCount(input.group_index_bytes)],
    ['documents', asCount(input.lance_bytes)],
    ['memoryVectors', asCount(input.memory_vectors_bytes)],
    ['gitCache', asCount(input.git_cache_bytes)],
    ['gitHistory', asCount(input.git_history_bytes)],
    ['telemetry', asCount(input.telemetry_bytes)],
    ['repoGroups', asCount(input.repo_groups_bytes)],
    ['other', asCount(input.other_bytes)],
  ]
    .filter(([, bytes]) => bytes !== null)
    .map(([name, bytes]) => ({ name, bytes }))
  const viewsRaw = Array.isArray(input.per_view_file_count) ? input.per_view_file_count : []
  return {
    totalBytes: asCount(input.total_bytes),
    components,
    blobCount: asCount(input.blob_count),
    orphanBlobCount: asCount(input.orphan_blob_count),
    blobAccountingOk: input.blob_accounting_ok === true,
    repoGroups: asCount(input.repo_groups),
    legacyIndexes: asCount(input.legacy_indexes),
    lastGc: asText(input.last_gc),
    views: viewsRaw
      .map((row) => {
        const item = asObject(row)
        return { view: asText(item.view), files: asCount(item.files) }
      })
      .filter((row) => row.view !== null),
    // These are the RSS of the short-lived CLI process that produced this reply,
    // not the shared daemon's and not project-only memory (plan §35).
    cliProcessRssBytes: asCount(input.rss_bytes),
    cliProcessPeakRssBytes: asCount(input.peak_rss_bytes),
  }
}

/** Map `admin telemetry --json`; `truncated` is surfaced, never hidden. */
export function normalizeTelemetry(raw) {
  const input = asObject(raw)
  const perToolRaw = Array.isArray(input.per_tool) ? input.per_tool : []
  const perTool = perToolRaw
    .map((row) => {
      const item = asObject(row)
      return {
        tool: asText(item.tool),
        calls: asCount(item.calls),
        estTokensSaved: asCount(item.est_tokens_saved),
      }
    })
    .filter((row) => row.tool !== null)
  const perBaselineRaw = Array.isArray(input.per_baseline) ? input.per_baseline : []
  const perBaseline = perBaselineRaw
    .map((row) => {
      const item = asObject(row)
      return { baseline: asText(item.baseline), calls: asCount(item.calls) }
    })
    .filter((row) => row.baseline !== null)
  return {
    window: asText(input.window),
    totalCalls: asCount(input.total_calls),
    totalResponseBytes: asCount(input.total_resp_bytes),
    estimatedTokensSaved: asCount(input.total_est_tokens_saved),
    perTool,
    perBaseline,
    truncated: input.truncated === true,
    note: asText(input.savings_note),
  }
}

/** Map `scan --json` / `rescan --json`: the operation's own summary, never a diff. */
export function normalizeScanSummary(raw) {
  const input = asObject(raw)
  return {
    scanned: asCount(input.scanned),
    updated: asCount(input.updated),
    removed: asCount(input.removed),
    skippedUnchanged: asCount(input.skipped_unchanged),
    skippedNoLanguage: asCount(input.skipped_no_lang),
    docsIndexed: asCount(input.docs_indexed),
    docsDegraded: asCount(input.docs_degraded),
    docsTextFallback: asCount(input.docs_text_fallback),
    docTimeouts: asCount(input.doc_timeouts),
    extractFailed: asCount(input.extract_failed),
    elapsedMs: asCount(input.elapsed_ms),
    root: asText(input.root),
  }
}

/**
 * Reject anything that is not a repo-relative path inside the workspace.
 *
 * The Host never trusts a client-supplied absolute path (plan §17): the caller
 * passes the workspace root it already resolved from the registry, and this
 * function only admits relative, existing-by-construction entries that do not
 * climb out. BaseMind re-validates the same paths server-side before scanning.
 *
 * @param {string[]} paths - client-supplied scope entries.
 * @returns {{ ok: true, paths: string[] } | { ok: false, message: string }}
 */
export function normalizeScopePaths(paths) {
  if (!Array.isArray(paths)) return { ok: false, message: 'scope paths must be an array of strings' }
  if (paths.length > MAX_SCOPE_PATHS) return { ok: false, message: 'at most ' + String(MAX_SCOPE_PATHS) + ' scope paths are allowed' }
  const normalized = []
  for (const entry of paths) {
    if (typeof entry !== 'string') return { ok: false, message: 'scope paths must be strings' }
    const trimmed = entry.trim().replace(/\\/g, '/')
    if (trimmed === '') return { ok: false, message: 'scope path entries must be non-empty' }
    if (trimmed.length > 512) return { ok: false, message: 'scope path is too long: ' + trimmed.slice(0, 40) + '…' }
    // A leading dash would be parsed by BaseMind's argument parser as a flag
    // (for example --rebuild-git-history), turning one incremental scan into a
    // different operation; NUL cannot appear in a path at all (plan §17).
    if (trimmed.startsWith('-')) return { ok: false, message: 'scope path must not start with a dash: ' + trimmed }
    if (trimmed.includes('\u0000')) return { ok: false, message: 'scope path must not contain NUL' }
    if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('~')) {
      return { ok: false, message: 'scope path must be repo-relative: ' + trimmed }
    }
    const segments = trimmed.split('/')
    if (segments.some((segment) => segment === '..')) {
      return { ok: false, message: 'scope path must stay inside the workspace: ' + trimmed }
    }
    const withoutDot = segments.filter((segment) => segment !== '.' && segment !== '')
    if (withoutDot.length === 0) return { ok: false, message: 'scope path must not name the workspace root: ' + trimmed }
    const canonical = withoutDot.join('/')
    // The entry that reaches argv is the normalised one, so the flag and NUL
    // checks must run on it too: './-x' only grows its leading dash after the
    // '.' segment is dropped.
    if (canonical.startsWith('-')) return { ok: false, message: 'scope path must not start with a dash: ' + canonical }
    if (canonical.includes('\u0000')) return { ok: false, message: 'scope path must not contain NUL' }
    normalized.push(canonical)
  }
  return { ok: true, paths: [...new Set(normalized)] }
}
