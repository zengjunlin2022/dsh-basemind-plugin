/**
 * Integration test against a real BaseMind installation.
 *
 * This is the only test here that talks to the real `basemind` binary: it drives the
 * plugin's own stack (`resolveLaunch` -> `createStdioClient` -> `createMcpSession`)
 * over a `ctx.subprocess` adapter built on `node:child_process`, because DSH's
 * subprocess service does not exist in a plain `node --test` run.
 *
 * The whole file skips cleanly when no `basemind` is available, unless
 * `BASEMIND_REQUIRE_INTEGRATION=1` is set: then a missing binary fails the suite
 * instead of skipping it, so a release gate can never pass on a skip.
 *
 * `BASEMIND_BIN` overrides the PATH lookup, which is how the compat matrix runs one
 * specific BaseMind build (for example the 0.33 legacy smoke test).
 *
 * Measured BaseMind 0.34.0 facts this file relies on:
 * - On Windows `basemind` resolves to a `.cmd` launcher, so the argv is
 *   `cmd.exe /d /s /c <launcher> serve --root .` and the child runs with
 *   `cwd = workspace root`.
 * - The serving root comes back with a `\\?\` verbatim prefix, and BaseMind refuses
 *   a root that is neither a git repository nor marked by `basemind.toml`. A fresh
 *   temporary directory therefore gets the minimal marker `basemind init` writes; the
 *   command-line hatch `BASEMIND_ALLOW_ANY_ROOT=1` is not used because `serve` talks
 *   to the BaseMind daemon, which rejects such a relay with `host_build_failed`.
 * - 0.34.0 replaced the mode-dispatch tools with 15 verb tools plus 3 agent tools;
 *   the retired names (`code`, `git`, `memory`, `admin`, `graph`, `web`, `shell`,
 *   `workspace`, `agents`) are not advertised and cannot be called.
 * - A fresh `BASEMIND_DATA_HOME` starts with an empty index: the daemon starts building
 *   it on its own, `index_status` reports `indexing: true` (about 30 s for this
 *   repository) and the read tools fail with "the index is empty" until it clears.
 *   `ensureIndexed()` polls `index_status`; it must not call `index_rescan {}`, which
 *   blocks far longer than any sane tool timeout on a cold cache.
 * - A fixable failure is an `isError` tool result whose `structuredContent` is
 *   `{ error, retryable }`; a retired tool is a JSON-RPC `-32602` instead.
 * - `basemind serve` does not exit when its stdin closes, so teardown must terminate
 *   the launcher process tree (see `adaptChild().terminate()`).
 * - A relay reaches the machine-global daemon unless `BASEMIND_COMMS_DIR` selects a
 *   different daemon namespace, and that daemon writes its cache and workspace
 *   registry under `BASEMIND_DATA_HOME`. Both variables are pinned to a throwaway
 *   directory below so a test run never touches the user's default BaseMind state.
 */

import assert from 'node:assert/strict';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../lib/config.js';
import { resolveLaunch } from '../lib/executable.js';
import { createMcpSession } from '../lib/mcp-session.js';
import { projectContent } from '../lib/result.js';
import { normalizeInputSchema, validateJsonSchemaNode } from '../lib/schema.js';
import { createStdioClient } from '../lib/stdio-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The plugin repository itself: the "real" workspace root of this suite. */
const REPO_ROOT = path.resolve(here, '..');

/**
 * Test-only BaseMind data root.
 *
 * `basemind serve` relays to a daemon selected by `BASEMIND_COMMS_DIR`, and that
 * daemon keeps its cache and workspace registry under `BASEMIND_DATA_HOME`.
 * Without both variables this suite writes into the user's default BaseMind
 * cache/registry. Pin both to one throwaway directory for this test process
 * only; spawned relays inherit it through `scrubEnv(process.env)`.
 *
 * An inherited value is deliberately overridden: a test run must never depend
 * on, or mutate, a data home the caller happens to have configured.
 */
