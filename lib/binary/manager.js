/**
 * Local-first BaseMind binary selection, managed download, installation and status.
 *
 * Candidate order (every candidate must pass the version policy before it is used):
 *   config.command (non-default) -> BASEMIND_BIN -> PATH -> managed cache ->
 *   official release download (binaryDownload) -> npx (legacy, autoProvision)
 *
 * The manager makes exactly one selection per process, coalesces concurrent
 * callers onto one in-flight selection, shares one download per target across
 * threads and processes (directory lock), installs atomically and fails closed:
 * an unverified binary is never executed and a failure only disables BaseMind.
 *
 * @module dsh-basemind-plugin/lib/binary/manager
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { scrubEnv } from '../executable.js'
import { UPSTREAM, assetFor, checksumsUrl } from '../upstream.js'
import { extractArchive } from './archive.js'
import { digestFor, parseChecksums } from './checksums.js'
import { downloadVerified } from './download.js'
import { createProbeCache, isCompatible, probeExecutable } from './probe.js'
import { resolveTarget } from './platform.js'

const DOWNLOAD_COOLDOWN_MS = 10 * 60 * 1000
const LOCK_STALE_MS = 120_000
const LOCK_TIMEOUT_MS = 120_000
const LOCK_RETRY_MS = 200
const PROBE_TIMEOUT_MS = 5_000
const MAX_CHECKSUMS_BYTES = 64 * 1024
const CHECKSUM_REDIRECTS = 5
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 200
/** Layout version of the install record written by this release. */
const INSTALL_LAYOUT = 2
/**
 * Extraction limits for the install path only. The official trees are 230-322 MB
 * uncompressed, so the 400 MB module defaults would leave almost no headroom; the
 * module defaults stay unchanged for single-file extraction and its tests.
 */
const INSTALL_LIMITS = Object.freeze({
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024 * 1024,
})
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

/**
 * Delay without releasing the event loop: the lock retry is the only pending work in a
 * process that is waiting for another process to finish an install, so an unref'd timer
 * would let Node exit (unsettled top-level await) instead of waiting out the lock.
 * @param {number} ms
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** @param {string} home @param {string} value */
function expandHome(home, value) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

/**
 * Resolve the DSH home directory the same way DSH does: `DSH_HOME` when it is a
 * non-empty string, otherwise `~/.dsh`.
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [homedir]
 * @returns {string}
 */
export function resolveDshHome(env = process.env, homedir = os.homedir()) {
  const raw = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (raw !== '') return path.resolve(expandHome(homedir, raw))
  return path.join(homedir, '.dsh')
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** An AbortError-shaped rejection for a caller that aborted its own wait. */
function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Wait for a shared promise without letting one caller's abort cancel the work.
 * The promise keeps running; only this waiter rejects.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<T>}
 */
function waitWithSignal(promise, signal) {
  if (signal === undefined || signal === null) return promise
  if (signal.aborted === true) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

/** @param {string} file */
async function sha256File(file) {
  const hash = createHash('sha256')
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/** @param {string} value */
function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Is this install record a complete layout-2 managed tree? `binarySha256` is required:
 * `sha256` is the digest of the downloaded archive, so it can never verify the unpacked
 * binary, and a record without a binary digest cannot prove its own contents.
 * @param {unknown} value
 * @returns {boolean}
 */
function isLayout2(value) {
  return (
    isObject(value) &&
    value.layout === INSTALL_LAYOUT &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    typeof value.binarySha256 === 'string' &&
    value.binarySha256 !== ''
  )
}

/**
 * The relative path of the main binary recorded in an install record.
 * @param {unknown} install
 * @param {string} fallback
 * @returns {string}
 */
function recordedBinary(install, fallback) {
  return isObject(install) && typeof install.binary === 'string' && install.binary !== '' ? install.binary : fallback
}

/**
 * List every regular file under `root` as `{ path, size }`, sorted by path. The install
 * record is built from the tree that is actually on disk, so it can only describe files
 * that really exist.
 * @param {string} root
 * @returns {Promise<{ path: string, size: number }[]>}
 */
async function listInstalledFiles(root) {
  /** @type {{ path: string, size: number }[]} */
  const files = []
  /** @param {string} directory @param {string} prefix */
  async function walk(directory, prefix) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, relative)
      } else if (entry.isFile()) {
        files.push({ path: relative, size: (await fsp.stat(absolute)).size })
      }
    }
  }
  await walk(root, '')
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * The first recorded file that is missing, not a regular file, or the wrong size.
 * Stat only: an intact tree is never hashed.
 * @param {unknown} install
 * @param {string} directory
 * @returns {Promise<string|undefined>}
 */
