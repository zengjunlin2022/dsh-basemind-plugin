/**
 * Version-agnostic BaseMind integration smoke test.
 *
 * `test/integration.test.mjs` pins the 0.34.0 verb-tool contract. This file is the
 * opposite: it asserts only what every supported BaseMind version (0.29.3-0.34.0)
 * must provide — a handshake, a dynamically discovered tool list, one safe read and
 * per-root routing — so the compat matrix can run it against an older binary through
 * `BASEMIND_BIN` without hard-coding a tool count or a `mode` list.
 *
 * It owns its `BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR`, so a legacy run never
 * shares a daemon or an index schema with the 0.34.0 suite.
 *
 * `BASEMIND_REQUIRE_INTEGRATION=1` turns a missing binary into a failure instead of
 * a skip, so this file can be a release gate.
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
import { createStdioClient } from '../lib/stdio-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The plugin repository itself. */
const REPO_ROOT = path.resolve(here, '..');

/** Throwaway BaseMind state for this process only. */
const TEST_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'basemind-legacy-'));
process.env.BASEMIND_DATA_HOME = path.join(TEST_DATA_ROOT, 'data');
process.env.BASEMIND_COMMS_DIR = path.join(TEST_DATA_ROOT, 'comms');
mkdirSync(process.env.BASEMIND_DATA_HOME, { recursive: true });
mkdirSync(process.env.BASEMIND_COMMS_DIR, { recursive: true });

/** Minimal durable workspace marker BaseMind accepts. */
const WORKSPACE_MARKER = '"$schema" = "v1"\n';

const TEST_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 10_000;

const CONFIGURED_BIN = (process.env.BASEMIND_BIN ?? '').trim();
const REQUIRE_INTEGRATION = (process.env.BASEMIND_REQUIRE_INTEGRATION ?? '') !== '';

/** @param {string} filePath @returns {boolean} */
function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the binary under test: `BASEMIND_BIN` first, then a plain PATH lookup of
 * the names BaseMind installs (the GitHub release layout ships `basemind.exe`).
 *
 * @returns {string|null}
 */