const TEST_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'basemind-test-'));
process.env.BASEMIND_DATA_HOME = path.join(TEST_DATA_ROOT, 'data');
process.env.BASEMIND_COMMS_DIR = path.join(TEST_DATA_ROOT, 'comms');
mkdirSync(process.env.BASEMIND_DATA_HOME, { recursive: true });
mkdirSync(process.env.BASEMIND_COMMS_DIR, { recursive: true });

after(async () => {
  stopTestDaemon();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!(await removeDirectory(TEST_DATA_ROOT))) {
    process.emitWarning(`could not remove the test BaseMind data root ${TEST_DATA_ROOT}`);
  }
});

// Last-resort synchronous cleanup when the worker exits before/without the hook.
process.on('exit', () => {
  try {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  } catch {
    // The daemon may still hold a file; the async hook above already reported it.
  }
});

/** The 15 verb tools BaseMind 0.34.0 advertises. */
const VERB_TOOLS = Object.freeze([
  'code_grep',
  'code_outline',
  'code_read',
  'code_refs',
  'code_search',
  'code_symbols',
  'docs_search',
  'find_files',
  'git_blame',
  'git_diff',
  'git_log',
  'index_rescan',
  'index_status',
  'memory_save',
  'memory_search',
]);

/** The 3 agent tools a comms build adds; a build without comms may omit them. */
const AGENT_TOOLS = Object.freeze(['agent_inbox', 'agent_post', 'agent_threads']);

/** Tool names BaseMind 0.34.0 removed; they must never be advertised again. */
const RETIRED_TOOLS = Object.freeze([
  'admin',
  'agents',
  'code',
  'git',
  'graph',
  'memory',
  'shell',
  'web',
  'workspace',
]);

/** Protocol version BaseMind 0.34.0 negotiates for the first offered version. */
const PROTOCOL_VERSION = '2025-06-18';

/** Generous per-test budget: the first `basemind serve` may start/refresh the daemon. */
const TEST_TIMEOUT_MS = 360_000;

/** How long a cold index build may take before the test fails instead of hanging. */
/**
 * How long a cold index build may take before the test fails instead of hanging.
 *
 * A fresh `BASEMIND_DATA_HOME` builds its first index from scratch: 36 s when this
 * suite runs alone, and more than 150 s while another real-BaseMind suite shares the
 * machine (measured 2026-11-24). The wait polls `index_status`, so a generous ceiling
 * costs nothing on the happy path and only bounds a genuinely stuck daemon.
 */
const INDEX_BUILD_TIMEOUT_MS = 300_000;

/** Minimal durable workspace marker BaseMind accepts (what `basemind init` writes). */
const WORKSPACE_MARKER = '"$schema" = "v1"\n';

/** How long a terminated relay may take to report its exit. */
const EXIT_TIMEOUT_MS = 10_000;

// ----------------------------------------------------------- PATH resolution ---

/**
 * Read an environment entry by exact key or, failing that, case-insensitively
 * (Windows environment blocks are case-insensitive, so `Path` and `PATH` coexist).
 *
 * @param {Record<string, unknown>} [env]
 * @param {string} key
 * @returns {string|undefined}
 */
