/**
 * Probe a BaseMind executable for its version and remember the answer per file identity.
 *
 * The version text comes from `<exe> --version`, launched through the same argv shaper the
 * relay uses (`buildLaunchArgv`), so a `.cmd` launcher is probed exactly the way it will
 * later be spawned. Every failure mode (missing file, not executable, timeout, abort,
 * unparsable output, no subprocess provider) resolves to `{ ok: false, reason }`; this
 * probe never throws and never rejects.
 *
 * The result cache is keyed by absolute path + mtimeMs + size, so replacing or patching
 * the binary in place always re-probes. Negative results are cached too: re-selecting a
 * broken executable must not respawn it.
 *
 * @module dsh-basemind-plugin/lib/binary/probe
 */

import { statSync } from 'node:fs';
import path from 'node:path';

import { buildLaunchArgv } from '../executable.js';
import { UPSTREAM } from '../upstream.js';

/** Max stdout bytes kept from one `--version` probe. */
const STDOUT_LIMIT = 4096;

/** Max characters of diagnostic text echoed back to the caller. */
const DIAGNOSTIC_LIMIT = 128;

/** Closed set of probe failure reasons. */
export const PROBE_REASONS = Object.freeze({
  missing: 'missing',
  unexecutable: 'unexecutable',
  timeout: 'timeout',
  aborted: 'aborted',
  spawnFailed: 'spawn-failed',
  unparsable: 'unparsable',
});

/** Failures worth remembering: they describe the file, not a transient condition. */
const CACHEABLE = new Set([PROBE_REASONS.missing, PROBE_REASONS.unexecutable, PROBE_REASONS.unparsable]);

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const VERSION_LINE = /^basemind\s+(\S+)/;
const VERSION_CORE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The first non-empty line of a capture, without its line terminator.
 * @param {string} text
 * @returns {string|undefined}
 */
function firstNonEmptyLine(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line !== '') return line;
  }
  return undefined;
}

/**
 * Short, control-free diagnostic text for a failed probe.
 * @param {string} value
 * @returns {string|undefined}
 */
function diagnostic(value) {
  const cleaned = String(value).replace(CONTROL_CHARS, ' ').trim();
  if (cleaned === '') return undefined;
  return cleaned.slice(0, DIAGNOSTIC_LIMIT);
}

/**
 * Parse `basemind X.Y.Z[-pre][+build]` from the first non-empty line.
 * @param {string} text
 * @returns {{ raw: string, major: number, minor: number, patch: number, prerelease?: string, build?: string }|undefined}
 */
export function parseBasemindVersion(text) {
  if (typeof text !== 'string') return undefined;
  if (CONTROL_CHARS.test(text)) return undefined;

  const line = firstNonEmptyLine(text.replace(/^\uFEFF/, ''));
  if (line === undefined) return undefined;

  const match = VERSION_LINE.exec(line);
  if (match === null) return undefined;

  const raw = match[1];
  const core = VERSION_CORE.exec(raw);
  if (core === null) return undefined;

  const parsed = { raw, major: Number(core[1]), minor: Number(core[2]), patch: Number(core[3]) };
  if (core[4] !== undefined) parsed.prerelease = core[4];
  if (core[5] !== undefined) parsed.build = core[5];
  return parsed;
}

/**
 * Accept a parsed version, a raw version string, or an object carrying either.
 * @param {unknown} value
 * @returns {{ raw?: string, major: number, minor: number, patch: number, prerelease?: string }|undefined}
 */
function toParsed(value) {
  if (typeof value === 'string') return parseBasemindVersion('basemind ' + value.trim());
  if (value === null || typeof value !== 'object') return undefined;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.parsed !== 'undefined' && record.parsed !== null) return toParsed(record.parsed);
  if (typeof record.version === 'string') return toParsed(record.version);
  if (typeof record.major !== 'number' || typeof record.minor !== 'number' || typeof record.patch !== 'number') {
    return undefined;
  }
  return /** @type {{ raw?: string, major: number, minor: number, patch: number, prerelease?: string }} */ (record);
}

