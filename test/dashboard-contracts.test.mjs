import assert from 'node:assert/strict'
import test from 'node:test'

import {
  asCount,
  normalizeCacheStats,
  normalizeDoctor,
  normalizeOverview,
  normalizeScanSummary,
  normalizeScopePaths,
  normalizeStatus,
  normalizeTelemetry,
  parseJsonText,
} from '../lib/dashboard/contracts.js'

const STATUS = {
  file_count: 120,
  blob_count: 118,
  total_size_bytes: 802_816,
  languages: { javascript: 90, typescript: 30 },
  large_files: { threshold_lines: 2000, count: 2, largest: [] },
  most_imported: [{ path: 'src/base.js', importers: 40 }],
  cache_dir: 'C:/cache/x',
  grammar_dir: 'C:/grammars',
  schema_version: 34,
  root: 'C:/repo',
  config_stamp: 'absent',
  branch: 'main',
  head_sha: 'abcdef0123456789',
  head_short_sha: 'abcdef0',
  elapsed_us: 1893,
  admission: { heavy: { limit: 4, in_use: 0, queued: 0 }, medium: { limit: 8, in_use: 0, queued: 0 }, queue_wait_ms: 2000 },
}

test('normalizeStatus maps a scanned workspace and computes a share only with a denominator', () => {
  const status = normalizeStatus(STATUS)
  assert.equal(status.indexState, 'ready')
  assert.equal(status.fileCount, 120)
  assert.equal(status.blobCount, 118)
  assert.equal(status.totalSizeBytes, 802_816)
  assert.deepEqual(status.languages, [
    { language: 'javascript', files: 90, share: 90 / 120 },
    { language: 'typescript', files: 30, share: 30 / 120 },
  ])
  assert.deepEqual(status.mostImported, [{ path: 'src/base.js', importers: 40 }])
  assert.equal(status.branch, 'main')
  assert.equal(status.head, 'abcdef0')
  assert.equal(status.notice, null)
  assert.equal(status.admission.heavyLimit, 4)
})

test('a missing count is null, never 0', () => {
  const status = normalizeStatus({})
  assert.equal(status.fileCount, null)
  assert.equal(status.blobCount, null)
  assert.equal(status.totalSizeBytes, null)
  assert.deepEqual(status.languages, [])
  assert.equal(status.indexState, 'ready')
})

test('an empty index is reported as not-indexed from BaseMind own notice', () => {
  const status = normalizeStatus({ file_count: 0, notice: { state: 'empty_index', message: 'nothing scanned', retry: true } })
  assert.equal(status.indexState, 'not-indexed')
  assert.equal(status.fileCount, 0)
  assert.deepEqual(status.notice, { state: 'empty_index', message: 'nothing scanned', retry: true })
})

test('languages without a file count get no share', () => {
  const status = normalizeStatus({ languages: { rust: 3 } })
  assert.deepEqual(status.languages, [{ language: 'rust', files: 3, share: null }])
})

test('normalizeOverview reads the language detail BaseMind reports', () => {
  const overview = normalizeOverview({ files: 2, lines: 3, bytes: 102, languages: [{ language: 'javascript', files: 2, lines: 3, bytes: 102 }] })
  assert.equal(overview.fileCount, 2)
  assert.equal(overview.lineCount, 3)
  assert.deepEqual(overview.languages, [{ language: 'javascript', files: 2, lines: 3, bytes: 102 }])
})

test('normalizeDoctor preserves the failing checks and BaseMind wording', () => {
  const doctor = normalizeDoctor({
    ok: false,
    checks: [
      { check: 'version', status: 'ok', detail: '0.34.0' },
      { check: 'root', status: 'FAIL', detail: 'refusing to use C:/x' },
      { check: 'index', status: 'warn', detail: 'no index yet' },
    ],
  })
  assert.equal(doctor.ok, false)
  assert.equal(doctor.checks.length, 3)
  assert.deepEqual(doctor.failing.map((check) => check.name), ['root', 'index'])
})