function lookupEnv(env, key) {
  if (env == null || typeof env !== 'object') return undefined;
  const direct = env[key];
  if (typeof direct === 'string') return direct;
  const lowered = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && name.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Candidate file names for one base path, in lookup order.
 *
 * A name that already carries an extension is only matched verbatim. A bare name is
 * matched through `PATHEXT` first: on Windows the extensionless sibling (Volta ships
 * one) is a POSIX shell script that cannot be spawned, so it must never win.
 *
 * @param {string} basePath
 * @param {Record<string, unknown>} env
 * @returns {string[]}
 */
function candidateFiles(basePath, env) {
  if (path.extname(basePath) !== '') return [basePath];
  const extensions =
    process.platform === 'win32'
      ? (lookupEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
      : [];
  return [...extensions.map((extension) => `${basePath}${extension}`), basePath];
}

/**
 * PATH + PATHEXT lookup, mirroring what DSH's subprocess service does. An existing
 * absolute (or separator-bearing) path is returned unchanged.
 *
 * @param {unknown} command
 * @param {Record<string, unknown>} [env]
 * @returns {string|null} the resolved absolute path, or null when nothing matched.
 */
function findExecutable(command, env = process.env) {
  const text = String(command ?? '').trim();
  if (text === '') return null;

  /** @type {string[]} */
  const candidates = [];
  if (/[\\/]/.test(text)) {
    candidates.push(path.resolve(text));
  } else {
    const searchPath = lookupEnv(env, 'PATH') ?? '';
    for (const directory of searchPath.split(path.delimiter)) {
      if (directory !== '') candidates.push(path.join(directory, text));
    }
  }

  for (const candidate of candidates) {
    for (const file of candidateFiles(candidate, env)) {
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** `BASEMIND_BIN` wins over the PATH lookup; `null` means "no binary". */
const CONFIGURED_BIN = (process.env.BASEMIND_BIN ?? '').trim();

/** Resolved once at module load. */
const BASEMIND_EXE = CONFIGURED_BIN === '' ? findExecutable('basemind') : findExecutable(CONFIGURED_BIN);

/** When set, a missing binary fails the suite instead of skipping it. */
const REQUIRE_INTEGRATION = (process.env.BASEMIND_REQUIRE_INTEGRATION ?? '') !== '';

const TEST_OPTIONS =
  BASEMIND_EXE === null && !REQUIRE_INTEGRATION
    ? { skip: 'basemind is not installed', timeout: TEST_TIMEOUT_MS }
    : { timeout: TEST_TIMEOUT_MS };

before(() => {
  if (CONFIGURED_BIN !== '' && BASEMIND_EXE === null) {
    assert.fail(`BASEMIND_BIN=${CONFIGURED_BIN} was not found; point it at an existing basemind binary`);
  }
  if (REQUIRE_INTEGRATION && BASEMIND_EXE === null) {
    assert.fail('BASEMIND_REQUIRE_INTEGRATION=1 but no basemind binary was found (set BASEMIND_BIN or install basemind)');
  }
});

// ---------------------------------------------------------- subprocess adapter ---

/**
 * Adapt a real child process to the DSH `SubprocessHandle` contract:
 * `{ stdin, stdout, stderr, done, terminate(), waitForExit(signal) }`.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function adaptChild(child) {
  /** @type {{ exitCode: number|null, signal: string|null, error?: Error }|null} */
  let exitFacts = null;

  const done = new Promise((resolve) => {
    child.once('exit', (exitCode, signal) => {
      exitFacts = { exitCode, signal: signal ?? null };
      resolve(exitFacts);
    });
    child.once('error', (error) => {
      exitFacts = { exitCode: null, signal: null, error };
      resolve(exitFacts);
    });
  });

  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    /** `null` while the relay is alive; the exit facts afterwards. */
    get exitFacts() {
      return exitFacts;
    },
    terminate() {
      if (exitFacts !== null) return;
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        // The direct child is the `cmd.exe` wrapper of the `.cmd` launcher, so killing
        // it alone would leave the BaseMind process tree running. `/T` ends the whole
        // tree of this exact PID; processes are never matched by name.
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 15_000,
            windowsHide: true,
          });
        } catch {
          // A failing taskkill is not fatal: fall back to the direct child below.
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
        return;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    },
    /**
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>} true once the process has exited.
     */
    waitForExit(signal) {
      if (exitFacts !== null) return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (exited) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          resolve(exited);
        };
        const onAbort = () => finish(false);
        // Safety net only; every caller passes its own bounded AbortSignal.
        const timer = setTimeout(() => finish(false), 60_000);
        timer.unref?.();
        child.once('exit', () => finish(true));
        if (signal?.aborted) finish(false);
        else signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    },
  };
}

/**
 * Build the `ctx.subprocess` surface `lib/executable.js` and `lib/stdio-client.js`
 * need, backed by real child processes.
 */