async function firstBrokenFile(install, directory) {
  if (isObject(install) === false || Array.isArray(install.files) === false) return undefined
  for (const entry of install.files) {
    if (isObject(entry) === false || typeof entry.path !== 'string' || entry.path === '') {
      return '(invalid file entry)'
    }
    let stat
    try {
      stat = await fsp.stat(path.join(directory, entry.path))
    } catch {
      return entry.path
    }
    if (stat.isFile() !== true || stat.size !== Number(entry.size)) return entry.path
  }
  return undefined
}

/**
 * The synchronous twin of {@link firstBrokenFile}, for the status snapshot.
 * @param {unknown} install
 * @param {string} directory
 * @returns {string|undefined}
 */
function firstBrokenFileSync(install, directory) {
  if (isObject(install) === false || Array.isArray(install.files) === false) return undefined
  for (const entry of install.files) {
    if (isObject(entry) === false || typeof entry.path !== 'string' || entry.path === '') {
      return '(invalid file entry)'
    }
    let stat
    try {
      stat = fs.statSync(path.join(directory, entry.path))
    } catch {
      return entry.path
    }
    if (stat.isFile() !== true || stat.size !== Number(entry.size)) return entry.path
  }
  return undefined
}

/**
 * Fetch the small checksums document with the same host allowlist as the asset
 * download, following redirects manually so a redirect cannot escape the list.
 * @param {{ url: string, fetchImpl: Function, signal?: AbortSignal, allowedHosts?: readonly string[], logger?: any }} params
 * @returns {Promise<string>}
 */
async function fetchChecksumsText({ url, fetchImpl, signal, allowedHosts = DEFAULT_ALLOWED_HOSTS, logger }) {
  let current = url
  for (let hop = 0; hop <= CHECKSUM_REDIRECTS; hop += 1) {
    if (!isHttpsUrl(current)) throw new Error('checksums URL must be https')
    const host = new URL(current).hostname.toLowerCase()
    if (!allowedHosts.includes(host)) throw new Error('checksums URL host ' + host + ' is not allowed')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    timer.unref?.()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let response
    try {
      response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location')
      if (typeof location !== 'string' || location === '') throw new Error('checksums redirect without a location')
      current = new URL(location, current).toString()
      continue
    }
    if (response.status !== 200) throw new Error('checksums request failed with HTTP ' + String(response.status))
    const text = await response.text()
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CHECKSUMS_BYTES) {
      throw new Error('checksums document is missing or too large')
    }
    return text
  }
  throw new Error('too many checksums redirects')
}

/**
 * Create the binary manager for one plugin instance.
 * @param {{ ctx: any, config?: any, logger?: any, env?: Record<string, string|undefined>,
 *           platform?: NodeJS.Platform|string, arch?: string, fetchImpl?: Function,
 *           now?: () => number, sleep?: (ms: number) => Promise<void>, cacheRoot?: string,
 *           homedir?: string, probeCache?: any }} [options]
 */
