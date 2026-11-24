/**
 * Download one official BaseMind release asset to disk while verifying its sha256.
 *
 * The asset is streamed to `destFile` and hashed on the way through; it is never held in
 * memory. Redirects are followed manually (at most five hops, every hop must stay on an
 * allowlisted host), a declared Content-Length above the limit fails before the body is
 * read, and a digest mismatch deletes the file so an unverified binary can never be
 * executed by a later step.
 *
 * Only `https` URLs are accepted. `allowInsecure` exists for unit tests that serve
 * fixtures over a loopback `node:http` server; it is never plumbed through from user
 * configuration.
 *
 * @module dsh-basemind-plugin/lib/binary/download
 */

import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';

/** Official GitHub release hosts that may serve the asset or a redirect. */
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/** Hard cap for one release archive (the Windows zip is ~72 MiB). */
const MAX_BYTES = 400 * 1024 * 1024;

/** Redirect hops allowed before the download fails. */
const MAX_REDIRECTS = 5;

/** Backoff before retry 1 and retry 2 (two extra attempts at most). */
const RETRY_DELAYS_MS = Object.freeze([1000, 4000]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DIAGNOSTIC_LIMIT = 128;

/**
 * A managed-binary download failure.
 *
 * `code` is one of `bad-url`, `redirect`, `http-status`, `too-large`, `checksum-mismatch`,
 * `timeout`, `network`, `aborted`, `io`. `status` carries the HTTP status for
 * `http-status` failures.
 */
export class DownloadError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [options]
   */
  constructor(code, message, { status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DownloadError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * @param {unknown} hostname
 * @returns {string}
 */
function normalizeHost(hostname) {
  return String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
}

/**
 * @param {readonly string[]|undefined} hosts
 * @returns {string[]}
 */
function normalizeHosts(hosts) {
  const source = Array.isArray(hosts) && hosts.length > 0 ? hosts : DEFAULT_ALLOWED_HOSTS;
  return source.map((host) => normalizeHost(host)).filter((host) => host !== '');
}

/**
 * Validate one URL against the scheme, credential and host rules.
 * @param {string} rawUrl
 * @param {{ allowedHosts: string[], allowInsecure: boolean, errorCode: string }} rules
 * @returns {string} the normalized URL string
 */
function checkUrl(rawUrl, { allowedHosts, allowInsecure, errorCode }) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DownloadError(errorCode, 'not a valid download URL: ' + String(rawUrl).slice(0, DIAGNOSTIC_LIMIT));
  }

  if (parsed.protocol !== 'https:' && !(allowInsecure === true && parsed.protocol === 'http:')) {
    throw new DownloadError(
      errorCode,
      'refusing a ' + parsed.protocol + ' download URL (' + parsed.host + '); managed binaries are downloaded over https only',
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new DownloadError(errorCode, 'refusing a download URL with embedded credentials');
  }

  const host = normalizeHost(parsed.hostname);
  if (!allowedHosts.includes(host)) {
    throw new DownloadError(
      errorCode,
      'refusing download host ' +
        JSON.stringify(host) +
        '; allowed hosts are ' +
        allowedHosts.join(', ') +
        ' (official BaseMind releases are served from github.com)',
    );
  }

  return parsed.toString();
}

/**
 * Release a response body we are not going to read, so the socket is not held open.
 * @param {any} response
 */
async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Nothing to release.
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryable(error) {
  const failure = /** @type {any} */ (error);
  if (failure?.code === 'network') return true;
  if (failure?.code !== 'http-status') return false;
  return failure.status === 429 || (typeof failure.status === 'number' && failure.status >= 500);
}

/**
 * @param {unknown} error
 * @param {boolean} timedOut
 * @param {AbortSignal|undefined} signal
 * @returns {DownloadError}
 */
function classify(error, timedOut, signal) {
  if (error instanceof DownloadError) return error;
  if (signal?.aborted === true) {
    return new DownloadError('aborted', 'the managed binary download was aborted by the caller', { cause: error });
  }
  if (timedOut) {
    return new DownloadError('timeout', 'the managed binary download timed out', { cause: error });
  }
  return new DownloadError('network', 'the managed binary download failed: ' + errorMessage(error), { cause: error });
}

/**
 * One download attempt: follow redirects, stream to disk, verify the digest and clean
 * up the partial file on every failure.
 * @param {{ url: string, destFile: string, expected: string, fetchImpl: Function,
 *           limits: { allowedHosts: string[], maxBytes: number, connectTimeoutMs: number,
 *                     totalTimeoutMs: number, allowInsecure: boolean },
 *           signal?: AbortSignal, fs: { open: Function, unlink: Function } }} params
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
async function runAttempt({ url, destFile, expected, fetchImpl, limits, signal, fs }) {
  const controller = new AbortController();
  const hash = createHash('sha256');
  let timedOut = false;

  /** @type {NodeJS.Timeout|undefined} */
  let totalTimer;
  /** @type {NodeJS.Timeout|undefined} */
  let connectTimer;
  /** @type {(() => void)|undefined} */
  let abortListener;
  /** @type {any} */
  let handle;
  let written = 0;

  try {
    if (signal?.aborted === true) {
      throw new DownloadError('aborted', 'the caller aborted the managed binary download before it started');
    }
    abortListener = () => controller.abort();
    signal?.addEventListener?.('abort', abortListener, { once: true });

    totalTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.totalTimeoutMs);
    totalTimer.unref?.();

    let currentUrl = url;
    /** @type {any} */
    let response;

    for (let hops = 0; ; hops += 1) {
      currentUrl = checkUrl(currentUrl, {
        allowedHosts: limits.allowedHosts,
        allowInsecure: limits.allowInsecure,
        errorCode: hops === 0 ? 'bad-url' : 'redirect',
      });

      connectTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limits.connectTimeoutMs);
      connectTimer.unref?.();

      try {
        response = await fetchImpl(currentUrl, { method: 'GET', redirect: 'manual', signal: controller.signal });
      } finally {
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
      }

      if (!REDIRECT_STATUSES.has(response.status)) break;

      const location = response.headers.get('location');
      await discardBody(response);
      if (hops >= MAX_REDIRECTS) {
        throw new DownloadError('redirect', 'more than ' + MAX_REDIRECTS + ' redirects while downloading ' + url);
      }
      if (typeof location !== 'string' || location === '') {
        throw new DownloadError('redirect', 'redirect without a location header from ' + currentUrl, {
          status: response.status,
        });
      }
      currentUrl = new URL(location, currentUrl).toString();
    }

    if (response.status !== 200) {
      await discardBody(response);
      throw new DownloadError('http-status', 'HTTP ' + response.status + ' for ' + currentUrl, {
        status: response.status,
      });
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      await discardBody(response);
      throw new DownloadError(
        'too-large',
        'the asset declares ' + declared + ' bytes, above the ' + limits.maxBytes + ' byte limit',
      );
    }

    const body = response.body;
    if (body === null || body === undefined) throw new DownloadError('network', 'the response has no body');

    try {
      handle = await fs.open(destFile, 'w');
    } catch (error) {
      throw new DownloadError('io', 'could not open ' + destFile + ' for writing: ' + errorMessage(error), {
        cause: error,
      });
    }

    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += buffer.length;
      if (written > limits.maxBytes) {
        throw new DownloadError('too-large', 'the asset exceeded the ' + limits.maxBytes + ' byte limit while downloading');
      }
      hash.update(buffer);
      try {
        await handle.write(buffer);
      } catch (error) {
        throw new DownloadError('io', 'could not write ' + destFile + ': ' + errorMessage(error), { cause: error });
      }
    }

    await handle.close();
    handle = undefined;

    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new DownloadError(
        'checksum-mismatch',
        'sha256 mismatch for ' +
          destFile +
          ': the checksums file expects ' +
          expected +
          ' but the download hashed to ' +
          actual +
          '; refusing to use an unverified binary',
      );
    }

    return { sha256: actual, bytes: written };
  } catch (error) {
    const failure = classify(error, timedOut, signal);
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The file is being discarded anyway.
      }
      handle = undefined;
    }
    try {
      await fs.unlink(destFile);
    } catch {
      // No partial file was created.
    }
    throw failure;
  } finally {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    if (abortListener !== undefined && signal !== undefined) {
      try {
        signal.removeEventListener('abort', abortListener);
      } catch {
        // An already-released signal needs no listener cleanup.
      }
    }
  }
}