function createSubprocessAdapter() {
  /** @type {ReturnType<typeof adaptChild>[]} */
  const handles = [];

  const subprocess = {
    /**
     * @param {string} command
     * @param {Record<string, string>} [env]
     * @param {AbortSignal} [signal]
     * @returns {Promise<string>}
     */
    async resolveExecutable(command, env = process.env, signal) {
      signal?.throwIfAborted?.();
      const resolved = findExecutable(command, env ?? process.env);
      if (resolved === null) {
        throw new Error(`subprocess adapter: executable not found on PATH: ${String(command)}`);
      }
      return resolved;
    },

    /** @param {{ argv: string[], cwd?: string, env?: Record<string, string>, stdio?: Record<string, string> }} spec */
    spawn(spec) {
      const mode = (value) => (value === 'ignore' ? 'ignore' : 'pipe');
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: [mode(spec?.stdio?.stdin), mode(spec?.stdio?.stdout), mode(spec?.stdio?.stderr)],
        windowsHide: true,
      });
      const handle = adaptChild(child);
      handles.push(handle);
      return handle;
    },
  };

  return { subprocess, handles };
}

// ------------------------------------------------------------------- helpers ---

/**
 * Start one real BaseMind relay for `root` and complete the MCP handshake.
 *
 * `register` receives the session before the handshake runs, so a test can close it
 * even when `initialize()` throws.
 *
 * @param {{ resolveExecutable: Function, spawn: Function }} subprocess
 * @param {string} root
 * @param {{ register?: (session: any) => void }} [options]
 */
async function startSession(subprocess, root, { register } = {}) {
  const launch = await resolveLaunch({ ctx: { subprocess }, config: resolveConfig({}), root });

  /** @type {ReturnType<typeof adaptChild>|null} */
  let handle = null;
  const client = createStdioClient({
    argv: launch.argv,
    cwd: root,
    env: launch.env,
    startupTimeoutMs: 90_000,
    // Matches the plugin's own default (lib/config.js).
    toolCallTimeoutMs: 120_000,
    spawn: (spec) => {
      handle = subprocess.spawn(spec);
      return handle;
    },
  });
  const session = createMcpSession(client);
  register?.(session);

  const handshake = await session.initialize();
  return { session, handshake, launch, handle };
}

/** Close a session without letting teardown failures mask the test result. */
async function closeQuietly(session) {
  try {
    await session.close();
  } catch {
    // close() is documented as never throwing; a failure here is not the test's subject.
  }
}

/**
 * Ask the throwaway BaseMind daemon to drain and stop.
 *
 * `basemind serve` starts a daemon that outlives the relay and inherits its stdio;
 * left running, it keeps the test worker's pipes open and holds the test data
 * home. `BASEMIND_COMMS_DIR` points this command at the test daemon only.
 */