/**
 * Decide whether a found version may serve this plugin under `binaryPolicy`.
 *
 * Reason values: `match`, `minor-mismatch`, `patch-mismatch`, `prerelease`,
 * `unparsable`, `unknown` (unknown policy or unparsable expectation).
 *
 * @param {unknown} found parsed version, raw version string, or probe result
 * @param {{ expected?: string, policy?: 'exact'|'minor'|'any' }} [options]
 * @returns {{ compatible: boolean, reason: string }}
 */
export function isCompatible(found, { expected = UPSTREAM.version, policy = 'exact' } = {}) {
  const target = toParsed(expected);
  if (target === undefined) return { compatible: false, reason: 'unknown' };

  const actual = toParsed(found);
  if (actual === undefined) return { compatible: false, reason: 'unparsable' };

  if (policy === 'any') return { compatible: true, reason: 'match' };
  if (actual.prerelease !== undefined) return { compatible: false, reason: 'prerelease' };

  const sameMinor = actual.major === target.major && actual.minor === target.minor;
  if (policy === 'exact') {
    if (!sameMinor) return { compatible: false, reason: 'minor-mismatch' };
    if (actual.patch !== target.patch) return { compatible: false, reason: 'patch-mismatch' };
    return { compatible: true, reason: 'match' };
  }
  if (policy === 'minor') {
    if (!sameMinor) return { compatible: false, reason: 'minor-mismatch' };
    return { compatible: true, reason: 'match' };
  }

  return { compatible: false, reason: 'unknown' };
}

/**
 * Cache key for one observed file identity: absolute path, mtime and size.
 * A file that is replaced or rebuilt in place produces a different key.
 * @param {string} filePath
 * @param {{ mtimeMs?: number, size?: number }|undefined} stat
 * @returns {string}
 */
export function probeCacheKey(filePath, stat) {
  const absolute = path.resolve(String(filePath));
  const mtime = Number(stat?.mtimeMs);
  const size = Number(stat?.size);
  return (
    absolute +
    '\u0000' +
    (Number.isFinite(mtime) ? String(mtime) : '-1') +
    '\u0000' +
    (Number.isFinite(size) ? String(size) : '-1')
  );
}

/**
 * Create a small bounded probe-result cache.
 * `get`/`set` take a key from {@link probeCacheKey}; `delete` accepts either a key
 * or a file path (which drops every identity recorded for that path).
 * @param {{ maxEntries?: number }} [options]
 */