function resolveBinary() {
  let base = 'basemind';
  if (CONFIGURED_BIN !== '') {
    if (isFile(CONFIGURED_BIN)) return path.resolve(CONFIGURED_BIN);
    // A bare name (`BASEMIND_BIN=basemind`) still means "look it up on PATH"; only a
    // path-like value is used verbatim. This mirrors lib/executable.js.
    if (CONFIGURED_BIN.includes('/') || CONFIGURED_BIN.includes(path.sep)) return null;
    base = CONFIGURED_BIN;
  }
  const names = process.platform === 'win32' ? [`${base}.exe`, `${base}.cmd`, base] : [base];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

const BASEMIND_EXE = resolveBinary();
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

after(async () => {
  stopTestDaemon();
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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

/**
 * Adapt a real child process to the DSH `SubprocessHandle` contract.
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
    get exitFacts() {
      return exitFacts;
    },
    terminate() {
      if (exitFacts !== null) return;
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 15_000,
            windowsHide: true,
          });
        } catch {
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
        const timer = setTimeout(() => finish(false), 60_000);
        timer.unref?.();
        child.once('exit', () => finish(true));
        if (signal?.aborted) finish(false);
        else signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    },
  };
}

/** Build the `ctx.subprocess` surface the plugin needs, over real child processes. */
function createSubprocessAdapter() {
  return {
    async resolveExecutable(command, env = process.env, signal) {
      signal?.throwIfAborted?.();
      if (BASEMIND_EXE !== null && (command === 'basemind' || command === CONFIGURED_BIN)) return BASEMIND_EXE;
      throw new Error(`legacy adapter: executable not found on PATH: ${String(command)}`);
    },
    spawn(spec) {
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return adaptChild(child);
    },
  };
}

/**
 * Start one relay for `root` and complete the MCP handshake.
 *
 * @param {{ resolveExecutable: Function, spawn: Function }} subprocess
 * @param {string} root
 * @param {{ register?: (session: any) => void }} [options]
 */
async function startSession(subprocess, root, { register } = {}) {
  const launch = await resolveLaunch({ ctx: { subprocess }, config: resolveConfig({}), root });
  const client = createStdioClient({
    argv: launch.argv,
    cwd: root,
    env: launch.env,
    startupTimeoutMs: 90_000,
    toolCallTimeoutMs: 90_000,
    spawn: (spec) => subprocess.spawn(spec),
  });
  const session = createMcpSession(client);
  register?.(session);
  const handshake = await session.initialize();
  return { session, handshake };
}

/** @param {any} session */
async function closeQuietly(session) {
  try {
    await session.close();
  } catch {
    // close() is documented as never throwing.
  }
}

/** Ask the throwaway daemon of this run to stop. */
function stopTestDaemon() {
  if (BASEMIND_EXE === null) return;
  try {
    if (process.platform === 'win32' && BASEMIND_EXE.toLowerCase().endsWith('.cmd')) {
      spawnSync('cmd.exe', ['/d', '/s', '/c', `"${BASEMIND_EXE}" comms stop`], {
        env: process.env,
        stdio: 'ignore',
        timeout: 15_000,
        windowsHide: true,
      });
      return;
    }
    spawnSync(BASEMIND_EXE, ['comms', 'stop'], { env: process.env, stdio: 'ignore', timeout: 15_000 });
  } catch {
    // No daemon, no basemind, or an already-stopped daemon.
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value;
  // Windows reports `C:\x` as `\\?\C:\x` (two backslashes, a question mark, one backslash).
  const backslash = String.fromCharCode(92);
  const verbatim = backslash + backslash + '?' + backslash;
  const stripped = text.startsWith(verbatim) ? text.slice(4) : text;
  return path.resolve(stripped);
}

/**
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
 * @param {{ content?: unknown, structuredContent?: unknown }} result
 * @returns {any|undefined}
 */
function payload(result) {
  const structured = result?.structuredContent;
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured)) return structured;
  const block = Array.isArray(result?.content)
    ? result.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    : undefined;
  if (block === undefined) return undefined;
  try {
    return JSON.parse(block.text);
  } catch {
    return undefined;
  }
}

test('handshakes, discovers tools dynamically and routes each root separately', TEST_OPTIONS, async (t) => {
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeQuietly(session);
  });

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'basemind-legacy-ws-'));
  writeFileSync(path.join(tempRoot, 'basemind.toml'), WORKSPACE_MARKER);
  t.after(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      t.diagnostic(`could not remove ${tempRoot}`);
    }
  });

  const subprocess = createSubprocessAdapter();
  const repo = await startSession(subprocess, REPO_ROOT, { register: (entry) => sessions.push(entry) });
  const temp = await startSession(subprocess, tempRoot, { register: (entry) => sessions.push(entry) });

  assert.ok(repo.handshake.serverInfo !== null && typeof repo.handshake.serverInfo === 'object');
  assert.ok(typeof repo.handshake.instructions === 'string');

  const tools = await repo.session.listTools();
  assert.ok(Array.isArray(tools) && tools.length > 0, 'tools/list is discovered, not hard-coded');
  const names = tools.map((tool) => tool.name);

  // One safe read per generation: 0.34.0 renamed the admin status tool.
  const statusTool = names.includes('index_status') ? 'index_status' : names.includes('admin') ? 'admin' : null;
  assert.ok(statusTool !== null, `no status tool among ${JSON.stringify(names)}`);
  const statusArgs = statusTool === 'admin' ? { mode: 'status' } : {};

  const repoStatus = payload(await repo.session.callTool(statusTool, statusArgs));
  const tempStatus = payload(await temp.session.callTool(statusTool, statusArgs));
  assert.equal(sameRoot(repoStatus?.root, REPO_ROOT), true, `the repository session reports its own root: ${JSON.stringify(repoStatus?.root)}`);
  assert.equal(sameRoot(tempStatus?.root, tempRoot), true, `the temporary session reports its own root: ${JSON.stringify(tempStatus?.root)}`);
  assert.equal(sameRoot(tempStatus?.root, REPO_ROOT), false, 'the temporary session does not report the repository root');
});