export function createBinaryManager({
  ctx,
  config = {},
  logger,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
  cacheRoot,
  homedir = os.homedir(),
  probeCache = createProbeCache(),
  // Test seams: production always passes the real implementation, and every seam
  // keeps the same contract so the manager can be exercised without the network.
  probeFn = probeExecutable,
  downloader = downloadVerified,
  extractor = extractArchive,
  checksumsFetcher = fetchChecksumsText,
  hasher = sha256File,
  renameFn = (from, to) => fsp.rename(from, to),
} = {}) {
  const root = cacheRoot ?? path.join(resolveDshHome(env, homedir), 'cache', 'dsh-basemind-plugin')
  const managedRoot = path.join(root, 'managed-binaries')
  const downloadRoot = path.join(root, 'download')
  const stateFile = path.join(root, 'state.json')
  const policy = config.binaryPolicy === 'minor' || config.binaryPolicy === 'any' ? config.binaryPolicy : 'exact'
  const expected = UPSTREAM.version
  const controller = new AbortController()
  const warned = new Set()

  /** @type {{ ok: boolean, [key: string]: any }|undefined} */
  let selection
  /** Last executable actually probed, so a failed selection still names it. */
  let lastSeen
  let inFlight
  let disposed = false
  let downloadAttempted = false
  let target = resolveTarget({ platform, arch })
  const download = { state: 'idle', attempts: 0, lastError: undefined, nextAttemptAt: undefined }

  function warnOnce(key, text) {
    if (warned.has(key)) return
    warned.add(key)
    logger?.warn?.('[dsh-basemind-plugin] ' + text)
  }

  let pluginVersion
  function readPluginVersion() {
    if (pluginVersion !== undefined) return pluginVersion
    try {
      const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
      pluginVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown'
    } catch {
      pluginVersion = 'unknown'
    }
    return pluginVersion
  }

  function targetKey() {
    return target?.unsupported === true ? 'unsupported' : target.key
  }

  function targetDir() {
    return path.join(managedRoot, expected, targetKey())
  }

  /** Read the install record synchronously (status and path resolution only). */
  function installRecordSync() {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(targetDir(), 'install.json'), 'utf8'))
      return isObject(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The main binary path, using `install.json.binary` when a record exists and the
   * platform's default file name otherwise.
   * @param {unknown} [install] a record already read; omitted means read it now.
   * @returns {string|undefined}
   */
  function binaryPath(install) {
    if (target?.unsupported === true) return undefined
    const record = install === undefined ? installRecordSync() : install
    return path.join(targetDir(), recordedBinary(record, target.binary))
  }

  function failure(reason, extra = {}) {
    return {
      ok: false,
      reason,
      expected,
      policy,
      platform: target?.unsupported === true ? undefined : target.key,
      ...(lastSeen === undefined ? {} : { path: lastSeen.path, found: lastSeen.found }),
      ...extra,
    }
  }

  async function readJson(file) {
    try {
      const text = await fsp.readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      return isObject(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  async function writeJson(file, value) {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
    } catch (error) {
      logger?.debug?.('[dsh-basemind-plugin] could not write ' + file + ': ' + message(error))
    }
  }

  async function readState() {
    const state = await readJson(stateFile)
    return isObject(state) ? state : {}
  }

  async function recordFailure(reason) {
    const state = await readState()
    const failures = isObject(state.lastFailureAt) ? state.lastFailureAt : {}
    failures[targetKey()] = now()
    state.lastFailureAt = failures
    await writeJson(stateFile, state)
    download.state = 'cooldown'
    download.lastError = reason
    download.nextAttemptAt = now() + DOWNLOAD_COOLDOWN_MS
  }

  async function inCooldown() {
    const state = await readState()
    const failures = isObject(state.lastFailureAt) ? state.lastFailureAt : {}
    const last = Number(failures[targetKey()])
    if (!Number.isFinite(last)) return false
    if (now() - last >= DOWNLOAD_COOLDOWN_MS) return false
    download.state = 'cooldown'
    download.nextAttemptAt = last + DOWNLOAD_COOLDOWN_MS
    return true
  }

  /**
   * Probe one explicit or PATH candidate and apply the version policy.
   * @returns {Promise<{ ok: true, selection: object } | { ok: false, note: string, found?: string }>}
   */
  async function tryCandidate(source, command, signal) {
    let resolved
    try {
      resolved = await ctx.subprocess.resolveExecutable(command, scrubEnv(env, config.env), signal)
    } catch (error) {
      return { ok: false, note: source + " '" + command + "' is not resolvable (" + message(error) + ')' }
    }
    const probe = await probeFn({ ctx, exe: resolved, platform, timeoutMs: PROBE_TIMEOUT_MS, signal, cache: probeCache, logger })
    if (probe.ok !== true) {
      // A binary that ran but never named a BaseMind version is exactly what
      // 'any' accepts: the operator opted out of version verification.
      if (policy === 'any' && probe.reason === 'unparsable') {
        return {
          ok: true,
          selection: { ok: true, source, path: resolved, version: undefined, compatible: true, verified: false, policy, reason: 'unverified' },
        }
      }
      return { ok: false, note: source + " '" + resolved + "' could not be probed (" + probe.reason + ')' }
    }
    // 'any' means the operator accepts an unverified binary; a probe that ran but
    // could not name a BaseMind version is exactly that case.
    lastSeen = { path: resolved, found: probe.version }
    const compatible =
      policy === 'any' && probe.parsed === undefined
        ? { compatible: true, reason: 'match' }
        : isCompatible(probe.parsed ?? probe.version, { expected, policy })
    if (!compatible.compatible) {
      return {
        ok: false,
        found: probe.version,
        note: source + " '" + resolved + "' reports BaseMind " + probe.version + ', which is not compatible with ' + expected + " under '" + policy + "' (" + compatible.reason + ')',
      }
    }
    return {
      ok: true,
      selection: { ok: true, source, path: resolved, version: probe.version, compatible: true, verified: policy !== 'any', policy, reason: 'match' },
    }
  }

  async function invalidateCache() {
    try {
      await fsp.rm(targetDir(), { recursive: true, force: true })
    } catch (error) {
      logger?.debug?.('[dsh-basemind-plugin] could not remove an invalid managed cache: ' + message(error))
    }
  }

  /** Validate the managed cache for the pinned target. */
  async function readManagedCache() {
    if (target?.unsupported === true) return undefined
    const directory = targetDir()
    const install = await readJson(path.join(directory, 'install.json'))
    // A layout-1 (or record-less) cache can never be completed from a single binary and
    // is re-downloaded instead of patched. It is also not deleted here: the replacement
    // is swapped in atomically later, so a failed download leaves the old tree alone.
    if (isLayout2(install) !== true) return undefined

    const file = binaryPath(install)
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      return undefined
    }
    if (stat.isFile() !== true || stat.size <= 0) {
      await invalidateCache()
      return undefined
    }
    const broken = await firstBrokenFile(install, directory)
    if (broken !== undefined) {
      warnOnce(
        'managed-incomplete:' + directory,
        'the managed BaseMind cache at ' + directory + ' is incomplete (missing ' + broken + '); it will be replaced',
      )
      return undefined
    }
    const probe = await probeFn({ ctx, exe: file, platform, timeoutMs: PROBE_TIMEOUT_MS, cache: probeCache, logger })
    if (probe.ok !== true) {
      warnOnce('managed-unusable:' + file, 'the managed BaseMind binary at ' + file + ' is not usable (' + probe.reason + '); it will be replaced')
      await invalidateCache()
      return undefined
    }
    const compatible = isCompatible(probe.parsed ?? probe.version, { expected, policy: 'exact' })
    if (!compatible.compatible) {
      warnOnce('managed-mismatch:' + file, 'the managed BaseMind binary at ' + file + ' reports ' + probe.version + ', not ' + expected + '; it will be replaced')
      await invalidateCache()
      return undefined
    }
    if (Number(install.size) !== stat.size || Number(install.mtimeMs) !== stat.mtimeMs) {
      const digest = await hasher(file)
      if (digest !== String(install.binarySha256).toLowerCase()) {
        warnOnce('managed-digest:' + file, 'the managed BaseMind binary at ' + file + ' does not match its install record; it will be replaced')
        await invalidateCache()
        return undefined
      }
    }
    return { ok: true, source: 'managed', path: file, version: probe.version, compatible: true, verified: true, policy: 'exact', reason: 'match' }
  }

  let swept = false

  /** Remove download leftovers older than 24 h; best effort, never blocks select. */
  async function sweepDownloadRoot() {
    try {
      const cutoff = now() - 24 * 60 * 60 * 1000
      for (const entry of await fsp.readdir(downloadRoot, { withFileTypes: true })) {
        const candidate = path.join(downloadRoot, entry.name)
        try {
          const stat = await fsp.stat(candidate)
          if (stat.mtimeMs < cutoff) await fsp.rm(candidate, { recursive: true, force: true })
        } catch {
          // A leftover that disappears mid-sweep is already clean.
        }
      }
    } catch {
      // No download directory yet, or it is not readable: nothing to sweep.
    }
  }

  async function lockPath() {
    return path.join(managedRoot, '.lock-' + expected + '-' + targetKey())
  }

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function lockIsStale(lockDir) {
    const owner = await readJson(path.join(lockDir, 'owner.json'))
    if (owner === undefined) return false
    if (owner.hostname === os.hostname() && pidAlive(Number(owner.pid)) === false) return true
    return now() - Number(owner.startedAt) > LOCK_STALE_MS
  }

  /** @returns {Promise<() => Promise<void>>} a release function. */
  async function acquireLock(signal) {
    const dir = await lockPath()
    // The lock is a bare mkdir (atomic; EEXIST means "held"), so the parent must
    // exist first. mkdir(lock, { recursive: true }) would report success for an
    // existing lock and silently break mutual exclusion.
    await fsp.mkdir(managedRoot, { recursive: true })
    const deadline = now() + LOCK_TIMEOUT_MS
    for (;;) {
      if (signal?.aborted === true) throw abortReason(signal)
      try {
        await fsp.mkdir(dir)
        await fsp.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: now() }), 'utf8')
        return async () => {
          try {
            await fsp.rm(dir, { recursive: true, force: true })
          } catch {
            // A stale lock is recovered by the next owner.
          }
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      if (await lockIsStale(dir)) {
        try {
          await fsp.rm(dir, { recursive: true, force: true })
          continue
        } catch {
          // Someone else is recovering it; keep waiting.
        }
      }
      if (now() > deadline) throw new Error('timed out waiting for the managed binary install lock')
      await sleep(LOCK_RETRY_MS)
    }
  }

  /**
   * Rename within the cache with a bounded retry for Windows file sharing. Staging and
   * the target directory share the cache root, so a directory rename is atomic.
   * @param {string} from
   * @param {string} to
   * @param {string} label a phrase that completes "could not ..."
   */
  async function renameWithRetry(from, to, label) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await renameFn(from, to)
        return
      } catch (error) {
        const code = error?.code
        const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
        if (retryable !== true) throw new Error('could not ' + label + ': ' + message(error))
        if (attempt >= RENAME_ATTEMPTS) {
          throw new Error(
            'could not ' + label + ' after ' + RENAME_ATTEMPTS + ' attempts (' + message(error) + '); ' +
              'another process is still using the managed cache. Close other DSH windows and restart DSH, then retry.',
          )
        }
        await sleep(RENAME_RETRY_MS)
      }
    }
  }

  /**
   * The most recently written directory of a list, or undefined when none is readable.
   * @param {string[]} directories
   * @returns {Promise<string|undefined>}
   */
  async function newestOf(directories) {
    let best
    let bestTime = Number.NEGATIVE_INFINITY
    for (const directory of directories) {
      try {
        const stat = await fsp.stat(directory)
        if (stat.mtimeMs > bestTime) {
          bestTime = stat.mtimeMs
          best = directory
        }
      } catch {
        // Unreadable leftovers are removed by the caller.
      }
    }
    return best
  }

  /**
   * Recover the tree an interrupted swap left parked as `.old-<target>-*`, and drop
   * superseded leftovers. Runs under the install lock, so no other process can be in the
   * middle of a swap: a missing target plus one parked tree is a crash window, not a
   * concurrent install. Without this, that state silently loses the cache (and re-downloads)
   * while the old tree keeps 230–322 MB on disk forever.
   */
  async function recoverParkedTrees({ locked = false } = {}) {
    if (locked !== true) {
      // Another process may be mid-swap right now (it parks the old tree, then downloads
      // for seconds). Restoring its parked tree would break its install, so leave that
      // case to the owner: the call under the lock always wins.
      try {
        await fsp.stat(await lockPath())
        return
      } catch {
        // No install is in flight.
      }
    }
    const parent = path.dirname(targetDir())
    let entries
    try {
      entries = await fsp.readdir(parent, { withFileTypes: true })
    } catch {
      return
    }
    const prefix = '.old-' + targetKey() + '-'
    const parked = entries
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => path.join(parent, entry.name))
    if (parked.length === 0) return

    let targetPresent = true
    try {
      await fsp.stat(targetDir())
    } catch {
      targetPresent = false
    }

    /** @type {string[]} */
    const remaining = []
    if (targetPresent === false) {
      const newest = await newestOf(parked)
      if (newest !== undefined) {
        try {
          await renameWithRetry(newest, targetDir(), 'restore the interrupted managed cache')
          logger?.info?.('[dsh-basemind-plugin] recovered the interrupted managed cache at ' + targetDir())
          for (const dir of parked) if (dir !== newest) remaining.push(dir)
        } catch (error) {
          logger?.warn?.(
            '[dsh-basemind-plugin] could not restore the interrupted managed cache from ' + newest + ': ' + message(error),
          )
          return
        }
      }
    } else {
      for (const dir of parked) remaining.push(dir)
    }

    for (const dir of remaining) {
      try {
        await fsp.rm(dir, { recursive: true, force: true })
      } catch (error) {
        logger?.warn?.('[dsh-basemind-plugin] could not remove the superseded managed cache at ' + dir + ': ' + message(error))
      }
    }
  }

  /**
   * Install the complete pinned release under a directory lock: download, verify the
   * published SHA256, extract the whole tree, probe the main binary, write the layout-2
   * install record, then swap the staging directory into place atomically.
   * @param {AbortSignal|undefined} signal
   */
  async function installPinned(signal) {
    download.state = 'running'
    download.attempts += 1
    download.lastError = undefined
    const asset = assetFor(targetKey())
    if (asset === undefined) throw new Error('no release asset for this target')
    const release = await acquireLock(signal)
    const staging = path.join(downloadRoot, targetKey() + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
    const extractedDir = path.join(staging, 'extracted')
    const previous = path.join(managedRoot, expected, '.old-' + targetKey() + '-' + Math.random().toString(36).slice(2, 8))
    try {
      await recoverParkedTrees({ locked: true })
      const existing = await readManagedCache()
      if (existing !== undefined) {
        // Another process installed while we waited: stop reporting a running download.
        download.state = 'idle'
        return existing
      }

      const text = await checksumsFetcher({ url: checksumsUrl(), fetchImpl, signal, logger })
      const digests = parseChecksums(text)
      const expectedDigest = digestFor(digests, asset.name)
      if (typeof expectedDigest !== 'string') {
        throw new Error('the release checksums do not list ' + asset.name + '; refusing to install an unverified binary')
      }

      await fsp.mkdir(extractedDir, { recursive: true })
      const archiveFile = path.join(staging, 'asset.' + asset.ext)
      const downloaded = await downloader({ url: asset.url, destFile: archiveFile, sha256: expectedDigest, fetchImpl, signal, logger })
      await extractor({
        archive: archiveFile,
        kind: target.ext,
        destDir: extractedDir,
        // Kept for seams and callers that still extract one file: the whole tree is the
        // install contract, but the main entry and destination name stay explicit.
        entryPath: target.binary,
        destFile: path.join(extractedDir, target.binary),
        limits: INSTALL_LIMITS,
      })

      const staged = path.join(extractedDir, target.binary)
      let stat
      try {
        stat = await fsp.stat(staged)
      } catch {
        stat = undefined
      }
      if (stat === undefined || stat.isFile() !== true || stat.size <= 0) {
        throw new Error('the downloaded archive does not contain a regular ' + target.binary + ' at its root')
      }
      if (platform !== 'win32') await fsp.chmod(staged, 0o755)

      const probe = await probeFn({ ctx, exe: staged, platform, timeoutMs: PROBE_TIMEOUT_MS, cache: undefined, logger })
      if (probe.ok !== true) throw new Error('the downloaded binary did not report a version (' + probe.reason + ')')
      const compatible = isCompatible(probe.parsed ?? probe.version, { expected, policy: 'exact' })
      if (!compatible.compatible) throw new Error('the downloaded binary reports ' + probe.version + ', not ' + expected)

      const files = await listInstalledFiles(extractedDir)
      // `downloaded.sha256` hashes the archive; the cache-reuse check needs the digest of
      // the unpacked binary, so hash it once here (never on a cache hit).
      const binarySha256 = await hasher(staged)
      if (typeof binarySha256 !== 'string' || binarySha256 === '') {
        throw new Error('could not hash the extracted ' + target.binary + ' for its install record')
      }
      const installFile = path.join(extractedDir, 'install.json')
      await writeJson(installFile, {
        layout: INSTALL_LAYOUT,
        version: expected,
        target: targetKey(),
        sha256: downloaded.sha256,
        binarySha256,
        url: asset.url,
        tag: UPSTREAM.tag,
        installedAt: new Date(now()).toISOString(),
        binary: target.binary,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        files,
      })
      // writeJson logs instead of throwing; the cache hit depends on this record, so a
      // missing one must fail the install rather than produce a directory that is
      // re-downloaded on the next start.
      if ((await readJson(installFile)) === undefined) {
        throw new Error('could not write the install record for ' + targetDir())
      }

      await fsp.mkdir(path.dirname(targetDir()), { recursive: true })
      let movedAside = false
      try {
        await fsp.stat(targetDir())
        await renameWithRetry(targetDir(), previous, 'move the previous managed cache aside')
        movedAside = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      try {
        await renameWithRetry(
          extractedDir,
          targetDir(),
          'move the extracted BaseMind tree into ' + targetDir(),
        )
      } catch (error) {
        if (movedAside) {
          // The failed swap must not cost the previous tree. It is parked next to the
          // target, so the next install (or this one, if it is retried in another process)
          // recovers it with recoverParkedTrees(); say where it is when even that fails.
          try {
            await renameWithRetry(previous, targetDir(), 'restore the previous managed cache')
          } catch (restoreError) {
            logger?.warn?.(
              '[dsh-basemind-plugin] could not restore the previous managed cache from ' + previous + ': ' + message(restoreError),
            )
          }
        }
        throw error
      }
      if (movedAside) {
        await fsp.rm(previous, { recursive: true, force: true }).catch((error) => {
          logger?.warn?.('[dsh-basemind-plugin] could not remove the superseded managed cache at ' + previous + ': ' + message(error))
        })
      }

      download.state = 'idle'
      logger?.info?.('[dsh-basemind-plugin] installed BaseMind ' + expected + ' for ' + targetKey() + ' into ' + targetDir())
      const state = await readState()
      const versions = isObject(state.lastVersion) ? state.lastVersion : {}
      if (typeof versions.__selected !== 'string' || versions.__selected !== expected) {
        versions.__selected = expected
        state.lastVersion = versions
        await writeJson(stateFile, state)
      }
      return { ok: true, source: 'managed', path: path.join(targetDir(), target.binary), version: expected, compatible: true, verified: true, policy: 'exact', reason: 'match' }
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
      await release()
    }
  }

  /**
   * Record the version a workspace last used and warn once when it changes.
   * Diagnoses the RELEASE_MINOR upgrade window (an older daemon keeps the index)
   * without naming host paths and without doing anything destructive.
   */
  const notedRoots = new Map()
  async function noteWorkspaceVersion(rootArg, chosen) {
    if (disposed || typeof rootArg !== 'string' || rootArg === '' || chosen?.ok !== true) return
    let key
    try {
      key = path.resolve(rootArg)
    } catch {
      return
    }
    const version = chosen.version ?? 'unverified'
    if (notedRoots.has(key)) return
    notedRoots.set(key, version)
    const state = await readState()
    const versions = isObject(state.lastVersion) ? state.lastVersion : {}
    const previous = typeof versions[key] === 'string' ? versions[key] : undefined
    if (previous !== undefined && previous !== version) {
      warnOnce(
        'version-switch:' + key,
        'BaseMind changed from ' + previous + ' to ' + version + ' for a workspace; a release-minor bump rebuilds that index on first use and an older daemon keeps the workspace until its last client closes. Run comms stop and scan yourself if needed; the plugin never does.',
      )
    }
    if (previous !== version) {
      versions[key] = version
      state.lastVersion = versions
      await writeJson(stateFile, state)
    }
  }

  async function selectNpx(signal) {
    let npx
    try {
      npx = await ctx.subprocess.resolveExecutable('npx', scrubEnv(env, config.env), signal)
    } catch {
      return undefined
    }
    warnOnce('npx-legacy', 'autoProvision is deprecated and unverified; prefer binaryDownload or command/BASEMIND_BIN')
    const spec = typeof config.npxSpec === 'string' && config.npxSpec !== '' ? config.npxSpec : 'basemind@latest'
    return { ok: true, source: 'npx', path: npx, version: undefined, compatible: true, verified: false, policy, reason: 'legacy', npxSpec: spec, extraArgs: ['-y', spec] }
  }

  /** Walk the candidate list once and settle on a selection or a reason. */
  async function runSelection(signal) {
    target = resolveTarget({ platform, arch })
    if (target?.unsupported === true) return failure(target.reason, { unsupported: true })

    // A swap interrupted by a crash leaves the previous tree parked as `.old-*` with no
    // target. Restore it before the managed candidate is read, so `binaryDownload:false`
    // and offline starts still see the cache instead of losing it forever.
    await recoverParkedTrees()

    const notes = []
    const configured = typeof config.command === 'string' ? config.command : ''
    const binOverride = typeof env.BASEMIND_BIN === 'string' ? env.BASEMIND_BIN.trim() : ''
    const defaultCommand = configured === '' || configured === 'basemind'

    if (!defaultCommand) {
      const result = await tryCandidate('command', configured, signal)
      if (result.ok) return result.selection
      notes.push(result.note)
      warnOnce('command:' + configured, result.note)
      if (config.binaryFallback === false) return failure('the configured binary is not compatible: ' + result.note, { found: result.found })
    } else if (binOverride !== '') {
      const result = await tryCandidate('env', binOverride, signal)
      if (result.ok) return result.selection
      notes.push(result.note)
      warnOnce('env:' + binOverride, result.note)
      if (config.binaryFallback === false) return failure('BASEMIND_BIN is not compatible: ' + result.note, { found: result.found })
    }

    const fromPath = await tryCandidate('path', 'basemind', signal)
    if (fromPath.ok) return fromPath.selection
    if (fromPath.note !== undefined && fromPath.found !== undefined) warnOnce('path', fromPath.note)
    notes.push(fromPath.note)

    const managed = await readManagedCache()
    if (managed !== undefined) return managed

    if (config.binaryDownload === true && downloadAttempted === false && (await inCooldown()) === false) {
      downloadAttempted = true
      try {
        return await installPinned(controller.signal)
      } catch (error) {
        const reason = 'managed download failed: ' + message(error)
        if (controller.signal.aborted === true || error?.name === 'AbortError') {
          // Shutdown is not a failure: do not poison the cooldown for the next run.
          download.state = 'idle'
          notes.push('the managed download was aborted by shutdown')
        } else {
          await recordFailure(reason)
          warnOnce('download', reason)
          notes.push(reason)
        }
      }
    } else if (config.binaryDownload === true) {
      notes.push('the managed download is cooling down after a recent failure')
    } else {
      notes.push('binaryDownload is false; no download was attempted')
    }

    if (config.autoProvision === true) {
      const npx = await selectNpx(signal)
      if (npx !== undefined) return npx
      notes.push('the legacy npx fallback is not resolvable either')
    }

    return failure('no compatible BaseMind binary is available: ' + notes.filter(Boolean).join('; '))
  }

  /**
   * Synchronous, bounded snapshot of the managed cache for `/basemind-status`:
   * layout version, recorded file count, whether the main binary is present and the
   * first file that is missing or has the wrong size.
   */
  function managedCacheFacts() {
    const key = target?.unsupported === true ? undefined : target.key
    const install = target?.unsupported === true ? undefined : installRecordSync()
    const records = isObject(install) && Array.isArray(install.files) ? install.files.filter((entry) => isObject(entry)) : []
    const file = binaryPath(install)
    let present = false
    if (file !== undefined) {
      try {
        present = fs.statSync(file).isFile()
      } catch {
        present = false
      }
    }
    /** @type {string|undefined} */
    let missingFile
    if (isObject(install) && Array.isArray(install.files)) {
      missingFile = firstBrokenFileSync(install, targetDir())
    }
    const layout = isObject(install) && Number.isInteger(install.layout) ? install.layout : undefined
    return {
      root: managedRoot,
      target: key,
      present,
      valid: present && layout === INSTALL_LAYOUT && records.length > 0 && missingFile === undefined,
      layout,
      fileCount: isObject(install) && Array.isArray(install.files) ? install.files.length : undefined,
      missingFile,
      parkedTree: present === false ? parkedTreeSync() : undefined,
      sha256: isObject(install) && typeof install.sha256 === 'string' ? install.sha256 : undefined,
      installedAt: isObject(install) && typeof install.installedAt === 'string' ? install.installedAt : undefined,
    }
  }

  /**
   * The name of a tree an interrupted swap parked next to the target, for diagnostics.
   * The next selection restores it, so status must be able to say why the cache looks
   * empty instead of only "missing".
   * @returns {string|undefined}
   */
  function parkedTreeSync() {
    const prefix = '.old-' + targetKey() + '-'
    try {
      const parent = path.dirname(targetDir())
      const match = fs.readdirSync(parent).find((name) => name.startsWith(prefix))
      return match
    } catch {
      return undefined
    }
  }

  return {
    /**
     * One selection per process. Concurrent callers share the in-flight attempt;
     * a caller's signal cancels only that caller's wait.
     * @param {string} [rootArg] diagnostics only; the binary is workspace-independent
     * @param {AbortSignal} [signal]
     */
    async select(rootArg, signal) {
      void rootArg
      if (disposed) return { ok: false, reason: 'the plugin is shutting down', expected, policy }
      if (swept === false) {
        swept = true
        void sweepDownloadRoot()
      }
      if (selection !== undefined) return selection
      if (inFlight === undefined) {
        inFlight = runSelection(controller.signal)
          .then((result) => {
            selection = result
            return result
          })
          .catch((error) => {
            const result = failure('binary selection failed: ' + message(error))
            selection = result
            return result
          })
          .finally(() => {
            inFlight = undefined
          })
      }
      return waitWithSignal(inFlight, signal)
    },

    /** Structured status for logs and /basemind-status. */
    status() {
      const key = target?.unsupported === true ? undefined : target.key
      return {
        pluginVersion: readPluginVersion(),
        expected,
        policy,
        platform: key,
        unsupported: target?.unsupported === true ? target.reason : undefined,
        path: selection?.path ?? lastSeen?.path,
        found: selection?.version ?? lastSeen?.found,
        selection: selection === undefined
          ? undefined
          : {
              source: selection.source,
              path: selection.path,
              version: selection.version,
              compatible: selection.ok === true && selection.compatible !== false,
              reason: selection.reason ?? (selection.ok === true ? 'match' : selection.reason),
            },
        cache: managedCacheFacts(),
        download: { ...download },
      }
    },

    /** Force a status probe when nothing has been selected yet (bounded, no throw). */
    async ensureStatus({ root: rootArg, signal } = {}) {
      if (disposed || selection !== undefined) return this.status()
      try {
        await this.select(rootArg ?? ctx?.workingDirectory?.defaultDirectory, signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS))
      } catch {
        // status() reports what is known; a failed probe must not throw here.
      }
      return this.status()
    },

    /** Record the workspace/version pair after a successful relay start. */
    async noteWorkspace(rootArg, chosen) {
      await noteWorkspaceVersion(rootArg, chosen ?? selection)
    },

    /** Release the manager: abort an in-flight download and stop accepting callers. */
    async dispose() {
      disposed = true
      controller.abort()
    },
  }
}
