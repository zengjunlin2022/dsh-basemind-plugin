/**
 * Human-readable BaseMind status snapshot for the `/basemind-status` command.
 *
 * The snapshot is rendered as plain lines: deterministic, no ANSI, no timestamps
 * and never any environment values. The only asynchronous step is an optional
 * first probe (`manager.ensureStatus()`) bounded to 5 s, so a hanging
 * `--version` probe can never block the command for longer than that.
 *
 * @module dsh-basemind-plugin/lib/status
 */

import pkg from '../package.json' with { type: 'json' }
import { UPSTREAM, assetFor } from './upstream.js'

/** Upper bound for the optional first probe triggered by the command. */
const PROBE_BUDGET_MS = 5000

/** Hard maximum width of one rendered line. */
const MAX_LINE = 100

/** Width of the padded label column. */
const LABEL_WIDTH = 17

/** Control characters that must never reach the terminal. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** KEY=value / TOKEN: value fragments that could leak a credential. */
const SECRET_ASSIGNMENT = /(KEY|TOKEN|PASSWORD|SECRET)(\s*[=:]\s*)\S+/gi

/** ?token=value fragments that could leak a credential. */
const SECRET_QUERY = /([?&](?:key|token|password|secret)=)[^&\s]+/gi

/**
 * @param {unknown} value
 * @returns {boolean} true for object literals only.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** @param {unknown} error @returns {string} a short message for a thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Make a dynamic value safe for one rendered line: drop control characters,
 * redact credential-looking fragments, collapse whitespace and trim.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitize(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(CONTROL_CHARS, ' ')
    .replace(SECRET_ASSIGNMENT, '$1$2<redacted>')
    .replace(SECRET_QUERY, '$1<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {string} label
 * @param {string} value
 * @param {{ keepTail?: boolean }} [options]
 * @returns {string} one report line, never wider than MAX_LINE.
 */
function formatLine(label, value, options) {
  const keepTail = options !== undefined && options.keepTail === true
  const prefix = '  ' + label.padEnd(LABEL_WIDTH) + ': '
  const room = Math.max(8, MAX_LINE - prefix.length)
  const text = String(value === undefined || value === null ? '' : value)
  let fitted
  if (text.length <= room) fitted = text
  else if (keepTail) fitted = '...' + text.slice(text.length - (room - 3))
  else fitted = text.slice(0, room - 3) + '...'
  return prefix + fitted
}

/**
 * Shorten a long path while keeping both its head and its tail.
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
function shortenPath(value, max) {
  if (value.length <= max) return value
  const head = Math.max(8, Math.floor((max - 3) / 3))
  const tail = Math.max(4, max - 3 - head)
  return value.slice(0, head) + '...' + value.slice(value.length - tail)
}

/**
 * Final safety net: every line stays within MAX_LINE characters.
 * @param {string[]} lines
 * @returns {string[]}
 */
function fitLines(lines) {
  return lines.map((line) => (line.length <= MAX_LINE ? line : line.slice(0, MAX_LINE - 3) + '...'))
}