function stopTestDaemon() {
  if (BASEMIND_EXE === null) return;
  try {
    if (process.platform === 'win32' && BASEMIND_EXE.toLowerCase().endsWith('.cmd')) {
      // A `.cmd` launcher cannot be spawned directly on Windows; cmd.exe owns it.
      spawnSync('cmd.exe', ['/d', '/s', '/c', `"${BASEMIND_EXE}" comms stop`], {
        env: process.env,
        stdio: 'ignore',
        timeout: 15_000,
        windowsHide: true,
      });
      return;
    }
    spawnSync(BASEMIND_EXE, ['comms', 'stop'], {
      env: process.env,
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {
    // No daemon, no basemind, or an already-stopped daemon: nothing to clean.
  }
}

/**
 * Remove a temporary directory, retrying briefly because BaseMind may still be
 * releasing index handles inside it right after the relay exits.
 *
 * @param {string} directory
 * @returns {Promise<boolean>}
 */
async function removeDirectory(directory) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt < 29) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

/**
 * Strip BaseMind's `\\?\` verbatim prefix and resolve the remainder.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value;
  const stripped = text.startsWith('\\\\?\\') ? text.slice(4) : text;
  return path.resolve(stripped);
}

/**
 * Compare a reported serving root with the directory the relay was started for.
 * Windows paths are case-insensitive.
 *
 * @param {unknown} actual
 * @param {string} expected
 * @returns {boolean}
 */
function sameRoot(actual, expected) {
  const left = normalizeRoot(actual);
  const right = normalizeRoot(expected);
  if (left === null || right === null) return false;
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Parse the JSON text of a `tools/call` result, failing with a snippet when the
 * server answered with something that is not JSON.
 *
 * @param {{ content: unknown[] }} result
 * @param {string} label
 * @returns {any}
 */
function jsonText(result, label) {
  const block = Array.isArray(result.content)
    ? result.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    : undefined;
  assert.ok(block, `${label}: the result carries a text content block`);
  try {
    return JSON.parse(block.text);
  } catch {
    assert.fail(`${label}: the text block is not JSON: ${block.text.slice(0, 200)}`);
  }
}

/**
 * @param {{ content?: unknown }} result
 * @returns {string} the first text content block, or `''`.
 */
function textOf(result) {
  const block = Array.isArray(result?.content)
    ? result.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    : undefined;
  return block === undefined ? '' : block.text;
}

/**
 * Read the JSON payload of a status-like result.
 *
 * 0.34.0 sends `structuredContent`; older builds only send the JSON text block.
 *
 * @param {{ structuredContent?: unknown, content?: unknown }} result
 * @returns {any|undefined}
 */
function statusPayload(result) {
  const structured = result?.structuredContent;
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured;
  }
  const text = textOf(result);
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Wait until the test daemon has a usable index.
 *
 * A fresh `BASEMIND_DATA_HOME` starts with `indexing: true`, and every read tool
 * answers with "the index is empty" until it clears. The daemon starts that first
 * build on its own, and `index_status` is the documented readiness probe; polling it
 * is cheap, while `index_rescan {}` on a cold cache blocks for minutes.
 *
 * @param {any} session
 */
async function ensureIndexed(session) {
  let status = statusPayload(await session.callTool('index_status', {}));
  if (status?.indexing !== true) return;
  const deadline = Date.now() + INDEX_BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    status = statusPayload(await session.callTool('index_status', {}));
    if (status?.indexing !== true) return;
  }
  assert.fail(`the BaseMind index did not finish building within ${INDEX_BUILD_TIMEOUT_MS} ms`);
}

// --------------------------------------------------------------------- tests ---

test('negotiates the MCP handshake and advertises exactly the documented tools', TEST_OPTIONS, async (t) => {
  assert.ok(BASEMIND_EXE, 'a real basemind was resolved before this test ran');

  const { subprocess } = createSubprocessAdapter();
  /** @type {any[]} */
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
  });

  const { session, handshake } = await startSession(subprocess, REPO_ROOT, {
    register: (entry) => sessions.push(entry),
  });

  assert.equal(handshake.protocolVersion, PROTOCOL_VERSION, 'the negotiated protocol version');
  assert.ok(handshake.serverInfo !== null && typeof handshake.serverInfo === 'object', 'serverInfo is reported');
  assert.equal(typeof handshake.serverInfo.name, 'string');
  assert.ok(handshake.serverInfo.name.length > 0, 'serverInfo.name is a non-empty string');
  assert.equal(typeof handshake.serverInfo.version, 'string');
  assert.ok(handshake.serverInfo.version.length > 0, 'serverInfo.version is a non-empty string');
  assert.equal(typeof handshake.instructions, 'string');
  assert.ok(handshake.instructions.trim().length > 0, 'instructions is a non-empty string');

  const tools = await session.listTools();
  const names = tools.map((tool) => tool.name);
  for (const required of VERB_TOOLS) {
    assert.ok(names.includes(required), `0.34.0 advertises the verb tool ${required}`);
  }
  for (const retired of RETIRED_TOOLS) {
    assert.equal(names.includes(retired), false, `${retired} is retired in 0.34.0`);
  }
  for (const name of names.filter((entry) => !VERB_TOOLS.includes(entry))) {
    assert.ok(AGENT_TOOLS.includes(name), `${name} is not a known 0.34.0 tool`);
  }

  for (const tool of tools) {
    const normalized = normalizeInputSchema(tool.inputSchema);
    assert.equal(normalized.type, 'object', `${tool.name}: the normalized root is an object schema`);
    const verdict = validateJsonSchemaNode(normalized);
    assert.equal(verdict.ok, true, `${tool.name}: ${verdict.ok ? '' : verdict.errors.join('; ')}`);
  }
});

