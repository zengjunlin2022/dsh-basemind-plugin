/**
 * Newline-delimited JSON-RPC 2.0 client for a BaseMind `serve` child process on stdio.
 *
 * Design notes:
 * - The subprocess handle is injected (`options.spawn`), so tests never touch real
 *   processes and production passes `(spec) => ctx.subprocess.spawn(spec)`.
 * - A caller abort only cancels the in-flight JSON-RPC request; it never terminates
 *   the child. Only `close()` / `terminateSync()` end the process.
 * - There is no automatic respawn: a dead relay is reported through `onClose` and the
 *   owner decides when to build a new client.
 * - Node >= 22 built-ins only, zero dependencies.
 *
 * @module lib/stdio-client
 */

import { StringDecoder } from 'node:string_decoder';

/** JSON-RPC error code used for client requests we do not implement. */
const METHOD_NOT_SUPPORTED = -32601;
/** JSON-RPC error code servers use to reject a protocol version. */
const INVALID_PARAMS = -32602;

/** @param {unknown} chunk @param {StringDecoder} decoder */
function toText(chunk, decoder) {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return decoder.write(chunk);
  return String(chunk ?? '');
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Create a stdio JSON-RPC client for one BaseMind relay process.
 *
 * @param {{
 *   argv: readonly string[],
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv|Record<string, string>,
 *   startupTimeoutMs?: number,
 *   toolCallTimeoutMs?: number,
 *   protocolVersions?: readonly string[],
 *   clientInfo?: { name: string, version: string },
 *   logger?: any,
 *   spawn: (spec: any) => any,
 *   onNotification?: (message: any) => void,
 *   onClose?: (error?: Error) => void,
 *   maxLineBytes?: number,
 *   stderrTailBytes?: number,
 * }} options
 */
export function createStdioClient(options = {}) {
  const {
    argv,
    cwd,
    env,
    startupTimeoutMs = 60000,
    toolCallTimeoutMs = 120000,
    protocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05'],
    clientInfo = { name: 'dsh-basemind-plugin', version: '0.1.0' },
    logger,
    spawn,
    onNotification,
    onClose,
    maxLineBytes = 16 * 1024 * 1024,
    stderrTailBytes = 8192,
  } = options;

  if (typeof spawn !== 'function') {
    throw new TypeError('createStdioClient requires a spawn function: (spec) => SubprocessHandle');
  }

  const versions = Array.isArray(protocolVersions) && protocolVersions.length > 0 ? [...protocolVersions] : ['2025-06-18'];

  /** @type {any} */
  let handle = null;
  /** @type {(() => void)|null} */
  let detachHandle = null;
  /** @type {Map<number|string, any>} */
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  /** @type {Error|null} */
  let closedError = null;
  let onCloseCalled = false;
  let started = false;
  /** @type {Promise<void>|null} */
  let closePromise = null;

  let stdoutBuffer = '';
  let stdoutBufferBytes = 0;
  const stdoutDecoder = new StringDecoder('utf8');
  let stderrText = '';
  const stderrDecoder = new StringDecoder('utf8');
  /** @type {{ exitCode?: number|null, signal?: string|null }|null} */
  let exitFacts = null;

  // ---------------------------------------------------------------- writing ---

  /**
   * Write one JSON-RPC message. Returns false when no writable stdin exists.
   * Backpressure (`stdin.write` returning false) is intentionally ignored: MCP
   * messages are small and tool calls are serialized by the owner.
   * @param {any} message
   * @returns {boolean}
   */
  function writeMessage(message) {
    const stdin = handle?.stdin;
    if (!stdin || typeof stdin.write !== 'function') return false;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      logger?.warn?.(`basemind: could not write ${message?.method ?? 'a message'} to the relay: ${errorMessage(error)}`);
      return false;
    }
  }

  /** @param {any} entry */
  function cleanupEntry(entry) {
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.onAbort && entry.signal) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort);
      } catch {
        // ignore: a foreign AbortSignal implementation may not support removal
      }
      entry.onAbort = null;
    }
  }

  /** @param {Error} error */
  function rejectAllPending(error) {
    for (const [id, entry] of [...pending.entries()]) {
      pending.delete(id);
      cleanupEntry(entry);
      entry.reject(error);
    }
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   * @param {string} method
   * @param {any} [params]
   * @returns {void}
   */
  function notify(method, params) {
    if (closed) return;
    /** @type {any} */
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    writeMessage(message);
  }

  // -------------------------------------------------------------- lifecycle ---

  /**
   * Close bookkeeping: mark closed, reject pending, notify the owner exactly once.
   * @param {Error} error
   * @param {{ notifyOwner?: boolean }} [options]
   */
  function markClosed(error, { notifyOwner = true } = {}) {
    if (closed) return;
    closed = true;
    closedError = error;
    rejectAllPending(error);
    if (notifyOwner && !onCloseCalled) {
      onCloseCalled = true;
      try {
        onClose?.(error);
      } catch (callbackError) {
        logger?.warn?.(`basemind: onClose callback threw: ${errorMessage(callbackError)}`);
      }
    }
  }

  /** Human-readable exit facts for error messages. */
  function describeExit() {
    if (!exitFacts) return '';
    const parts = [];
    if (exitFacts.exitCode !== undefined) parts.push(`exit code ${exitFacts.exitCode}`);
    if (exitFacts.signal !== undefined && exitFacts.signal !== null) parts.push(`signal ${exitFacts.signal}`);
    return parts.join(', ');
  }

  /** Trailing stderr for error messages (2 KiB max, trimmed). */
  function stderrSuffix() {
    const tail = stderrText.trim();
    return tail === '' ? '' : `\nstderr tail:\n${tail.slice(-2048)}`;
  }

  /**
   * Unexpected end of the relay: reject pending work and report once.
   * @param {string} why
   * @param {{ exitCode?: number|null, signal?: string|null }} info
   * @param {unknown} [cause]
   */
  function handleProcessEnd(why, info, cause) {
    if (closed) return;
    exitFacts = {
      exitCode: info?.exitCode ?? null,
      signal: info?.signal ?? null,
    };
    const facts = describeExit();
    const detail = facts === '' ? why : `${why} (${facts})`;
    const causeText = cause === undefined ? '' : `: ${errorMessage(cause)}`;
    const error = new Error(`basemind relay ended: ${detail}${causeText}${stderrSuffix()}`);
    error.exitCode = exitFacts.exitCode;
    error.signal = exitFacts.signal;
    error.stderrTail = stderrText;
    markClosed(error);
  }

  /** @param {any} chunk */
  function feedStderr(chunk) {
    stderrText += toText(chunk, stderrDecoder);
    if (stderrText.length > stderrTailBytes) {
      stderrText = stderrText.slice(-stderrTailBytes);
    }
  }

  // ------------------------------------------------------------- stdout feed ---

  /** Line-exceeded guard: the relay is unusable, close and reject everything. */
  function abortOversizedLine() {
    const error = new Error(
      `basemind relay emitted a stdout line larger than ${maxLineBytes} bytes; closing the connection`,
    );
    if (closed) return;
    markClosed(error);
    void close();
  }

  /** @param {string} chunk */
  function feedStdout(chunk) {
    if (closed) return;
    const text = toText(chunk, stdoutDecoder);
    stdoutBuffer += text;
    stdoutBufferBytes += Buffer.byteLength(text, 'utf8');

    if (!stdoutBuffer.includes('\n')) {
      if (stdoutBufferBytes > maxLineBytes) abortOversizedLine();
      return;
    }

    const parts = stdoutBuffer.split('\n');
    stdoutBuffer = parts.pop() ?? '';
    for (const part of parts) {
      handleLine(part.endsWith('\r') ? part.slice(0, -1) : part);
      if (closed) return; // a handler may have closed the client
    }
    stdoutBufferBytes = Buffer.byteLength(stdoutBuffer, 'utf8');
    if (stdoutBufferBytes > maxLineBytes) abortOversizedLine();
  }

  /**
   * Dispatch one complete stdout line: response, notification, or server request.
   * @param {string} line
   */
  function handleLine(line) {
    const text = line.trim();
    if (text === '') return;

    /** @type {any} */
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      logger?.warn?.(`basemind relay emitted malformed JSON on stdout (${text.length} chars); line skipped`);
      return;
    }

    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      logger?.warn?.('basemind relay emitted a non-object JSON-RPC message on stdout; line skipped');
      return;
    }

    const hasId = message.id !== undefined && message.id !== null;
    const method = typeof message.method === 'string' ? message.method : undefined;

    if (method === undefined) {
      // Response.
      if (!hasId) {
        logger?.warn?.('basemind relay emitted a response without an id; line skipped');
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return; // late response for a cancelled/timed-out request
      pending.delete(message.id);
      cleanupEntry(entry);
      if (message.error !== undefined) {
        entry.reject(jsonRpcError(message.error, entry.method));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (!hasId) {
      // Notification.
      if (typeof onNotification !== 'function') return;
      try {
        onNotification(message);
      } catch (error) {
        logger?.warn?.(`basemind: onNotification callback threw: ${errorMessage(error)}`);
      }
      return;
    }

    replyToServerRequest(message);
  }

  /**
   * Reply to a server-initiated request per MCP.
   * @param {any} message
   */
  function replyToServerRequest(message) {
    const { id, method } = message;
    /** @type {any} */
    let response;
    if (method === 'ping') {
      response = { jsonrpc: '2.0', id, result: {} };
    } else if (method === 'roots/list') {
      response = { jsonrpc: '2.0', id, result: { roots: [] } };
    } else {
      // sampling/createMessage, elicitation/create, completions/complete and anything
      // else unknown: DSH has no channel for these, so answer with a JSON-RPC error.
      response = {
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_SUPPORTED, message: `method not supported by dsh-basemind-plugin: ${method}` },
      };
      logger?.warn?.(`basemind server requested unsupported method '${method}'; replied -32601`);
    }
    writeMessage(response);
  }

  /**
   * Build an Error from a JSON-RPC error object, keeping the code.
   * @param {any} error
   * @param {string} method
   * @returns {Error}
   */
  function jsonRpcError(error, method) {
    const message = typeof error?.message === 'string' && error.message !== '' ? error.message : 'unknown JSON-RPC error';
    const result = new Error(`basemind ${method} failed: ${message}`);
    if (error?.code !== undefined) result.code = error.code;
    if (error?.data !== undefined) result.data = error.data;
    return result;
  }

  /** @param {string} method */
  function abortError(method) {
    const error = new Error(`basemind request '${method}' was aborted by the caller`);
    error.name = 'AbortError';
    return error;
  }

  // ---------------------------------------------------------------- process ---

  /**
   * Attach listeners for one handle. Listeners ignore events from a handle that is no
   * longer current, which keeps protocol-version retries from looking like crashes.
   * @param {any} target
   */
  function attachHandle(target) {
    const stdout = target?.stdout;
    const stderr = target?.stderr;
    const stdin = target?.stdin;
    const isCurrent = () => handle === target;

    const onStdout = (chunk) => {
      if (isCurrent()) feedStdout(chunk);
    };
    const onStderr = (chunk) => {
      if (isCurrent()) feedStderr(chunk);
    };
    const onEnd = () => {
      if (isCurrent()) handleProcessEnd('stdout closed', { exitCode: null, signal: null });
    };
    const onStdinError = (error) => {
      if (isCurrent()) logger?.warn?.(`basemind relay stdin error: ${errorMessage(error)}`);
    };

    stdout?.on?.('data', onStdout);
    stdout?.on?.('end', onEnd);
    stdout?.on?.('close', onEnd);
    stderr?.on?.('data', onStderr);
    stdin?.on?.('error', onStdinError);

    const done = target?.done;
    if (done && typeof done.then === 'function') {
      done.then(
        (info) => {
          if (isCurrent()) handleProcessEnd('relay process exited', { exitCode: info?.exitCode ?? null, signal: info?.signal ?? null });
        },
        (error) => {
          if (isCurrent()) handleProcessEnd('relay process failed', { exitCode: null, signal: null }, error);
        },
      );
    }

    return () => {
      stdout?.off?.('data', onStdout);
      stdout?.off?.('end', onEnd);
      stdout?.off?.('close', onEnd);
      stderr?.off?.('data', onStderr);
      stdin?.off?.('error', onStdinError);
    };
  }

  /** Terminate one handle without touching client-level `closed` state. */
  async function terminateHandle(target) {
    if (!target) return;
    try {
      target.stdin?.end?.();
    } catch (error) {
      logger?.warn?.(`basemind relay stdin.end() failed: ${errorMessage(error)}`);
    }
    try {
      target.terminate?.();
    } catch (error) {
      logger?.warn?.(`basemind relay terminate() failed: ${errorMessage(error)}`);
    }
    try {
      const exited = await target.waitForExit?.(AbortSignal.timeout(3000));
      if (exited === false) logger?.warn?.('basemind relay did not exit within 3000 ms after terminate()');
    } catch (error) {
      logger?.warn?.(`basemind relay waitForExit() failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Spawn once and run the initialize handshake for one protocol version.
   * @param {string} protocolVersion
   * @param {AbortSignal|undefined} signal
   */
  async function spawnAndInitialize(protocolVersion, signal) {
    /** @type {any} */
    const spec = {
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
    };
    if (env) spec.env = env;

    const target = spawn(spec);
    if (!target) throw new Error('basemind: the subprocess provider returned no handle');

    handle = target;
    stdoutBuffer = '';
    stdoutBufferBytes = 0;
    detachHandle = attachHandle(target);

    const result = await request(
      'initialize',
      { protocolVersion, capabilities: {}, clientInfo },
      { signal, timeoutMs: startupTimeoutMs },
    );

    if (result === null || typeof result !== 'object') {
      throw new Error(`basemind relay returned an invalid initialize result for protocol ${protocolVersion}`);
    }

    notify('notifications/initialized');

    return {
      protocolVersion: typeof result.protocolVersion === 'string' ? result.protocolVersion : protocolVersion,
      serverInfo: result.serverInfo,
      capabilities: result.capabilities ?? {},
      instructions: result.instructions,
    };
  }

  // ------------------------------------------------------------------- API ---

  /**
   * Spawn the relay and complete the MCP initialize handshake.
   * Tries each protocol version in order; a `-32602` (or a "protocol version"
   * rejection) restarts the process with the next version.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ protocolVersion: string, serverInfo: any, capabilities: any, instructions: string|undefined }>}
   */
  async function start(signal) {
    if (started) throw new Error('basemind: start() may only be called once per client');
    started = true;

    if (closed) throw closedError ?? new Error('basemind: client is already closed');

    /** @type {unknown} */
    let lastError;
    for (let index = 0; index < versions.length; index += 1) {
      const protocolVersion = versions[index];
      const hasNext = index < versions.length - 1;
      try {
        return await spawnAndInitialize(protocolVersion, signal);
      } catch (error) {
        lastError = error;
        const retry = hasNext && isProtocolVersionRejection(error);
        // Discard this process before retrying (or before surfacing the failure).
        detachHandle?.();
        detachHandle = null;
        const discarded = handle;
        handle = null;
        await terminateHandle(discarded);
        if (closed) throw closedError ?? error;
        if (!retry) throw error;
        logger?.warn?.(
          `basemind relay rejected protocol version ${protocolVersion} (${errorMessage(error)}); ` +
            `retrying with ${versions[index + 1]}`,
        );
      }
    }

    throw lastError ?? new Error('basemind: no protocol version could be negotiated');
  }

  /** @param {unknown} error */
  function isProtocolVersionRejection(error) {
    if (!error || typeof error !== 'object') return false;
    if (error.code === INVALID_PARAMS) return true;
    return /protocol version/i.test(errorMessage(error));
  }

  /**
   * Send one request and await its response.
   * @param {string} method
   * @param {any} [params]
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [requestOptions]
   * @returns {Promise<any>}
   */
  function request(method, params, requestOptions = {}) {
    const { signal, timeoutMs } = requestOptions ?? {};

    if (closed) {
      const detail = closedError ? `: ${closedError.message}` : '';
      return Promise.reject(new Error(`basemind relay is closed; cannot send '${method}'${detail}`));
    }
    if (signal?.aborted) return Promise.reject(abortError(method));

    const timeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : toolCallTimeoutMs;
    const id = (nextId += 1);

    return new Promise((resolve, reject) => {
      /** @type {any} */
      const entry = { id, method, resolve, reject, timer: null, signal: null, onAbort: null };
      pending.set(id, entry);

      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanupEntry(entry);
          notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
          reject(new Error(`basemind request '${method}' timed out after ${timeout} ms`));
        }, timeout);
        entry.timer.unref?.();
      }

      if (signal) {
        entry.signal = signal;
        entry.onAbort = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanupEntry(entry);
          notify('notifications/cancelled', { requestId: id, reason: 'aborted' });
          reject(abortError(method));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      /** @type {any} */
      const message = { jsonrpc: '2.0', id, method };
      if (params !== undefined) message.params = params;

      if (!writeMessage(message)) {
        pending.delete(id);
        cleanupEntry(entry);
        reject(new Error(`basemind relay is not writable; '${method}' was not sent`));
      }
    });
  }

  /**
   * Close the relay: reject pending work, end stdin, terminate, wait up to 3 s.
   * Idempotent and never throws.
   * @returns {Promise<void>}
   */
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        if (!closed) {
          // Owner-initiated close: do not report it through onClose.
          markClosed(new Error('basemind relay closed by caller'), { notifyOwner: false });
        }
        detachHandle?.();
        detachHandle = null;
        const target = handle;
        handle = null;
        await terminateHandle(target);
      } catch (error) {
        logger?.warn?.(`basemind relay close failed: ${errorMessage(error)}`);
      }
    })();
    return closePromise;
  }

  /**
   * Synchronous teardown used first during plugin shutdown: only `terminate()`,
   * no bookkeeping and no waiting, so the child dies even if cleanup is skipped.
   * @returns {void}
   */
  function terminateSync() {
    try {
      handle?.terminate?.();
    } catch (error) {
      logger?.warn?.(`basemind relay terminateSync failed: ${errorMessage(error)}`);
    }
  }

  return {
    start,
    request,
    notify,
    close,
    terminateSync,
    get closed() {
      return closed;
    },
    get stderrTail() {
      return stderrText;
    },
  };
}