export function createProbeCache({ maxEntries = 64 } = {}) {
  const entries = new Map();
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.trunc(maxEntries) : 64;

  return {
    /** @param {string} key */
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value); // refresh recency
      return value;
    },
    /** @param {string} key @param {unknown} value */
    set(key, value) {
      if (typeof key !== 'string' || key === '') return value;
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return value;
    },
    /** @param {string} keyOrPath */
    delete(keyOrPath) {
      let removed = 0;
      if (entries.delete(keyOrPath)) removed += 1;
      const prefix = path.resolve(String(keyOrPath)) + '\u0000';
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    clear() {
      entries.clear();
    },
    keys() {
      return [...entries.keys()];
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Map a spawn failure onto a probe reason.
 * @param {unknown} error
 * @returns {string}
 */
function spawnFailureReason(error) {
  const code = /** @type {any} */ (error)?.code;
  if (code === 'ENOENT') return PROBE_REASONS.missing;
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOEXEC' || code === 'EISDIR' || code === 'UNKNOWN') {
    return PROBE_REASONS.unexecutable;
  }
  return PROBE_REASONS.spawnFailed;
}

/**
 * @param {string} reason
 * @param {string|undefined} [detail]
 */
function failure(reason, detail) {
  if (detail === undefined) return { ok: false, reason };
  return { ok: false, reason, raw: detail };
}

/**
 * Run one `--version` probe.
 * @param {{ ctx: any, filePath: string, platform: NodeJS.Platform|string, timeoutMs: number,
 *           signal?: AbortSignal, logger?: any }} params
 * @returns {Promise<any>}
 */
async function runProbe({ ctx, filePath, platform, timeoutMs, signal, logger }) {
  const spawn = typeof ctx?.subprocess?.spawn === 'function' ? ctx.subprocess.spawn.bind(ctx.subprocess) : undefined;
  if (spawn === undefined) return failure(PROBE_REASONS.spawnFailed, 'no ctx.subprocess.spawn is available to probe BaseMind');

  /** @type {string[]} */
  let argv;
  try {
    argv = buildLaunchArgv({ exe: filePath, args: ['--version'], platform }).argv;
  } catch (error) {
    return failure(PROBE_REASONS.unexecutable, diagnostic(errorMessage(error)));
  }

  /** @type {any} */
  let handle;
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  /** @type {(() => void)|undefined} */
  let abortListener;
  let timedOut = false;
  let aborted = false;
  let exitCode = null;
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;

  try {
    try {
      handle = spawn({
        argv,
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 1000,
      });
    } catch (error) {
      return failure(spawnFailureReason(error), diagnostic(errorMessage(error)));
    }

    const stdout = handle?.stdout;
    const done = typeof handle?.done?.then === 'function' ? handle.done : undefined;
    const onData = (chunk) => {
      if (size >= STDOUT_LIMIT) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const slice = buffer.subarray(0, STDOUT_LIMIT - size);
      chunks.push(slice);
      size += slice.length;
    };
    stdout?.on?.('data', onData);

    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      };

      timer = setTimeout(() => {
        timedOut = true;
        finish();
      }, waitMs);
      timer.unref?.();

      stdout?.once?.('end', finish);
      stdout?.once?.('close', finish);
      if (done !== undefined) {
        done.then(
          (code) => {
            if (typeof code === 'number') exitCode = code;
            finish();
          },
          () => finish(),
        );
      }
      if (signal !== undefined) {
        abortListener = () => {
          aborted = true;
          finish();
        };
        if (signal.aborted === true) abortListener();
        else signal.addEventListener('abort', abortListener, { once: true });
      }
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined && signal !== undefined) {
      try {
        signal.removeEventListener('abort', abortListener);
      } catch {
        // An already-released signal needs no listener cleanup.
      }
    }
    if (handle !== undefined && handle !== null) {
      try {
        handle.terminate?.();
      } catch (error) {
        logger?.warn?.('[dsh-basemind-plugin] could not terminate the BaseMind version probe: ' + errorMessage(error));
      }
      try {
        await handle.waitForExit?.(AbortSignal.timeout(1000));
      } catch (error) {
        logger?.warn?.('[dsh-basemind-plugin] BaseMind version probe did not report exit: ' + errorMessage(error));
      }
    }
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (aborted) return failure(PROBE_REASONS.aborted, diagnostic(raw));
  if (timedOut) return failure(PROBE_REASONS.timeout, diagnostic(raw));

  const parsed = parseBasemindVersion(raw);
  if (parsed === undefined) {
    if (exitCode !== null && exitCode !== 0) return failure(PROBE_REASONS.unexecutable, diagnostic(raw));
    return failure(PROBE_REASONS.unparsable, diagnostic(raw));
  }

  return { ok: true, raw: raw.trim(), parsed, version: parsed.raw };
}

/**
 * Probe one executable for its BaseMind version. Never throws.
 *
 * `stat` is injectable so tests can describe a file identity without touching it; the
 * default reads the real file so a replaced binary re-probes.
 *
 * @param {{ ctx?: any, exe?: string, platform?: NodeJS.Platform|string, timeoutMs?: number,
 *           signal?: AbortSignal, cache?: any, logger?: any,
 *           stat?: (filePath: string) => { mtimeMs?: number, size?: number } }} [params]
 * @returns {Promise<{ ok: true, raw: string, parsed: object, version: string }
 *           | { ok: false, reason: string, raw?: string }>}
 */
export async function probeExecutable({
  ctx,
  exe,
  platform = process.platform,
  timeoutMs = 5000,
  signal,
  cache,
  logger,
  stat = statSync,
} = {}) {
  const filePath = typeof exe === 'string' ? exe.trim() : '';
  if (filePath === '') return failure(PROBE_REASONS.missing);
  if (signal?.aborted === true) return failure(PROBE_REASONS.aborted);

  let key;
  try {
    key = probeCacheKey(filePath, stat(filePath));
  } catch {
    key = probeCacheKey(filePath, undefined); // no file yet: a later create changes the key
  }

  if (cache !== undefined && cache !== null) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
  }

  const result = await runProbe({ ctx, filePath, platform, timeoutMs, signal, logger });

  if (cache !== undefined && cache !== null) {
    if (result.ok === true || CACHEABLE.has(result.reason)) cache.set(key, result);
  }

  return result;
}