test('routes each session to its own workspace root', TEST_OPTIONS, async (t) => {
  const { subprocess } = createSubprocessAdapter();
  /** @type {any[]} */
  const sessions = [];
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'basemind-int-'));
  // BaseMind refuses to serve a root that is neither a git repository nor
  // marked by basemind.toml, so the temporary root gets the minimal marker.
  writeFileSync(path.join(tempRoot, 'basemind.toml'), WORKSPACE_MARKER);

  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
    if (!(await removeDirectory(tempRoot))) t.diagnostic(`could not remove the temporary root ${tempRoot}`);
  });

  const repoSession = await startSession(subprocess, REPO_ROOT, {
    register: (entry) => sessions.push(entry),
  });
  const tempSession = await startSession(subprocess, tempRoot, {
    register: (entry) => sessions.push(entry),
  });

  assert.notEqual(repoSession.handle, tempSession.handle, 'each session owns its own relay');

  const repoStatus = jsonText(
    await repoSession.session.callTool('index_status', {}),
    'index_status (repository root)',
  );
  const tempStatus = jsonText(
    await tempSession.session.callTool('index_status', {}),
    'index_status (temporary root)',
  );

  assert.equal(
    sameRoot(repoStatus.root, REPO_ROOT),
    true,
    `the repository session reports its own root: ${JSON.stringify(repoStatus.root)} vs ${REPO_ROOT}`,
  );
  assert.equal(
    sameRoot(tempStatus.root, tempRoot),
    true,
    `the temporary session reports its own root: ${JSON.stringify(tempStatus.root)} vs ${tempRoot}`,
  );
  assert.equal(
    sameRoot(tempStatus.root, REPO_ROOT),
    false,
    'the temporary session does not report the repository root',
  );
});

test('lists and reads the BaseMind resources', TEST_OPTIONS, async (t) => {
  const { subprocess } = createSubprocessAdapter();
  /** @type {any[]} */
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
  });

  const { session } = await startSession(subprocess, REPO_ROOT, {
    register: (entry) => sessions.push(entry),
  });

  const listed = await session.listResources();
  assert.ok(Array.isArray(listed.resources), 'resources/list returns a resources array');
  assert.ok(
    listed.resources.some((resource) => resource?.uri === 'basemind://status'),
    'resources/list contains basemind://status',
  );

  const read = await session.readResource('basemind://status');
  assert.ok(Array.isArray(read.contents), 'resources/read returns a contents array');
  assert.ok(read.contents.length > 0, 'the contents array is not empty');

  const [entry] = read.contents;
  assert.equal(entry.uri, 'basemind://status');
  assert.equal(typeof entry.text, 'string');
  const parsed = JSON.parse(entry.text);
  assert.ok(parsed !== null && typeof parsed === 'object', 'the resource text is a JSON object');
});

