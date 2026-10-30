import path from 'node:path';

/** Fallback when the validated config does not carry a usable `maxClients`. */
const DEFAULT_MAX_CLIENTS = 32;

/**
 * @typedef {object} WorkspaceSession
 * @property {(signal?: AbortSignal) => Promise<unknown>} [initialize]
 * @property {() => Promise<void>} [close]
 * @property {() => void} [terminateSync]
 */

/**
 * @typedef {object} WorkspaceEntry
 * @property {string} root original root string handed to `createSession`
 * @property {Promise<WorkspaceSession | undefined>} promise in-flight or settled creation
 * @property {WorkspaceSession | undefined} session established session
 */

/**
 * One BaseMind relay per workspace root, with in-flight de-duplication and a
 * shared-lifetime signal.
 *
 * The caller's own `signal` only cancels that caller's WAIT: the session keeps
 * the pool-owned signal so one cancelling caller cannot kill a relay that other
 * callers share.
 *
 * @param {{
 *   config?: { maxClients?: number },
 *   logger?: { warn?: (message: string) => void },
 *   createSession: (root: string, signal: AbortSignal) => Promise<WorkspaceSession>,
 *   platform?: string,
 * }} options
 * @returns {{
 *   clientFor: (root: string, signal?: AbortSignal) => Promise<WorkspaceSession>,
 *   drop: (root: string) => Promise<void>,
 *   terminateSyncAll: () => void,
 *   disposeAll: () => Promise<void>,
 *   has: (root: string) => boolean,
 *   readonly size: number,
 *   readonly roots: string[],
 * }}
 */
export function createWorkspacePool({ config, logger, createSession, platform = process.platform } = {}) {
  if (typeof createSession !== 'function') {
    throw new TypeError('createWorkspacePool: createSession(root, signal) must be injected');
  }

  const maxClients =
    typeof config?.maxClients === 'number' && Number.isFinite(config.maxClients) && config.maxClients >= 0
      ? config.maxClients
      : DEFAULT_MAX_CLIENTS;
  const caseInsensitive = platform === 'win32';

  /** @type {Map<string, WorkspaceEntry>} */
  const entries = new Map();
  /** Pool-owned lifetime; aborted by `disposeAll` (and never by a caller). */
  const controller = new AbortController();

  /**
   * @param {string} root
   * @returns {string}
   */
  function keyFor(root) {
    const resolved = path.resolve(root);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  }

  /** @returns {string[]} */
  function rootList() {
    return [...entries.values()].map((entry) => entry.root);
  }

  /** @param {string} message */
  function warn(message) {
    logger?.warn?.(message);
  }

  /**
   * Rejection used only for a cancelled WAIT, never for session lifecycle.
   *
   * @param {string} root
   * @param {AbortSignal} signal
   * @returns {Error}
   */
  function abortError(root, signal) {
    const error = new Error(`Waiting for the BaseMind session for "${root}" was cancelled`);
    error.name = 'AbortError';
    if (signal.reason !== undefined) error.cause = signal.reason;
    return error;
  }

  /**
   * Await an entry, but let the caller's signal cancel only this wait.
   *
   * @param {WorkspaceEntry} entry
   * @param {AbortSignal} [signal]
   * @returns {Promise<WorkspaceSession>}
   */
  function waitForEntry(entry, signal) {
    const promise = entry.promise;
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError(entry.root, signal));

    return new Promise((resolve, reject) => {
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortError(entry.root, signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      promise.then(
        (session) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(session);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * Get (or lazily create) the session for one workspace root.
   *
   * @param {string} root
   * @param {AbortSignal} [signal] caller cancellation; cancels only this wait
   * @returns {Promise<WorkspaceSession>}
   */
  async function clientFor(root, signal) {
    const key = keyFor(root);

    const existing = entries.get(key);
    if (existing) return waitForEntry(existing, signal);

    if (signal?.aborted) throw abortError(root, signal);

    if (entries.size >= maxClients) {
      const active = rootList();
      throw new Error(
        `BASEMIND_TOO_MANY_WORKSPACES: refusing to start a BaseMind relay for "${root}"; ` +
          `${entries.size} of ${maxClients} workspace sessions are active` +
          `${active.length > 0 ? ` (${active.join(', ')})` : ''}. ` +
          'Close some workspaces or raise "maxClients" in the dsh-basemind plugin config.',
      );
    }

    /** @type {WorkspaceEntry} */
    const entry = { root, promise: /** @type {any} */ (undefined), session: undefined };

    // A synchronous throw from createSession never got an entry, so the next
    // call simply retries.
    const created = createSession(root, controller.signal);

    // Store the entry before awaiting it so concurrent callers de-duplicate.
    const promise = Promise.resolve(created)
      .then((session) => {
        entry.session = session;
        return session;
      })
      .catch((error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
    entry.promise = promise;
    entries.set(key, entry);
    // Keep a handler attached so an abandoned/failed entry never becomes an
    // unhandled rejection; awaiting `promise` still rethrows the original error.
    promise.catch(() => {});

    return waitForEntry(entry, signal);
  }

  /**
   * Close and forget one root. Resolves for unknown roots.
   *
   * @param {string} root
   * @returns {Promise<void>}
   */
  async function drop(root) {
    const key = keyFor(root);
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);

    const session = await entry.promise.catch(() => undefined);
    if (!session) return;

    try {
      session.terminateSync?.();
    } catch (error) {
      warn(`BaseMind session terminateSync failed for "${entry.root}": ${error?.message ?? error}`);
    }
    try {
      await session.close?.();
    } catch (error) {
      warn(`BaseMind session close failed for "${entry.root}": ${error?.message ?? error}`);
    }
  }

  /**
   * Terminate every established session synchronously, without waiting for exit.
   * Called first during teardown so no child outlives cleanup.
   */
  function terminateSyncAll() {
    for (const entry of entries.values()) {
      const session = entry.session;
      if (!session) continue;
      try {
        session.terminateSync?.();
      } catch (error) {
        warn(`BaseMind session terminateSync failed for "${entry.root}": ${error?.message ?? error}`);
      }
    }
  }

  /**
   * Abort the pool lifetime, terminate every session, await all closes and
   * clear the map. Never throws.
   *
   * @returns {Promise<void>}
   */
  async function disposeAll() {
    try {
      controller.abort();
    } catch {
      // Aborting an already-aborted controller is a no-op; ignore any anomaly.
    }
    terminateSyncAll();

    /** @type {Promise<void>[]} */
    const closings = [];
    for (const entry of entries.values()) {
      closings.push(
        (async () => {
          // A still-pending creation is awaited with a rejection guard.
          const session = await entry.promise.catch(() => undefined);
          if (!session) return;
          await session.close?.();
        })(),
      );
    }

    const results = await Promise.allSettled(closings);
    for (const result of results) {
      if (result.status === 'rejected') {
        warn(`BaseMind session close failed during dispose: ${result.reason?.message ?? result.reason}`);
      }
    }

    entries.clear();
  }

  return {
    clientFor,
    drop,
    terminateSyncAll,
    disposeAll,
    /** @param {string} root */
    has(root) {
      return entries.has(keyFor(root));
    },
    get size() {
      return entries.size;
    },
    get roots() {
      return rootList();
    },
  };
}