test('normalizeCacheStats keeps named components and labels the CLI process memory', () => {
  const stats = normalizeCacheStats({
    blobs_bytes: 10,
    views_bytes: 20,
    telemetry_bytes: 5,
    total_bytes: 35,
    blob_count: 2,
    orphan_blob_count: 0,
    blob_accounting_ok: true,
    rss_bytes: 84_230_144,
    peak_rss_bytes: 84_230_144,
    per_view_file_count: [{ view: 'working', files: 2 }],
  })
  assert.equal(stats.totalBytes, 35)
  assert.deepEqual(stats.components, [
    { name: 'blobs', bytes: 10 },
    { name: 'views', bytes: 20 },
    { name: 'telemetry', bytes: 5 },
  ])
  assert.equal(stats.cliProcessPeakRssBytes, 84_230_144)
  assert.deepEqual(stats.views, [{ view: 'working', files: 2 }])
})

test('normalizeTelemetry keeps the truncation flag and the estimate note', () => {
  const telemetry = normalizeTelemetry({
    window: '24h',
    total_calls: 12,
    total_resp_bytes: 900,
    total_est_tokens_saved: 42,
    per_tool: [{ tool: 'code_outline', calls: 12, est_tokens_saved: 42 }],
    per_baseline: [{ baseline: 'no_baseline', calls: 12 }],
    truncated: true,
    savings_note: 'Savings are estimates vs a grep+Read baseline',
  })
  assert.equal(telemetry.totalCalls, 12)
  assert.equal(telemetry.estimatedTokensSaved, 42)
  assert.equal(telemetry.truncated, true)
  assert.match(telemetry.note, /estimates/)
  assert.deepEqual(telemetry.perTool, [{ tool: 'code_outline', calls: 12, estTokensSaved: 42 }])
})

test('normalizeScanSummary reads the scan operation summary', () => {
  const summary = normalizeScanSummary({
    scanned: 3,
    updated: 2,
    removed: 0,
    skipped_unchanged: 0,
    skipped_no_lang: 1,
    docs_indexed: 1,
    elapsed_ms: 32_421,
    root: '\\\\?\\C:\\ws',
  })
  assert.equal(summary.scanned, 3)
  assert.equal(summary.updated, 2)
  assert.equal(summary.skippedNoLanguage, 1)
  assert.equal(summary.elapsedMs, 32_421)
})

test('parseJsonText never throws and refuses an empty payload', () => {
  assert.deepEqual(parseJsonText('{"a":1}'), { ok: true, value: { a: 1 } })
  assert.equal(parseJsonText('').ok, false)
  assert.equal(parseJsonText('not json').ok, false)
})

test('asCount refuses negatives and non-numbers', () => {
  assert.equal(asCount(3), 3)
  assert.equal(asCount(-1), null)
  assert.equal(asCount('3'), null)
  assert.equal(asCount(1.7), 1)
})

test('normalizeScopePaths admits repo-relative paths only', () => {
  assert.deepEqual(normalizeScopePaths(['src/a.js', 'src\\b.js', './src/c.js', 'src/a.js']), {
    ok: true,
    paths: ['src/a.js', 'src/b.js', 'src/c.js'],
  })
  // A scope entry is an operand, never a flag: BaseMind's parser would accept
  // --rebuild-git-history (a destructive git-history rebuild) as one.
  // './' is stripped before the entry reaches argv, so these are flags too.
  for (const flagLike of [['--rebuild-git-history'], ['-x'], ['--view', 'staged'], ['-'], ['./-x'], ['./--rebuild-git-history'], ['./-']]) {
    assert.equal(normalizeScopePaths(flagLike).ok, false, 'expected ' + JSON.stringify(flagLike) + ' to be refused')
  }
  assert.equal(normalizeScopePaths(['src/a\u0000b.js']).ok, false)
  for (const bad of [['/etc/passwd'], ['C:\\outside.js'], ['../outside.js'], ['src/../../outside.js'], ['.'], ['~'], [''], [12]]) {
    assert.equal(normalizeScopePaths(bad).ok, false, 'expected ' + JSON.stringify(bad) + ' to be refused')
  }
  assert.deepEqual(normalizeScopePaths([]), { ok: true, paths: [] })
  assert.equal(normalizeScopePaths('src/a.js').ok, false)
  const tooMany = Array.from({ length: 257 }, (_, index) => 'src/file' + String(index) + '.js')
  assert.match(normalizeScopePaths(tooMany).message, /at most 256/)
})