test('returns projectable text content for a real tool call', TEST_OPTIONS, async (t) => {
  const { subprocess } = createSubprocessAdapter();
  /** @type {any[]} */
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
  });

  const { session } = await startSession(subprocess, REPO_ROOT, {
    register: (entry) => sessions.push(entry),
  });

  await ensureIndexed(session);

  const outline = await session.callTool('code_outline', { path: 'lib/tool-bridge.js' });
  assert.equal(outline.isError, false, 'code_outline succeeds for this repository');
  assert.ok(Array.isArray(outline.content) && outline.content.length > 0, 'the result carries content blocks');
  assert.match(textOf(outline), /^path: /, 'code_outline answers with TOON text, not JSON');

  const result = await session.callTool('code_grep', { pattern: 'createToolDefinition' });
  assert.equal(result.isError, false, 'code_grep succeeds for this repository');
  // 0.34.0 groups hits by path and then by symbol: { hits: { "<path>": { "<symbol>": ["<line>: <text>"] } } }.
  const hits = result.structuredContent?.hits;
  assert.equal(typeof hits, 'object', '0.34.0 sends structuredContent.hits');
  assert.notEqual(hits, null, 'structuredContent.hits is an object, not null');
  assert.match(JSON.stringify(hits), /createToolDefinition/, 'the structured payload carries the hit');
  assert.match(textOf(result), /createToolDefinition/, 'the text block carries the hit');

  const textBlocks = result.content.filter(
    (block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0,
  );
  assert.ok(textBlocks.length > 0, 'at least one non-empty text content block');

  const projected = projectContent(result);
  assert.ok(projected.length > 0, 'the projection is never empty');
  for (const block of projected) {
    assert.deepEqual(Object.keys(block), ['type', 'text'], 'a projected block has exactly type and text');
    assert.equal(block.type, 'text');
    assert.equal(typeof block.text, 'string');
  }
  assert.ok(
    projected.some((block) => block.text.length > 0),
    'the projected blocks carry the tool output',
  );
});

test('terminates the relay process on close', TEST_OPTIONS, async (t) => {
  const { subprocess } = createSubprocessAdapter();
  /** @type {any[]} */
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
  });

  const { session, handle } = await startSession(subprocess, REPO_ROOT, {
    register: (entry) => sessions.push(entry),
  });

  assert.ok(handle, 'the adapter returned the relay handle');
  assert.equal(handle.exitFacts, null, 'the relay is still running after the handshake');

  await session.close();
  assert.equal(
    await handle.waitForExit(AbortSignal.timeout(EXIT_TIMEOUT_MS)),
    true,
    'terminate() ended the relay; closing stdin alone would not be enough',
  );
  assert.notEqual(handle.exitFacts, null, 'the child reported its exit');
});

test('reads a symbol and reports a missing selector as a fixable error', TEST_OPTIONS, async (t) => {
  const { subprocess } = createSubprocessAdapter();
  /** @type {any[]} */
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
  });

  const { session } = await startSession(subprocess, REPO_ROOT, {
    register: (entry) => sessions.push(entry),
  });
  await ensureIndexed(session);

  const hit = await session.callTool('code_read', {
    path: 'lib/tool-bridge.js',
    symbol: 'createToolDefinition',
  });
  assert.equal(hit.isError, false, 'code_read resolves a real symbol');
  assert.ok(textOf(hit).length > 0, 'code_read returns the symbol body');

  const missing = await session.callTool('code_read', { path: 'lib/tool-bridge.js' });
  assert.equal(missing.isError, true, 'code_read without symbol or line is a fixable error');
  assert.equal(missing.structuredContent?.error, 'invalid_argument');
  assert.equal(missing.structuredContent?.retryable, false);
});

test('rejects an unknown argument with invalid_argument', TEST_OPTIONS, async (t) => {
  const { subprocess } = createSubprocessAdapter();
  /** @type {any[]} */
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
  });

  const { session } = await startSession(subprocess, REPO_ROOT, {
    register: (entry) => sessions.push(entry),
  });

  const result = await session.callTool('code_symbols', { name: 'createToolDefinition', bogus: 1 });
  assert.equal(result.isError, true, 'an unknown field is rejected instead of silently dropped');
  assert.equal(result.structuredContent?.error, 'invalid_argument');
  assert.match(textOf(result), /bogus/, 'the message names the offending field');
});

test('retired tool names fail with JSON-RPC -32602', TEST_OPTIONS, async (t) => {
  const { subprocess } = createSubprocessAdapter();
  /** @type {any[]} */
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
  });

  const { session } = await startSession(subprocess, REPO_ROOT, {
    register: (entry) => sessions.push(entry),
  });

  await assert.rejects(
    () => session.callTool('code', { mode: 'files' }),
    (error) => {
      assert.equal(error.code, -32602, 'a retired tool is a JSON-RPC invalid-params error');
      return true;
    },
  );
});