/**
 * Download one asset to `destFile` and verify its sha256.
 *
 * Retries: 429, 5xx and transport errors get at most two extra attempts (after 1 s and
 * 4 s, via the injected `sleep`); a checksum mismatch, a too-large asset, a timeout, an
 * abort or a 4xx response fails on the first attempt.
 *
 * @param {{ url?: string, destFile?: string, sha256?: string, fetchImpl?: Function,
 *           allowedHosts?: readonly string[], maxBytes?: number, connectTimeoutMs?: number,
 *           totalTimeoutMs?: number, signal?: AbortSignal, logger?: any, sleep?: Function,
 *           fs?: { open: Function, unlink: Function }, allowInsecure?: boolean }} [params]
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export async function downloadVerified({
  url,
  destFile,
  sha256,
  fetchImpl = globalThis.fetch,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  maxBytes = MAX_BYTES,
  connectTimeoutMs = 30000,
  totalTimeoutMs = 900000,
  signal,
  logger,
  sleep = defaultSleep,
  fs = { open, unlink },
  allowInsecure = false,
} = {}) {
  const expected = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
  if (!SHA256_HEX.test(expected)) {
    throw new DownloadError('bad-url', 'downloadVerified needs the expected sha256 (64 hex characters)');
  }
  if (typeof destFile !== 'string' || destFile.trim() === '') {
    throw new DownloadError('io', 'downloadVerified needs a destination file path');
  }
  if (typeof fetchImpl !== 'function') {
    throw new DownloadError('network', 'no fetch implementation is available for the managed binary download');
  }

  const limits = {
    allowedHosts: normalizeHosts(allowedHosts),
    maxBytes: positiveNumber(maxBytes, MAX_BYTES),
    connectTimeoutMs: positiveNumber(connectTimeoutMs, 30000),
    totalTimeoutMs: positiveNumber(totalTimeoutMs, 900000),
    allowInsecure: allowInsecure === true,
  };

  const startUrl = checkUrl(url, { ...limits, errorCode: 'bad-url' });

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runAttempt({ url: startUrl, destFile, expected, fetchImpl, limits, signal, fs });
    } catch (error) {
      const failure = error instanceof DownloadError ? error : classify(error, false, signal);
      if (attempt > RETRY_DELAYS_MS.length || signal?.aborted === true || !isRetryable(failure)) throw failure;
      const delay = RETRY_DELAYS_MS[attempt - 1];
      logger?.warn?.(
        '[dsh-basemind-plugin] managed binary download attempt ' +
          attempt +
          ' failed (' +
          failure.code +
          ': ' +
          failure.message +
          '); retrying in ' +
          delay +
          ' ms',
      );
      await sleep(delay);
    }
  }
}