/**
 * Resolve a value while guaranteeing the caller is released within ms.
 * @template T
 * @param {Promise<T>|T} value
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(value, ms) {
  /** @type {NodeJS.Timeout|undefined} */
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('the status probe did not finish within ' + ms + ' ms'))
    }, ms)
  })
  return Promise.race([Promise.resolve(value), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * @param {unknown} config
 * @returns {'exact'|'minor'|'any'}
 */
function readPolicy(config) {
  const policy = isPlainObject(config) ? config.binaryPolicy : undefined
  return policy === 'minor' || policy === 'any' ? policy : 'exact'
}

/**
 * @param {string} os
 * @param {string} arch
 * @returns {string} a readable platform key used only for display.
 */
function displayKey(os, arch) {
  const name = os === 'win32' ? 'windows' : os
  return typeof arch === 'string' && arch !== '' ? name + '-' + arch : name
}

/**
 * Normalize a platform string: an OS name gains the process architecture, while
 * a pre-built target key (for example `windows-x64`) is kept as-is.
 * @param {string} value
 * @returns {string}
 */
function normalizePlatformKey(value) {
  if (value.indexOf('-') !== -1) return value
  if (value === 'win32' || value === 'windows' || value === 'darwin' || value === 'linux') {
    return displayKey(value, process.arch)
  }
  return value
}

/**
 * Derive the display facts for the running platform.
 *
 * The caller may pass the resolved target from lib/binary/platform.js
 * (key, triple), a raw `process.platform` string, the platform/arch pair, an
 * explicit `{ unsupported: true }`, or a plain key string. The binary manager's
 * own snapshot fills in the resolved key, the unsupported reason and the triple.
 * Nothing here decides compatibility: that answer comes from the manager.
 *
 * @param {unknown} input
 * @param {unknown} [managerStatus]
 * @returns {{ key: string|undefined, triple: string|undefined, unsupported: boolean,
 *             reason: string|undefined, display: string }}
 */
function platformFacts(input, managerStatus) {
  const raw = isPlainObject(input) ? input : {}
  const status = isPlainObject(managerStatus) ? managerStatus : {}
  const platformName = typeof raw.platform === 'string' ? raw.platform : undefined
  const arch = typeof raw.arch === 'string' ? raw.arch : process.arch
  let key
  if (typeof raw.key === 'string' && raw.key !== '') key = raw.key
  else if (typeof raw.target === 'string' && raw.target !== '') key = raw.target
  else if (typeof input === 'string' && input !== '') key = normalizePlatformKey(input)
  else if (platformName !== undefined) key = displayKey(platformName, arch)

  // The manager's resolved target key is authoritative when it has one.
  if (typeof status.platform === 'string' && status.platform !== '') key = status.platform

  let triple = typeof raw.triple === 'string' && raw.triple !== '' ? raw.triple : undefined
  if (triple === undefined && key !== undefined) {
    const asset = assetFor(key)
    if (asset !== undefined) triple = asset.triple
  }

  let reason = typeof raw.reason === 'string' && raw.reason.trim() !== '' ? raw.reason : undefined
  let unsupported =
    raw.unsupported === true || typeof raw.unsupported === 'string' || raw.supported === false
  if (typeof status.unsupported === 'string' && status.unsupported !== '') {
    unsupported = true
    if (reason === undefined) reason = status.unsupported
  } else if (status.unsupported === true) {
    unsupported = true
  }

  let display = 'unknown'
  if (unsupported) display = 'unsupported (' + (key === undefined ? 'unknown' : key) + ')'
  else if (key !== undefined) display = triple === undefined ? key : key + ' (' + triple + ')'

  return { key, triple, unsupported, reason, display }
}

/**
 * Read the manager snapshot without ever throwing.
 *
 * The cheap cached snapshot is taken first: it reports an unsupported platform or
 * an existing selection, and in both cases no probe is needed. `ensureStatus`
 * (when present) is then bounded to 5 s by this module as well.
 *
 * @param {unknown} manager
 * @param {{ unsupported?: boolean }} [facts]
 * @returns {Promise<{ status: Record<string, unknown>|undefined, error: string|undefined }>}
 */
async function readManagerStatus(manager, facts) {
  if (manager === undefined || manager === null) {
    return { status: undefined, error: undefined }
  }
  if (isPlainObject(facts) && facts.unsupported === true) {
    return { status: undefined, error: undefined }
  }

  let cached
  try {
    if (typeof manager.status === 'function') {
      const value = await manager.status()
      cached = isPlainObject(value) ? value : undefined
    }
  } catch {
    cached = undefined
  }

  const settled =
    cached !== undefined &&
    (typeof cached.unsupported === 'string' || cached.selection !== undefined)
  if (settled || typeof manager.ensureStatus !== 'function') {
    return { status: cached, error: undefined }
  }

  try {
    const value = await withTimeout(manager.ensureStatus(), PROBE_BUDGET_MS)
    return { status: isPlainObject(value) ? value : cached, error: undefined }
  } catch (error) {
    // A failed probe must still render the cached selection when one exists.
    return { status: cached, error: describe(error) }
  }
}

/** @returns {unknown} the first value that is neither undefined nor null. */
function firstDefined() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = arguments[index]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * Normalize a partial report into every field the renderer reads.
 * @param {unknown} input
 * @param {{ pluginVersion?: string, platformFacts?: object }} [context]
 * @returns {Record<string, any>}
 */
function normalizeReport(input, context) {
  const raw = isPlainObject(input) ? input : {}
  const options = context !== undefined && context !== null ? context : {}
  const policy = readPolicy({ binaryPolicy: raw.policy })
  const facts = options.platformFacts !== undefined ? options.platformFacts : platformFacts(undefined)

  const cacheRaw = isPlainObject(raw.cache) ? raw.cache : {}
  const cache = {
    root: typeof cacheRaw.root === 'string' && cacheRaw.root !== '' ? cacheRaw.root : undefined,
    target:
      typeof cacheRaw.target === 'string' && cacheRaw.target !== '' ? cacheRaw.target : undefined,
    present: cacheRaw.present === true,
    valid: cacheRaw.valid === true,
    layout: Number.isInteger(cacheRaw.layout) ? cacheRaw.layout : undefined,
    fileCount: Number.isFinite(cacheRaw.fileCount) ? Number(cacheRaw.fileCount) : undefined,
    missingFile: sanitize(cacheRaw.missingFile) || undefined,
    parkedTree: sanitize(cacheRaw.parkedTree) || undefined,
  }

  const downloadRaw = isPlainObject(raw.download) ? raw.download : {}
  const download = {
    enabled: isPlainObject(raw.download) ? raw.download.enabled !== false : true,
    state: typeof downloadRaw.state === 'string' ? downloadRaw.state : 'idle',
    attempts: Number.isFinite(downloadRaw.attempts) ? downloadRaw.attempts : 0,
    lastError: sanitize(downloadRaw.lastError) || undefined,
  }

  let pluginVersion = 'unknown'
  if (typeof raw.pluginVersion === 'string' && raw.pluginVersion !== '') pluginVersion = raw.pluginVersion
  else if (typeof options.pluginVersion === 'string' && options.pluginVersion !== '') pluginVersion = options.pluginVersion
  else if (isPlainObject(pkg) && typeof pkg.version === 'string') pluginVersion = pkg.version

  const expected =
    typeof raw.expected === 'string' && raw.expected !== '' ? raw.expected : UPSTREAM.version

  return {
    pluginVersion,
    expected,
    policy,
    platform: typeof raw.platform === 'string' && raw.platform !== '' ? raw.platform : facts.display,
    present: raw.present === true,
    path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : undefined,
    found: typeof raw.found === 'string' && raw.found !== '' ? raw.found : undefined,
    compatible: raw.compatible === true,
    source: typeof raw.source === 'string' && raw.source !== '' ? raw.source : undefined,
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.filter((reason) => typeof reason === 'string' && reason.trim() !== '').map(sanitize)
      : [],
    cache,
    download,
    platformUnsupported: raw.platformUnsupported === true || facts.unsupported === true,
  }
}

/**
 * @param {ReturnType<typeof normalizeReport>} report
 * @returns {string} the one-line download summary.
 */
function downloadLine(report) {
  const download = report.download
  const flag = 'binaryDownload=' + (download.enabled ? 'true' : 'false')
  let suffix = ''
  if (download.enabled) {
    if (download.state === 'running') suffix = ' - download in progress'
    else if (download.state === 'cooldown') {
      suffix = ' - backing off after a failed attempt' +
        (download.lastError ? ' (' + download.lastError + ')' : '')
    }
    else if (download.state === 'failed') {
      suffix = ' - last attempt failed' + (download.lastError ? ' (' + download.lastError + ')' : '')
    }
  }
  return (download.enabled ? 'enabled' : 'disabled') + ' (' + flag + ')' + suffix
}

/**
 * Actionable guidance for the current state.
 * @param {ReturnType<typeof normalizeReport>} report
 * @returns {string[]}
 */
function guidance(report) {
  const expected = report.expected
  const releases = 'https://github.com/' + UPSTREAM.repository + '/releases'
  const repository = 'https://github.com/' + UPSTREAM.repository
  const reason = report.reasons.join(' ')

  if (report.compatible) {
    return ['- No action needed: the selected binary matches binaryPolicy "' + report.policy + '".']
  }

  if (report.platformUnsupported) {
    return [
      '- BaseMind publishes no prebuilt binary for this platform.',
      '  Build one from source: ' + repository,
      '- then set `command` (or BASEMIND_BIN) to that executable.',
    ]
  }

  if (/probe failed/i.test(reason)) {
    return [
      '- Run the selected binary with `--version` yourself; the probe could not read a version.',
      '- Reinstall BaseMind ' + expected + ' from ' + releases,
      '- or set `command` / BASEMIND_BIN to a working executable.',
    ]
  }

  if (/unparsable/i.test(reason)) {
    return [
      '- Reinstall BaseMind ' + expected + '; its `--version` output could not be parsed.',
      '- Releases: ' + releases,
      '- or set `command` / BASEMIND_BIN to a different BaseMind executable.',
    ]
  }

  if (!report.present) {
    const bullets = [
      '- Install BaseMind ' + expected + ': ' + releases,
      '  then set `command` (or BASEMIND_BIN) to that executable.',
    ]
    if (report.download.enabled === false) {
      bullets.push('- Or set binaryDownload: true so the plugin can fetch it automatically.')
    } else if (report.download.state === 'failed' || report.download.state === 'cooldown') {
      bullets.push('- Or fix network/proxy access to github.com, then restart DSH: the next start retries after a short cooldown.')
    } else {
      bullets.push('- Or leave binaryDownload: true: the next DSH start retries the download after a short cooldown.')
    }
    return bullets
  }

  const bullets = [
    '- Install BaseMind ' + expected + ': ' + releases,
    '  then set `command` (or BASEMIND_BIN) to that executable.',
  ]
  if (report.found !== undefined) {
    bullets.push('- Or set binaryPolicy: "minor" to accept ' + report.found + ' only after you verify it.')
  }
  bullets.push('- Or set binaryPolicy: "any" to run it unverified (skills + CLI stay off).')
  bullets.push('- Or set binaryFallback: false to stop at this explicit binary.')
  return bullets
}

/**
 * Render the normalized report into lines.
 * @param {ReturnType<typeof normalizeReport>} report
 * @returns {string[]}
 */
function buildLines(report) {
  const lines = []
  lines.push('BaseMind status - dsh-basemind-plugin ' + report.pluginVersion + ' (BaseMind ' + report.expected + ')')
  lines.push(formatLine('expected upstream', report.expected + ' (' + report.policy + ')'))
  lines.push(formatLine('platform', report.platform))
  lines.push(formatLine('present', report.present ? 'yes' : 'no'))
  if (report.present && report.path !== undefined) {
    lines.push(formatLine('path', report.path, { keepTail: true }))
  }
  lines.push(formatLine('found', report.found !== undefined ? report.found : report.present ? 'unknown' : 'none'))
  const reason = report.reasons.length > 0 ? report.reasons[0] : 'not usable'
  lines.push(formatLine('compatible', report.compatible ? 'yes' : 'NO - ' + reason))
  lines.push(formatLine('source', report.source !== undefined ? report.source : '(none)'))
  let cacheValue = 'unknown'
  if (report.cache.root !== undefined) {
    cacheValue =
      (report.cache.present ? 'present' : 'empty') +
      ' (' +
      shortenPath(report.cache.root, 60) +
      ')' +
      (report.cache.present && report.cache.valid === false ? ' - invalid' : '')
    if (report.cache.missingFile !== undefined) {
      cacheValue += ' - incomplete'
    }
  }
  lines.push(formatLine('managed cache', cacheValue))
  if (report.cache.layout !== undefined) {
    const layout = report.cache.layout
    let layoutValue
    if (layout === 2) {
      const count = report.cache.fileCount
      layoutValue = '2 (' + (count === undefined ? 'unknown files' : count + ' file' + (count === 1 ? '' : 's')) + ')'
    } else {
      layoutValue = String(layout) + ' - re-download required'
    }
    lines.push(formatLine('cache layout', layoutValue))
    lines.push(formatLine('cache binary', report.cache.present ? 'present' : 'missing'))
  }
  if (report.cache.missingFile !== undefined) {
    lines.push(formatLine('cache missing', report.cache.missingFile, { keepTail: true }))
  }
  if (report.cache.parkedTree !== undefined) {
    lines.push(formatLine('cache parked', report.cache.parkedTree + ' - restored on the next selection', { keepTail: true }))
  }
  lines.push(formatLine('download', downloadLine(report)))
  lines.push('')
  lines.push('  What to do:')
  for (const bullet of guidance(report)) lines.push('    ' + bullet)
  if (!report.compatible) {
    lines.push('  Tools are not registered until a compatible binary is available.')
  }
  return fitLines(lines)
}

/**
 * Build a status report from the binary manager and settings.
 *
 * Never throws. When manager.ensureStatus exists it is awaited with a 5 s bound,
 * but only for a supported platform: an unsupported platform renders its
 * build-from-source guidance without probing anything.
 *
 * @param {{ manager?: { status?: () => unknown, ensureStatus?: () => unknown },
 *           config?: object, platform?: object|string }} [options]
 * @returns {Promise<Record<string, any>>} the report, including lines.
 */
export async function statusReport(options) {
  const input = isPlainObject(options) ? options : {}
  const policy = readPolicy(input.config)
  const baseFacts = platformFacts(input.platform)
  const read = await readManagerStatus(input.manager, baseFacts)

  const selection =
    isPlainObject(read.status) && isPlainObject(read.status.selection) ? read.status.selection : {}
  const statusRecord = isPlainObject(read.status) ? read.status : {}
  const probeError = read.error
  const facts = platformFacts(input.platform, statusRecord)
  const presentPath = firstDefined(selection.path, statusRecord.path)
  const present = typeof presentPath === 'string' && presentPath !== ''
  const foundValue = firstDefined(selection.version, statusRecord.found)
  const found = typeof foundValue === 'string' && foundValue !== '' ? foundValue : undefined
  const compatibleValue = firstDefined(selection.compatible, statusRecord.compatible)
  const sourceValue = firstDefined(selection.source, statusRecord.source)
  const source = typeof sourceValue === 'string' && sourceValue !== '' ? sourceValue : undefined

  const cacheRaw = isPlainObject(statusRecord.cache) ? statusRecord.cache : {}
  const downloadRaw = isPlainObject(statusRecord.download) ? statusRecord.download : {}
  const downloadEnabled = isPlainObject(input.config) && input.config.binaryDownload === false ? false : true

  const reasons = []
  const rawReason = sanitize(firstDefined(selection.reason, statusRecord.reason))
  // The manager reports a compatible selection as reason 'match'; that is not a
  // reason to show next to "compatible: yes".
  if (rawReason !== '' && rawReason !== 'match') reasons.push(rawReason)
  if (probeError !== undefined) reasons.push('probe failed: ' + sanitize(probeError))

  if (facts.unsupported) {
    const reason = sanitize(facts.reason) || 'unsupported platform (' + (facts.key === undefined ? 'unknown' : facts.key) + ')'
    if (!reasons.some((entry) => /unsupported platform/i.test(entry))) reasons.unshift(reason)
  }

  if (!present) {
    if (reasons.length === 0) reasons.push('no BaseMind binary was found')
    if (!downloadEnabled) reasons.push('binary download is disabled (binaryDownload=false)')
  } else if (found === undefined) {
    const probeSample = isPlainObject(statusRecord.probe) ? statusRecord.probe.sample : undefined
    const sample = sanitize(firstDefined(selection.sample, selection.rawVersion, selection.probeOutput, probeSample))
    if (!reasons.some((entry) => /unparsable|probe failed/i.test(entry))) {
      reasons.push(sample !== '' ? 'unparsable version output: "' + sample + '"' : 'unparsable version output')
    } else if (sample !== '') {
      const index = reasons.findIndex((entry) => /unparsable/i.test(entry))
      if (index >= 0 && reasons[index].indexOf(sample) === -1) {
        reasons[index] = reasons[index] + ': "' + sample + '"'
      }
    }
  } else if (compatibleValue !== true && reasons.length === 0) {
    reasons.push('version ' + found + ' does not satisfy binaryPolicy "' + policy + '"')
  }

  const normalized = normalizeReport(
    {
      pluginVersion: statusRecord.pluginVersion,
      expected: UPSTREAM.version,
      policy,
      platform: facts.display,
      present,
      path: typeof presentPath === 'string' ? presentPath : undefined,
      found,
      compatible: compatibleValue === true && present,
      source,
      reasons,
      cache: {
        root: typeof cacheRaw.root === 'string' ? cacheRaw.root : undefined,
        target: typeof cacheRaw.target === 'string' ? cacheRaw.target : undefined,
        present: cacheRaw.present === true,
        valid: cacheRaw.valid === true,
        layout: cacheRaw.layout,
        fileCount: cacheRaw.fileCount,
        missingFile: cacheRaw.missingFile,
        parkedTree: cacheRaw.parkedTree,
      },
      download: {
        enabled: downloadEnabled,
        state: typeof downloadRaw.state === 'string' ? downloadRaw.state : 'idle',
        attempts: Number.isFinite(downloadRaw.attempts) ? downloadRaw.attempts : 0,
        lastError: downloadRaw.lastError,
      },
      platformUnsupported: facts.unsupported,
    },
    { platformFacts: facts },
  )

  return Object.assign({}, normalized, { lines: buildLines(normalized) })
}

/**
 * Render a report as plain text. Pure: the same report always yields the same
 * string. Falls back to rendering the fields when lines is missing.
 *
 * @param {unknown} report
 * @returns {string}
 */
export function renderStatus(report) {
  if (isPlainObject(report) && Array.isArray(report.lines)) {
    return report.lines.map((line) => String(line)).join('\n')
  }
  return buildLines(normalizeReport(report)).join('\n')
}
