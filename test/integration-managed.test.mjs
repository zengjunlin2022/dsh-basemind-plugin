/**
 * Phase 2 real managed-binary integration test.
 *
 * This is the only suite that proves the PLUGIN's own path: it lets
 * `lib/binary/manager.js` download the pinned BaseMind release over the real network,
 * verify the published SHA256, extract the complete release tree, probe it and install
 * it into the plugin's own cache — then starts the real MCP relay and the real CLI
 * adapter from that managed binary. Nothing here re-implements the download, the
 * checksum verification, the extraction or the install; the product modules do all of it.
 *
 * Gate contract (deliberately separate from `BASEMIND_REQUIRE_INTEGRATION`):
 * - `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1` makes every failure fatal: a missing or
 *   unreachable release, a checksum mismatch, an incomplete install, a relay that does
 *   not start or a tool that does not answer all fail the suite. Nothing may skip.
 * - Unset, the whole file skips with a reason, so a plain `npm test` never downloads
 *   75-102 MB on every commit.
 * - `DSH_BASEMIND_MANAGED_TEST_KEEP=1` keeps the temporary root for debugging.
 * - `MANAGED_DIAGNOSTICS_DIR=<dir>` writes one small JSON diagnostics file there (never
 *   tokens, never the environment, never the binary cache).
 *
 * Isolation (verified against the BaseMind 0.34.0 environment contract):
 * - `DSH_HOME`, `BASEMIND_DATA_HOME` and `BASEMIND_COMMS_DIR` point into one throwaway
 *   root, so the managed cache, the daemon's index and the comms broker are all private.
 * - `PATH` loses every directory that holds a `basemind` launcher or BaseMind's private
 *   runtime libraries (`heif.dll`, `libde265.dll`, `libheif*.so*`, `libde265*.dylib`, …).
 *   That is what stops a Windows global install's DLLs from making an incomplete managed
 *   tree look usable; the suite asserts that no `basemind` is resolvable afterwards.
 * - `BASEMIND_BIN` is removed from the process environment: a compatible external binary
 *   must not stand in for the managed download.
 */

import assert from 'node:assert/strict';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBinaryManager } from '../lib/binary/manager.js';
import { digestFor, parseChecksums } from '../lib/binary/checksums.js';
import { resolveTarget } from '../lib/binary/platform.js';
import { createCliTool } from '../lib/cli-tool.js';
import { resolveConfig } from '../lib/config.js';
import { resolveLaunch } from '../lib/executable.js';
import { createMcpSession } from '../lib/mcp-session.js';
import { createStdioClient } from '../lib/stdio-client.js';
import { UPSTREAM, assetFor, checksumsUrl } from '../lib/upstream.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const CHILD_FIXTURE = path.join(REPO_ROOT, 'fixtures', 'managed-real-select.mjs');

/** Set by the managed-binary workflow and the release gate: no skip is acceptable. */
const REQUIRE_MANAGED = (process.env.BASEMIND_REQUIRE_MANAGED_INTEGRATION ?? '').trim() !== '';
/** Keep the temporary root for debugging instead of deleting it. */
const KEEP_ROOT = (process.env.DSH_BASEMIND_MANAGED_TEST_KEEP ?? '').trim() !== '';
/** Optional directory for one small diagnostics JSON file. */
const DIAGNOSTICS_DIR = (process.env.MANAGED_DIAGNOSTICS_DIR ?? '').trim();

const SKIP = REQUIRE_MANAGED
  ? false
  : 'set BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 to download and install the pinned BaseMind release';

/** Generous per-test budget: the cold install downloads 75-102 MB and cold indexing follows. */
const TEST_TIMEOUT_MS = 240_000;
/** The cold install performs the one real download of the run. */
const COLD_TIMEOUT_MS = 600_000;
/** MCP/CLI: relay startup (120 s) plus a cold index build (150 s) can exceed the default. */
const RUNTIME_TIMEOUT_MS = 420_000;
/** How long the BaseMind index of the small fixture repository may take. */
const INDEX_BUILD_TIMEOUT_MS = 150_000;
/** Protocol version BaseMind 0.34.0 negotiates for the first offered version. */
const PROTOCOL_VERSION = '2025-06-18';
/** How long a terminated relay may take to report its exit. */
const EXIT_TIMEOUT_MS = 15_000;

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

/** Files BaseMind ships next to the binary on every platform (release contract). */
const LICENSE_FILES = Object.freeze(['LICENSE', 'ATTRIBUTIONS.md', 'THIRD_PARTY_LICENSES']);

/** Directory entries that mark a path entry as a BaseMind installation or its libraries. */
const BASEMIND_LAUNCHER = /^basemind(\.exe|\.cmd|\.bat)?$/i;
const BASEMIND_LIBRARY = /^(heif\.dll|libde265\.dll|libheif[^\\/]*\.(so|dylib)|libde265[^\\/]*\.(so|dylib)|onnxruntime[^\\/]*\.dll)$/i;

// ------------------------------------------------------------------ isolation ---

let ROOT;
let DSH_HOME;
let DATA_HOME;
let COMMS_DIR;
let GLOBAL_BASEMIND;
let GLOBAL_BASEMIND_STAT;
let REMOVED_PATH_DIRS = [];

if (REQUIRE_MANAGED) {
  ROOT = mkdtempSync(path.join(os.tmpdir(), 'basemind-managed-'));
  DSH_HOME = path.join(ROOT, 'dsh-home');
  DATA_HOME = path.join(ROOT, 'basemind-data');
  COMMS_DIR = path.join(ROOT, 'basemind-comms');
  for (const directory of [DSH_HOME, DATA_HOME, COMMS_DIR, path.join(ROOT, 'repos')]) {
    mkdirSync(directory, { recursive: true });
  }

  // An inherited BASEMIND_BIN would turn the managed scenario into a local-first one.
  GLOBAL_BASEMIND = findExecutable('basemind');
  if (GLOBAL_BASEMIND !== null) {
    const facts = statSync(GLOBAL_BASEMIND);
    GLOBAL_BASEMIND_STAT = { size: facts.size, mtimeMs: facts.mtimeMs };
  }
  delete process.env.BASEMIND_BIN;

  // BaseMind's daemon writes its index and workspace registry under BASEMIND_DATA_HOME and
  // is selected by BASEMIND_COMMS_DIR. Both must point inside the throwaway root before any
  // relay starts, or the suite would touch the user's real BaseMind state.
  process.env.DSH_HOME = DSH_HOME;
  process.env.BASEMIND_DATA_HOME = DATA_HOME;
  process.env.BASEMIND_COMMS_DIR = COMMS_DIR;

  const sanitized = sanitizePath(process.env.PATH ?? '');
  REMOVED_PATH_DIRS = sanitized.removed;
  process.env.PATH = sanitized.kept.join(path.delimiter);
}

/** Directory names that mark a path entry as a BaseMind installation or its libraries. */
/**
 * Drop every `PATH` entry that could satisfy or break the managed install: a BaseMind
 * launcher (a local-first candidate must not exist) or BaseMind's private runtime
 * libraries (a global `heif.dll` must not rescue an incomplete managed tree).
 *
 * @param {string} value
 * @returns {{ kept: string[], removed: string[] }}
 */
function sanitizePath(value) {
  const kept = [];
  const removed = [];
  for (const entry of value.split(path.delimiter)) {
    if (entry === '') continue;
    if (hasBasemindPayload(entry)) removed.push(entry);
    else kept.push(entry);
  }
  return { kept, removed };
}

/** @param {string} directory */
function hasBasemindPayload(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (entry) => entry.isFile() && (BASEMIND_LAUNCHER.test(entry.name) || BASEMIND_LIBRARY.test(entry.name)),
  );
}

// ------------------------------------------------------------ PATH resolution ---

/**
 * Read an environment entry by exact key or case-insensitively (Windows `Path`/`PATH`).
 * @param {Record<string, unknown>|undefined} env
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

/** @param {string} filePath */
function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Candidate file names for one base path, in lookup order (extensionless names go
 * through PATHEXT first, mirroring DSH's subprocess service).
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
 * PATH + PATHEXT lookup mirroring DSH's subprocess provider.
 * @param {unknown} command
 * @param {Record<string, unknown>} [env]
 * @returns {string|null}
 */
function findExecutable(command, env = process.env) {
  const text = String(command ?? '').trim();
  if (text === '') return null;
  /** @type {string[]} */
  const candidates = [];
  if (/[\\/]/.test(text)) {
    candidates.push(path.resolve(text));
  } else {
    for (const directory of (lookupEnv(env, 'PATH') ?? '').split(path.delimiter)) {
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

// ---------------------------------------------------------- subprocess adapter ---

/**
 * Build the `ctx.subprocess` surface the product modules need, backed by real child
 * processes: executable resolution, spawn with the requested stdio modes, exit facts,
 * termination of the whole process tree, and the `collected` stream reader the CLI
 * adapter uses.
 *
 * @param {{ env?: Record<string, string|undefined> }} [options]
 */
function createSubprocessAdapter({ env = process.env } = {}) {
  const handles = [];
  const spawnSpecs = [];

  /** @param {any} child */
  function adapt(child) {
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
          // The direct child may be the `cmd.exe` wrapper of a launcher, so kill the tree
          // of this exact PID; processes are never matched by name.
          try {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000, windowsHide: true });
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone
            }
          }
          return;
        }
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      },
      /**
       * @param {AbortSignal} [signal]
       * @returns {Promise<boolean>}
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
   * Collect one stream up to `maxBytes`, the way DSH's collected streams behave.
   * @param {import('node:stream').Readable|null} stream
   * @param {any} spec
   */
  function collect(stream, spec) {
    const maxBytes = typeof spec?.maxBytes === 'number' ? spec.maxBytes : undefined;
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let lossy = false;
    stream?.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (maxBytes === undefined) {
        chunks.push(buffer);
        size += buffer.length;
        return;
      }
      const room = maxBytes - size;
      if (buffer.length > room) {
        if (room > 0) chunks.push(buffer.subarray(0, room));
        size = maxBytes;
        lossy = true;
        return;
      }
      chunks.push(buffer);
      size += buffer.length;
    });
    return {
      readFrom() {
        return { text: Buffer.concat(chunks).toString('utf8'), lossy };
      },
    };
  }

  const subprocess = {
    /**
     * @param {string} command
     * @param {Record<string, unknown>} [commandEnv]
     * @returns {Promise<string>}
     */
    async resolveExecutable(command, commandEnv) {
      const resolved = findExecutable(command, commandEnv ?? env);
      if (resolved === null) {
        const error = new Error(`subprocess adapter: executable not found on PATH: ${String(command)}`);
        error.code = 'ENOENT';
        throw error;
      }
      return resolved;
    },

    /** @param {any} spec */
    spawn(spec) {
      spawnSpecs.push(spec);
      const mode = (value) => (value === 'ignore' || value === undefined ? 'ignore' : 'pipe');
      const stdio = spec?.stdio ?? {};
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env ?? env,
        stdio: [mode(stdio.stdin), mode(stdio.stdout), mode(stdio.stderr)],
        windowsHide: true,
      });
      const handle = adapt(child);
      if (stdio.stdout !== undefined && typeof stdio.stdout === 'object') {
        handle.collected = { stdout: collect(child.stdout, stdio.stdout), stderr: collect(child.stderr, stdio.stderr) };
      } else if (stdio.stdout === 'pipe' || stdio.stderr === 'pipe') {
        handle.collected = {
          stdout: collect(child.stdout, undefined),
          stderr: collect(child.stderr, undefined),
        };
      }
      handles.push(handle);
      return handle;
    },
  };

  return { subprocess, handles, spawnSpecs };
}

// -------------------------------------------------------------------- helpers ---

/** @param {string} file */
function readJsonSync(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @param {string} file */
async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/** A logger that keeps every line so a test can assert on diagnostics. */
function captureLogger() {
  const lines = { info: [], warn: [], debug: [] };
  const push = (level) => (text) => lines[level].push(String(text));
  return { lines, logger: { info: push('info'), warn: push('warn'), debug: push('debug') } };
}

/**
 * The real download wrapped so the run can reuse the exact official bytes later: the
 * response still streams to the product (which hashes it against the published
 * checksum), and the same bytes are also written to `archiveFile` for the repair
 * scenarios. Redirects and error statuses pass through untouched.
 *
 * @param {{ archiveFile: string }} options
 */
function createRecordingFetch({ archiveFile }) {
  const calls = { asset: 0, checksums: 0, urls: [] };
  const saved = { checksumsText: undefined, assetBytes: undefined };
  const asset = assetFor(targetKey());
  // GitHub answers a release download with a redirect to a signed asset host, so the 200
  // that carries the bytes belongs to the redirect target, not to the pinned URL. Track
  // which document is being fetched instead of matching the response URL.
  let awaitingChecksums = false;
  let awaitingAsset = false;
  return {
    calls,
    saved,
    async fetchImpl(url, init) {
      const text = String(url);
      calls.urls.push(text);
      if (text === checksumsUrl()) {
        calls.checksums += 1;
        awaitingChecksums = true;
      }
      if (text === asset.url) {
        calls.asset += 1;
        awaitingAsset = true;
      }

      const response = await fetch(text, init);
      if (response.status !== 200) return response;

      if (awaitingChecksums) {
        awaitingChecksums = false;
        const body = await response.text();
        saved.checksumsText = body;
        return new Response(body, { status: 200, headers: response.headers });
      }
      if (awaitingAsset && response.body !== null) {
        awaitingAsset = false;
        const handle = openSync(archiveFile, 'w');
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          closeSync(handle);
          saved.assetBytes = statSync(archiveFile).size;
        };
        const reader = response.body.getReader();
        const stream = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              close();
              controller.close();
              return;
            }
            writeSync(handle, value);
            controller.enqueue(value);
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              close();
            }
          },
        });
        return new Response(stream, { status: 200, headers: response.headers });
      }
      return response;
    },
  };
}

/**
 * Serve the official archive captured by the real download in this same run. The product
 * still verifies the published SHA256, extracts and installs; only the transport is local.
 *
 * @param {{ archiveFile: string, checksumsFile: string, counterDir?: string }} options
 */
function createReplayFetch({ archiveFile, checksumsFile, counterDir }) {
  const calls = { asset: 0, checksums: 0, urls: [] };
  const asset = assetFor(targetKey());
  return {
    calls,
    async fetchImpl(url) {
      const text = String(url);
      calls.urls.push(text);
      if (text === checksumsUrl()) {
        calls.checksums += 1;
        const body = await fsp.readFile(checksumsFile, 'utf8');
        return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (text === asset.url) {
        calls.asset += 1;
        if (counterDir !== undefined) {
          await fsp.mkdir(counterDir, { recursive: true });
          await fsp.writeFile(
            path.join(counterDir, 'asset-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)),
            '',
          );
        }
        const facts = await fsp.stat(archiveFile);
        return new Response(Readable.toWeb(createReadStream(archiveFile)), {
          status: 200,
          headers: { 'content-length': String(facts.size) },
        });
      }
      throw new Error('the replay transport has no bytes for ' + text);
    },
  };
}

/** The pinned target key for this machine. */
function targetKey() {
  const target = resolveTarget({ platform: process.platform, arch: process.arch });
  assert.equal(target.unsupported, undefined, `this platform has no managed release: ${target.unsupported ?? ''}`);
  return target.key;
}

/** The managed cache root the product derives from `DSH_HOME`. */
function defaultCacheRoot() {
  return path.join(DSH_HOME, 'cache', 'dsh-basemind-plugin');
}

/** The directory the product installs this target into. */
function managedTargetDir(cacheRoot) {
  return path.join(cacheRoot, 'managed-binaries', UPSTREAM.version, targetKey());
}

/**
 * Every regular file under `root` as `{ path, size }` with forward slashes, sorted.
 * @param {string} root
 */
async function listTree(root) {
  /** @type {{ path: string, size: number }[]} */
  const files = [];
  /** @param {string} directory @param {string} prefix */
  async function walk(directory, prefix) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : prefix + '/' + entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.push({ path: relative, size: (await fsp.stat(absolute)).size });
    }
  }
  await walk(root, '');
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Run one real binary and capture its output.
 * @param {string|string[]} argv the executable or a full argv
 * @param {string[]} [args]
 * @param {{ cwd?: string, timeout?: number }} [options]
 */
function runBinary(argv, args = [], options = {}) {
  const command = Array.isArray(argv) ? argv[0] : argv;
  const commandArgs = Array.isArray(argv) ? argv.slice(1) : args;
  return spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    windowsHide: true,
  });
}

/**
 * Assert the on-disk tree is exactly the tree the install record describes.
 * @param {any} install
 * @param {string} directory
 */
async function assertTreeMatchesRecord(install, directory) {
  const tree = await listTree(directory);
  const recorded = install.files.map((entry) => entry.path).slice().sort();
  const actual = tree.map((entry) => entry.path).filter((entry) => entry !== 'install.json');
  assert.deepEqual(actual, recorded, 'install.json.files[] lists exactly the installed tree');
  for (const entry of install.files) {
    const found = tree.find((candidate) => candidate.path === entry.path);
    assert.equal(found.size, entry.size, `${entry.path} matches its recorded size`);
  }
}

/**
 * Assert the installed tree carries everything the official release ships: the main
 * binary, the licence documents and the dynamic runtime libraries, derived from the
 * record itself (no hardcoded dependency names).
 * @param {any} install
 * @param {string} directory
 */
async function assertCompleteReleaseTree(install, directory) {
  const recorded = install.files;
  assert.equal(recorded.length >= 8, true, `the release tree carries at least 8 files (found ${recorded.length})`);

  const binary = recorded.find((entry) => entry.path === install.binary);
  assert.ok(binary, `the main binary ${install.binary} is part of the recorded tree`);
  assert.equal(binary.size, install.size, 'the record describes the main binary it probed');
  assert.equal(isFile(path.join(directory, install.binary)), true, 'the main binary exists on disk');

  for (const name of LICENSE_FILES) {
    assert.equal(
      recorded.some((entry) => entry.path === name),
      true,
      `the release tree keeps ${name}`,
    );
    assert.equal(statSync(path.join(directory, name)).size > 0, true, `${name} is not empty`);
  }

  const libraries = recorded.filter((entry) => /\.(dll|so[.0-9]*|dylib)$/i.test(entry.path));
  assert.ok(libraries.length > 0, 'the release tree keeps the dynamic runtime libraries');
  for (const library of libraries) {
    assert.equal(statSync(path.join(directory, library.path)).size, library.size, `${library.path} is intact`);
  }

  // Every official tree ships one licence notice per bundled library under `licenses/`.
  assert.ok(
    recorded.some((entry) => entry.path.startsWith('licenses/')),
    'the release tree keeps the per-library notices under licenses/',
  );

  if (process.platform === 'win32') {
    assert.ok(
      libraries.some((entry) => entry.path.endsWith('.dll') && !entry.path.includes('/')),
      'Windows keeps its runtime DLLs next to the executable',
    );
  } else {
    assert.ok(
      libraries.some((entry) => entry.path.startsWith('lib/') && /\.(so[d]?[.0-9]*|dylib)$/.test(entry.path)),
      'Linux/macOS keep their shared libraries under lib/',
    );
    const mode = statSync(path.join(directory, install.binary)).mode;
    assert.notEqual(mode & 0o111, 0, 'the installed binary is executable');
  }
}

/**
 * Hash one file ourselves. The managed install claims its archive and binary digests; this
 * keeps the evidence independent of the product's own record.
 * @param {string} file
 * @returns {Promise<string>}
 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Track the files a directory holds, for "nothing touched" assertions. */
async function listTreeOrEmpty(directory) {
  try {
    return await fsp.readdir(directory, { recursive: true });
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ git fixture ---

const REPO_FILES = {
  'src/math.js': [
    '/** Adds two numbers. */',
    'export function add(left, right) {',
    '  return left + right',
    '}',
    '',
    '/** Totals a list of numbers, one add() at a time. */',
    'export function sumFiles(values) {',
    '  return values.reduce((total, value) => add(total, value), 0)',
    '}',
    '',
    '/** Scales a value by delegating to multiply(). */',
    'export function scale(value, factor) {',
    '  return multiply(value, factor)',
    '}',
    '',
    '/** Multiplies two numbers. */',
    'export function multiply(left, right) {',
    '  return left * right',
    '}',
    '',
  ].join('\n'),
  'src/greeting.js': [
    "import { scale } from './math.js'",
    '',
    '/** Greets one person by name. */',
    'export function greet(name) {',
    '  return `hi ${name}`',
    '}',
    '',
    '/** Repeats a greeting, using scale() from the math module. */',
    'export function shout(name, factor) {',
    '  return greet(name).repeat(scale(1, factor))',
    '}',
    '',
  ].join('\n'),
  'docs/notes.md': ['# Sample notes', '', 'The magic word is emerald-lantern.', ''].join('\n'),
};

/**
 * Create a small, fully predictable git repository: three files, a real call edge
 * (`sumFiles` -> `add`, `scale` -> `multiply`) and one commit.
 * @param {string} name
 */
function createRepository(name) {
  const directory = path.join(ROOT, 'repos', name);
  for (const [relative, content] of Object.entries(REPO_FILES)) {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Managed Test',
    GIT_AUTHOR_EMAIL: 'managed-test@example.invalid',
    GIT_COMMITTER_NAME: 'Managed Test',
    GIT_COMMITTER_EMAIL: 'managed-test@example.invalid',
    GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: directory, env: gitEnv, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr ?? ''}`);
    return result.stdout;
  };
  git(['init', '-q']);
  git(['checkout', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add the sample sources']);
  return directory;
}

// --------------------------------------------------------------------- runtime ---

/**
 * Normalize the `\\?\` verbatim prefix BaseMind reports and resolve the remainder.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return resolveRealPath(value);
}

/**
 * Resolve a path to its real, long form.
 *
 * Two platform differences make a raw string comparison wrong, both measured on real
 * runners: macOS reports `/private/var/...` for a fixture created under `/var/...`, and
 * Windows hands back an 8.3 short name (`C:\Users\RUNNER~1\...`) for a directory whose
 * long form is `C:\Users\runneradmin\...`. `realpath` folds both to the same string, and
 * the verbatim `\\?\` prefix that BaseMind adds for long paths is stripped on both sides.
 *
 * @param {string} value
 * @returns {string}
 */
function resolveRealPath(value) {
  const stripped = value.startsWith('\\\\?\\') ? value.slice(4) : value;
  const absolute = path.resolve(stripped);
  let resolved;
  try {
    resolved = realpathSync.native(absolute);
  } catch {
    // A path that does not exist yet cannot be resolved; compare it as written.
    return absolute;
  }
  return resolved.startsWith('\\\\?\\') ? resolved.slice(4) : resolved;
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

/** The first text content block of a tool result. */
function textOf(result) {
  const block = Array.isArray(result?.content)
    ? result.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    : undefined;
  return block === undefined ? '' : block.text;
}

/**
 * Whether a value looks like a BaseMind `index_status` payload.
 *
 * Measured 0.34.0 contract: the building payload carries `"indexing": true`; the ready
 * payload drops `indexing` entirely and describes the workspace (`root`, `schema_version`,
 * `file_count`). An early call can also come back with `structuredContent: {}` while the
 * JSON text block holds the full payload.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeIndexStatus(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    typeof value.indexing === 'boolean' ||
    typeof value.root === 'string' ||
    Number.isFinite(value.schema_version) ||
    Number.isFinite(value.file_count)
  );
}

/**
 * The `index_status` payload, preferring a source that actually describes the workspace.
 * @param {{ structuredContent?: unknown, content?: unknown }} result
 * @returns {any|undefined}
 */
function indexPayload(result) {
  const structured = result?.structuredContent;
  // A degraded `{}` (seen while the first index builds) must not hide the text payload.
  if (looksLikeIndexStatus(structured) && (typeof structured.root === 'string' || typeof structured.indexing === 'boolean')) {
    return structured;
  }
  const text = textOf(result);
  if (text !== '') {
    try {
      const parsed = JSON.parse(text);
      if (looksLikeIndexStatus(parsed)) return parsed;
    } catch {
      // The text block is not JSON; fall through to whatever we have.
    }
  }
  return looksLikeIndexStatus(structured) ? structured : undefined;
}

/** Wait until the throwaway daemon has a usable index. */
async function ensureIndexed(session) {
  const startedAt = Date.now();
  let recognised = false;
  /** @type {any} */
  let last;
  for (;;) {
    const result = await session.callTool('index_status', {});
    const status = indexPayload(result);
    last = { result, status };
    const describesWorkspace = status !== null && typeof status === 'object' && typeof status.root === 'string';
    if (describesWorkspace) recognised = true;
    // Ready means "this payload describes the workspace and is not still indexing"; the
    // ready payload omits `indexing`, so `!== true` is the correct test, not `=== false`.
    if (describesWorkspace && status.indexing !== true) return status;

    const elapsed = Date.now() - startedAt;
    if (!recognised && elapsed > 10_000) {
      // A payload we cannot read is an unusable answer, not "ready": fail with the raw
      // text instead of letting a later "index is empty" hide the cause.
      assert.fail(
        `index_status never returned a workspace description (isError=${String(result?.isError)}): ` +
          String(textOf(result)).slice(0, 400),
      );
    }
    if (elapsed > INDEX_BUILD_TIMEOUT_MS) {
      assert.fail(
        `the BaseMind index did not finish building within ${INDEX_BUILD_TIMEOUT_MS} ms; ` +
          `last index_status: ${JSON.stringify(last.status ?? String(textOf(last.result)).slice(0, 400))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Start one real MCP relay for the managed binary and complete the handshake. */
async function startRelay(subprocess, root, selection) {
  const launch = await resolveLaunch({ ctx: { subprocess }, config: resolveConfig({}), root, selection });
  let handle;
  const client = createStdioClient({
    argv: launch.argv,
    cwd: root,
    env: launch.env,
    startupTimeoutMs: 120_000,
    toolCallTimeoutMs: 120_000,
    spawn: (spec) => {
      handle = subprocess.spawn(spec);
      return handle;
    },
  });
  const session = createMcpSession(client);
  const handshake = await session.initialize();
  return { session, handshake, launch, handle };
}

/** Close a session without letting teardown failures mask the test result. */
async function closeQuietly(session) {
  try {
    await session.close();
  } catch {
    // close() is documented as never throwing; a teardown failure is not the subject.
  }
}

/** Ask the throwaway daemon to drain and stop (never the user's daemon). */
function stopTestDaemon(exe) {
  if (typeof exe !== 'string' || exe === '') return;
  try {
    spawnSync(exe, ['comms', 'stop'], { env: process.env, stdio: 'ignore', timeout: 30_000, windowsHide: true });
  } catch {
    // No daemon, no binary, or an already-stopped daemon: nothing to clean.
  }
}

/** Remove a directory, retrying while BaseMind releases index handles. */
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

// ------------------------------------------------------------------- results ---

/** Facts shared between the ordered tests; a missing one means an earlier test failed. */
const state = {};
/** Measured values for the execution report. */
const metrics = {};

/** One small diagnostics file, never containing secrets or the environment. */
async function writeDiagnostics() {
  if (DIAGNOSTICS_DIR === '') return;
  const payload = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    upstream: { version: UPSTREAM.version, tag: UPSTREAM.tag },
    target: state.target,
    cacheRoot: state.cacheRoot,
    installDir: state.installDir,
    install: state.install,
    selection: state.selection,
    metrics,
    removedPathDirs: REMOVED_PATH_DIRS,
    warnings: state.warnings ?? [],
    cacheFacts: state.cacheFacts,
  };
  try {
    await fsp.mkdir(DIAGNOSTICS_DIR, { recursive: true });
    await fsp.writeFile(path.join(DIAGNOSTICS_DIR, 'managed-integration.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // Diagnostics must never fail an otherwise green run.
  }
}

after(async () => {
  if (REQUIRE_MANAGED === false) return;
  await writeDiagnostics();
  stopTestDaemon(state.selection?.path);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (KEEP_ROOT) {
    process.emitWarning(`DSH_BASEMIND_MANAGED_TEST_KEEP is set; keeping ${ROOT}`);
    return;
  }
  if (!(await removeDirectory(ROOT))) {
    process.emitWarning(`could not remove the managed test root ${ROOT}`);
  }
});

// Last-resort synchronous cleanup when the worker exits without the hook.
process.on('exit', () => {
  if (REQUIRE_MANAGED === false || KEEP_ROOT || ROOT === undefined) return;
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // The daemon may still hold a file; the async hook already reported it.
  }
});

// --------------------------------------------------------------------- tests ---

test('M1 cold cache: the product downloads, verifies and installs the complete pinned release', { skip: SKIP, timeout: COLD_TIMEOUT_MS }, async (t) => {
  assert.equal(
    findExecutable('basemind'),
    null,
    'no basemind is resolvable: the managed path must not fall back to a global install',
  );

  const target = resolveTarget({ platform: process.platform, arch: process.arch });
  assert.equal(target.unsupported, undefined, `a managed release exists for this platform: ${target.unsupported ?? ''}`);
  state.target = target.key;
  state.cacheRoot = defaultCacheRoot();
  assert.equal(existsSync(state.cacheRoot), false, 'the managed cache starts out cold');

  const archiveFile = path.join(ROOT, 'assets', 'release.' + assetFor(target.key).ext);
  const checksumsFile = path.join(ROOT, 'assets', 'checksums.txt');
  mkdirSync(path.dirname(archiveFile), { recursive: true });
  state.archiveFile = archiveFile;
  state.checksumsFile = checksumsFile;

  const recorder = createRecordingFetch({ archiveFile });
  const { lines, logger } = captureLogger();
  state.warnings = lines;

  // No cacheRoot: the product must derive it from DSH_HOME exactly as it does in DSH.
  const manager = createBinaryManager({
    ctx: { subprocess: createSubprocessAdapter().subprocess },
    config: { binaryDownload: true, binaryPolicy: 'exact' },
    env: process.env,
    homedir: ROOT,
    logger,
    fetchImpl: recorder.fetchImpl,
  });

  const startedAt = Date.now();
  let selection;
  try {
    selection = await manager.select();
  } finally {
    state.cacheFacts = manager.status().cache;
    await manager.dispose();
  }
  metrics.coldInstallMs = Date.now() - startedAt;

  assert.equal(selection.ok, true, `the cold install succeeded: ${selection.reason ?? ''}`);
  assert.equal(selection.source, 'managed', 'the selection came from the managed cache');
  assert.equal(selection.version, UPSTREAM.version, 'the selected version is the pinned upstream version');
  assert.equal(selection.verified, true, 'the selected binary was verified by its published checksum');
  state.selection = selection;
  state.installDir = path.dirname(selection.path);

  assert.equal(
    state.installDir.toLowerCase(),
    managedTargetDir(defaultCacheRoot()).toLowerCase(),
    'the install lands in the version- and target-isolated cache directory',
  );
  assert.equal(
    path.basename(selection.path),
    assetFor(target.key).binary,
    'the selected path is the main binary of this platform',
  );

  // The bytes the product received are kept so the repair scenarios can replay the same
  // official archive; the product still verifies its published checksum on every install.
  assert.equal(typeof recorder.saved.checksumsText, 'string', 'the product downloaded the release checksums');
  await fsp.writeFile(state.checksumsFile, recorder.saved.checksumsText, 'utf8');
  assert.equal(
    statSync(archiveFile).size,
    assetFor(target.key).bytes,
    'the downloaded archive matches the byte count published in lib/upstream.js',
  );

  // The real download: at least one checksums document and one release asset from the
  // pinned tag. `>= 1` on purpose: downloadVerified retries a transient 429/5xx by calling
  // fetchImpl again, which is correct product behaviour and must not turn this gate red.
  // "Installed exactly once" is asserted below through the single target directory, the
  // untouched cache in M2 and the cross-process race in M7, never through transport counts.
  assert.ok(recorder.calls.checksums >= 1, 'the product fetched the release checksums');
  assert.ok(recorder.calls.asset >= 1, 'the product downloaded the release asset');
  metrics.downloadAttempts = { checksums: recorder.calls.checksums, asset: recorder.calls.asset };
  assert.ok(
    recorder.calls.urls.includes(checksumsUrl()),
    'the checksums came from the pinned release URL',
  );
  assert.ok(
    recorder.calls.urls.includes(assetFor(target.key).url),
    'the asset came from the pinned release URL',
  );
  metrics.networkRequests = recorder.calls.urls.length;
  metrics.archiveBytes = statSync(archiveFile).size;

  const install = readJsonSync(path.join(state.installDir, 'install.json'));
  state.install = install;

  // layout 2 plus the two separated digests.
  assert.equal(install.layout, 2, 'the install record uses layout 2');
  assert.equal(install.version, UPSTREAM.version, 'the record names the pinned version');
  assert.equal(install.target, target.key, 'the record names this platform target');
  assert.equal(install.tag, UPSTREAM.tag, 'the record names the pinned release tag');
  assert.equal(install.binary, assetFor(target.key).binary, 'the record names the platform binary');
  assert.equal(typeof install.installedAt, 'string', 'the record carries an install timestamp');

  const digests = parseChecksums(recorder.saved.checksumsText);
  const published = digestFor(digests, assetFor(target.key).name);
  assert.equal(typeof published, 'string', 'the published checksums list this asset');
  assert.equal(install.sha256, published, 'the archive digest is the published SHA256');
  assert.equal(/^[0-9a-f]{64}$/.test(install.binarySha256 ?? ''), true, 'the record carries a binary digest');
  assert.notEqual(install.sha256, install.binarySha256, 'the archive digest and the binary digest are separate');

  // Independent hashes, so the "verified" claim does not rest on the product's own record
  // agreeing with itself: hash the captured archive and the installed binary ourselves.
  metrics.archiveSha256 = await sha256File(archiveFile);
  metrics.binarySha256 = await sha256File(selection.path);
  assert.equal(metrics.archiveSha256, published, 'the downloaded bytes hash to the published SHA256');
  assert.equal(metrics.binarySha256, install.binarySha256, 'the installed binary hashes to the recorded binary digest');

  await assertTreeMatchesRecord(install, state.installDir);
  await assertCompleteReleaseTree(install, state.installDir);

  // The real binary runs from the managed tree.
  const version = runBinary(selection.path, ['--version']);
  assert.equal(version.status, 0, `basemind --version exits 0: ${version.stderr ?? ''}`);
  assert.match(String(version.stdout), new RegExp(`basemind\\s+${UPSTREAM.version.replaceAll('.', '\\.')}`));

  // No half-finished staging, no lock, no parked tree, no duplicate copy.
  const downloadRoot = path.join(state.cacheRoot, 'download');
  assert.deepEqual(await listTreeOrEmpty(downloadRoot), [], 'the staging directory is empty after the install');
  const versionRoot = path.dirname(state.installDir);
  const siblings = await fsp.readdir(versionRoot);
  assert.deepEqual(siblings, [targetKey()], 'exactly one target directory exists for the pinned version');
  assert.equal(
    siblings.filter((name) => name.startsWith('.old-')).length,
    0,
    'no parked tree was left behind by a completed install',
  );
  const managedEntries = await fsp.readdir(path.dirname(versionRoot));
  assert.deepEqual(
    managedEntries.filter((name) => name.startsWith('.lock-')),
    [],
    'the install lock was released',
  );

  // The user's own installation, if any, was not touched.
  if (GLOBAL_BASEMIND !== null) {
    const facts = statSync(GLOBAL_BASEMIND);
    assert.equal(facts.isFile(), true, `the global BaseMind at ${GLOBAL_BASEMIND} still exists`);
    assert.equal(facts.size, GLOBAL_BASEMIND_STAT.size, 'the global BaseMind keeps its size');
    assert.equal(facts.mtimeMs, GLOBAL_BASEMIND_STAT.mtimeMs, 'the global BaseMind was not rewritten');
  }

  t.diagnostic(
    `cold install ${metrics.coldInstallMs} ms, ${metrics.archiveBytes} archive bytes, ` +
      `${install.files.length} installed files, ${recorder.calls.urls.length} network requests`,
  );
});

test('M2 a new manager instance reuses the managed cache with zero network', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async (t) => {
  assert.ok(state.selection, 'the cold install (M1) completed');
  const installFile = path.join(state.installDir, 'install.json');
  const before = readJsonSync(installFile);
  const beforeTree = await listTree(state.installDir);

  const calls = [];
  const { logger } = captureLogger();
  const manager = createBinaryManager({
    ctx: { subprocess: createSubprocessAdapter().subprocess },
    config: { binaryDownload: true, binaryPolicy: 'exact' },
    env: process.env,
    homedir: ROOT,
    logger,
    // Every network request from this instance is already a failure of the cache reuse.
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('the network is disabled during the warm-cache test');
    },
  });

  const startedAt = Date.now();
  let selection;
  try {
    selection = await manager.select();
  } finally {
    await manager.dispose();
  }
  metrics.warmSelectionMs = Date.now() - startedAt;

  assert.equal(selection.ok, true, 'the warm cache produced a selection');
  assert.equal(selection.source, 'managed', 'the warm cache is still the managed source');
  assert.equal(selection.path, state.selection.path, 'the same verified binary is selected');
  assert.equal(selection.version, UPSTREAM.version, 'the binary reports the pinned version');
  assert.equal(selection.verified, true, 'the reused binary stays "verified"');
  assert.deepEqual(calls, [], 'no network request was made for the checksums or the archive');

  const after = readJsonSync(installFile);
  assert.equal(after.installedAt, before.installedAt, 'the cache was reused, not reinstalled');
  assert.deepEqual(await listTree(state.installDir), beforeTree, 'the installed tree is byte-for-byte identical');
  assert.equal(statSync(selection.path).size, before.size, 'the dependency files are still in place');

  const version = runBinary(selection.path, ['--version']);
  assert.equal(version.status, 0, `the reused managed binary still runs: ${version.stderr ?? ''}`);

  // The full tree the record describes is what makes the cache valid.
  for (const entry of before.files) {
    assert.equal(statSync(path.join(state.installDir, entry.path)).size, entry.size, `${entry.path} is intact`);
  }
  assert.deepEqual(await listTreeOrEmpty(path.join(state.cacheRoot, 'download')), [], 'no staging work happened');

  t.diagnostic(`warm selection ${metrics.warmSelectionMs} ms with 0 network requests`);
});

test('M3 a compatible local binary wins over the populated managed cache', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async (t) => {
  assert.ok(state.selection, 'the cold install (M1) completed');
  const installFile = path.join(state.installDir, 'install.json');
  const before = readJsonSync(installFile);

  const calls = [];
  const { lines, logger } = captureLogger();
  const manager = createBinaryManager({
    ctx: { subprocess: createSubprocessAdapter().subprocess },
    config: { binaryDownload: true, binaryPolicy: 'exact' },
    env: { ...process.env, BASEMIND_BIN: state.selection.path },
    homedir: ROOT,
    cacheRoot: defaultCacheRoot(),
    logger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('local first must not download anything');
    },
  });

  let selection;
  try {
    selection = await manager.select();
  } finally {
    await manager.dispose();
  }

  assert.equal(selection.ok, true, 'the compatible local binary was accepted');
  assert.equal(selection.source, 'env', 'BASEMIND_BIN is the selected source');
  assert.equal(selection.path, state.selection.path, 'the local candidate is the real 0.34.0 binary');
  assert.deepEqual(calls, [], 'local first performs no download');
  assert.equal(readJsonSync(installFile).installedAt, before.installedAt, 'the managed cache was not reinstalled');
  assert.deepEqual(lines.warn, [], 'no warning was needed for a compatible local binary');

  // MCP and CLI must use the very same selection.
  const adapter = createSubprocessAdapter();
  const launch = await resolveLaunch({
    ctx: { subprocess: adapter.subprocess },
    config: resolveConfig({}),
    root: ROOT,
    selection,
  });
  assert.equal(launch.argv[0], selection.path, 'the MCP relay launches the selected local binary');
  assert.equal(launch.mode, 'direct', 'a real binary spawns directly, without a cmd.exe wrapper');
});

test('M4 a local binary with the wrong version falls back to the managed install', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async (t) => {
  assert.ok(state.selection, 'the cold install (M1) completed');
  // The launcher is a .cmd on Windows, and cmd.exe cannot start one from a path with a
  // space or a metacharacter. %TEMP% on a hosted runner is the 8.3 short name
  // (C:\Users\RUNNER~1\...), so the fixture is created under the real, long path instead;
  // the guard below then checks the path that is actually used, not the one we started from.
  const fakeDir = path.join(resolveRealPath(ROOT), 'fake-local');
  mkdirSync(fakeDir, { recursive: true });
  const fakeBinary = process.platform === 'win32' ? path.join(fakeDir, 'basemind.cmd') : path.join(fakeDir, 'basemind');
  const olderVersion = '0.33.0';
  if (process.platform === 'win32') {
    writeFileSync(fakeBinary, '@echo off\r\necho basemind ' + olderVersion + '\r\n');
  } else {
    writeFileSync(fakeBinary, '#!/bin/sh\necho "basemind ' + olderVersion + '"\n', { mode: 0o755 });
  }
  const fakeSize = statSync(fakeBinary).size;
  // A `.cmd` payload cannot survive cmd.exe when the path carries a space or metacharacter.
  // This is an environment limitation of the harness, not a product behaviour: fail with a
  // message that says so instead of pretending the scenario ran.
  assert.doesNotMatch(
    fakeDir,
    /[ \t"%~&|<>^()!]/,
    `this temporary directory cannot host a .cmd launcher for the version-shim scenario (${fakeDir}); set TEMP to a path without spaces and cmd metacharacters and re-run`,
  );

  const calls = [];
  const { lines, logger } = captureLogger();
  const manager = createBinaryManager({
    ctx: { subprocess: createSubprocessAdapter().subprocess },
    config: { binaryDownload: true, binaryPolicy: 'exact' },
    env: {
      ...process.env,
      PATH: fakeDir + path.delimiter + (process.env.PATH ?? ''),
    },
    homedir: ROOT,
    cacheRoot: defaultCacheRoot(),
    logger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('an incompatible local binary must fall back to the cache, not the network');
    },
  });

  let selection;
  try {
    selection = await manager.select();
  } finally {
    await manager.dispose();
  }

  assert.equal(selection.ok, true, 'a compatible binary was still selected');
  assert.equal(selection.source, 'managed', 'the incompatible local candidate was skipped');
  assert.equal(selection.path, state.selection.path, 'the managed install was reused');
  assert.equal(selection.version, UPSTREAM.version, 'the managed binary is the pinned version');
  assert.deepEqual(calls, [], 'the skipped candidate caused no download');

  const warnings = lines.warn.join('\n');
  assert.match(warnings, /not compatible/i, 'the diagnostics say the local binary is incompatible');
  assert.match(warnings, new RegExp(olderVersion.replaceAll('.', '\\.')), 'the diagnostics name the found version');

  assert.equal(statSync(fakeBinary).size, fakeSize, 'the user-visible local binary was left untouched');
  assert.equal(existsSync(fakeBinary), true, 'the local binary still exists');
});

test('M5 an incomplete managed cache is refused while downloads are disabled', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async (t) => {
  assert.ok(state.selection, 'the cold install (M1) completed');
  t.diagnostic('seeding a second cache root from the verified managed tree');

  state.repairCacheRoot = path.join(ROOT, 'cache-repair');
  const seeded = managedTargetDir(state.repairCacheRoot);
  await fsp.mkdir(path.dirname(seeded), { recursive: true });
  await fsp.cp(state.installDir, seeded, { recursive: true, preserveTimestamps: true });

  const install = readJsonSync(path.join(seeded, 'install.json'));
  // Pick the dependency from the actual record: the largest non-binary runtime library.
  const dependency = install.files
    .filter((entry) => entry.path !== install.binary && /\.(dll|so[.0-9]*|dylib)$/i.test(entry.path))
    .sort((left, right) => right.size - left.size)[0];
  assert.ok(dependency, 'the real release ships a runtime library next to the binary');
  state.repairDependency = dependency;
  state.repairDir = seeded;
  rmSync(path.join(seeded, dependency.path));
  t.diagnostic(`removed ${dependency.path} (${dependency.size} bytes) from the seeded cache`);

  const calls = [];
  const { lines, logger } = captureLogger();
  const manager = createBinaryManager({
    ctx: { subprocess: createSubprocessAdapter().subprocess },
    config: { binaryDownload: false, binaryPolicy: 'exact' },
    env: process.env,
    homedir: ROOT,
    cacheRoot: state.repairCacheRoot,
    logger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('downloads are disabled in this scenario');
    },
  });

  let selection;
  let facts;
  try {
    selection = await manager.select();
  } finally {
    facts = manager.status().cache;
    await manager.dispose();
  }

  assert.equal(selection.ok, false, 'an incomplete cache is not accepted');
  assert.equal(selection.source, undefined, 'no binary was selected, so no relay can start');
  assert.deepEqual(calls, [], 'an incomplete cache triggers no download while downloads are disabled');
  assert.equal(facts.valid, false, 'the cache snapshot does not claim the cache is valid');
  assert.equal(facts.missingFile, dependency.path, 'the snapshot names the missing file');
  assert.equal(existsSync(seeded), true, 'the incomplete tree is kept, not deleted');
  assert.equal(existsSync(path.join(seeded, 'install.json')), true, 'the install record is kept for diagnosis');

  const warnings = lines.warn.join('\n');
  assert.match(warnings, /incomplete/i, 'the diagnostics say the cache is incomplete');
  assert.match(warnings, new RegExp(dependency.path.replaceAll('.', '\\.')), 'the diagnostics name the missing file');
  assert.match(selection.reason, /binaryDownload is false/, 'the failure explains that downloads are disabled');
});

test('M5b the official archive repairs the incomplete managed cache', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async (t) => {
  assert.ok(state.repairDir, 'the incomplete cache was prepared by M5');
  const replay = createReplayFetch({ archiveFile: state.archiveFile, checksumsFile: state.checksumsFile });
  const { logger } = captureLogger();
  const manager = createBinaryManager({
    ctx: { subprocess: createSubprocessAdapter().subprocess },
    config: { binaryDownload: true, binaryPolicy: 'exact' },
    env: process.env,
    homedir: ROOT,
    cacheRoot: state.repairCacheRoot,
    logger,
    fetchImpl: replay.fetchImpl,
  });

  const startedAt = Date.now();
  let selection;
  let facts;
  try {
    selection = await manager.select();
  } finally {
    facts = manager.status().cache;
    await manager.dispose();
  }
  metrics.repairInstallMs = Date.now() - startedAt;

  assert.equal(selection.ok, true, `the repair install succeeded: ${selection.reason ?? ''}`);
  assert.equal(selection.source, 'managed', 'the repaired tree is the managed source');
  assert.equal(selection.path, path.join(state.repairDir, (state.install).binary), 'the repair reused the same cache location');

  assert.equal(replay.calls.checksums, 1, 'the repair verified the published checksums again');
  assert.equal(replay.calls.asset, 1, 'the repair reinstalled from the verified archive once');

  const install = readJsonSync(path.join(state.repairDir, 'install.json'));
  assert.equal(install.layout, 2, 'the repaired cache is a layout-2 install');
  assert.equal(install.sha256, state.install.sha256, 'the repaired archive digest matches the verified one');
  assert.equal(install.binarySha256, state.install.binarySha256, 'the binary digest is identical after repair');
  await assertTreeMatchesRecord(install, state.repairDir);
  await assertCompleteReleaseTree(install, state.repairDir);

  assert.equal(facts.valid, true, 'the cache snapshot now reports a valid cache');
  assert.equal(facts.missingFile, undefined, 'nothing is missing any more');
  const restored = statSync(path.join(state.repairDir, state.repairDependency.path));
  assert.equal(restored.size, state.repairDependency.size, 'the removed runtime library is back at its recorded size');

  const version = runBinary(selection.path, ['--version']);
  assert.equal(version.status, 0, `the repaired binary runs: ${version.stderr ?? ''}`);
  assert.match(String(version.stdout), new RegExp(`basemind\\s+${UPSTREAM.version.replaceAll('.', '\\.')}`));

  t.diagnostic(`repair install ${metrics.repairInstallMs} ms from the verified official archive`);
});

test('M6 a layout-1 cache is not adopted and is replaced only by a full install', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async (t) => {
  assert.ok(state.install, 'the cold install (M1) completed');

  state.layoutOneCacheRoot = path.join(ROOT, 'cache-layout1');
  const directory = managedTargetDir(state.layoutOneCacheRoot);
  await fsp.mkdir(path.dirname(directory), { recursive: true });
  // A layout-1 cache is a single binary plus a record that cannot describe a tree.
  await fsp.mkdir(directory, { recursive: true });
  await fsp.copyFile(path.join(state.installDir, state.install.binary), path.join(directory, state.install.binary));
  const layoutOne = {
    layout: 1,
    version: UPSTREAM.version,
    target: targetKey(),
    sha256: state.install.sha256,
    url: state.install.url,
    tag: UPSTREAM.tag,
    installedAt: '2026-01-01T00:00:00.000Z',
    binary: state.install.binary,
    size: state.install.size,
    mtimeMs: statSync(path.join(directory, state.install.binary)).mtimeMs,
  };
  writeFileSync(path.join(directory, 'install.json'), JSON.stringify(layoutOne, null, 2) + '\n');
  state.layoutOneRoot = directory;

  const calls = [];
  const { lines, logger } = captureLogger();
  const offline = createBinaryManager({
    ctx: { subprocess: createSubprocessAdapter().subprocess },
    config: { binaryDownload: false, binaryPolicy: 'exact' },
    env: process.env,
    homedir: ROOT,
    cacheRoot: state.layoutOneCacheRoot,
    logger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('downloads are disabled in this scenario');
    },
  });
  let offlineSelection;
  let facts;
  try {
    offlineSelection = await offline.select();
  } finally {
    facts = offline.status().cache;
    await offline.dispose();
  }

  assert.equal(offlineSelection.ok, false, 'a single-binary layout-1 cache is not a usable install');
  assert.deepEqual(calls, [], 'the refusal did not touch the network');
  assert.equal(facts.layout, 1, 'the snapshot reports the layout it found');
  assert.equal(facts.valid, false, 'the snapshot does not claim a layout-1 cache is valid');
  assert.equal(existsSync(state.layoutOneRoot), true, 'the old cache is kept until a replacement exists');
  assert.equal(readJsonSync(path.join(directory, 'install.json')).layout, 1, 'the old record was not rewritten');

  const replay = createReplayFetch({ archiveFile: state.archiveFile, checksumsFile: state.checksumsFile });
  // An install only writes the plugin's own cache: prove it against real content in the
  // BaseMind data home, not against an empty directory (empty-to-empty proves nothing).
  const sentinel = path.join(DATA_HOME, 'sentinel.json');
  await fsp.mkdir(DATA_HOME, { recursive: true });
  await fsp.writeFile(sentinel, JSON.stringify({ note: 'must survive an install', at: Date.now() }) + '\n', 'utf8');
  const sentinelBefore = await fsp.readFile(sentinel, 'utf8');
  const dataHomeBefore = await listTreeOrEmpty(DATA_HOME);
  const online = createBinaryManager({
    ctx: { subprocess: createSubprocessAdapter().subprocess },
    config: { binaryDownload: true, binaryPolicy: 'exact' },
    env: process.env,
    homedir: ROOT,
    cacheRoot: state.layoutOneCacheRoot,
    logger,
    fetchImpl: replay.fetchImpl,
  });
  let selection;
  let afterFacts;
  try {
    selection = await online.select();
  } finally {
    afterFacts = online.status().cache;
    await online.dispose();
  }

  assert.equal(selection.ok, true, `the layout-2 replacement succeeded: ${selection.reason ?? ''}`);
  assert.equal(selection.source, 'managed', 'the replacement is the managed source');
  assert.equal(afterFacts.layout, 2, 'the replacement is a layout-2 install');
  assert.equal(afterFacts.valid, true, 'the replacement is a valid cache');

  const install = readJsonSync(path.join(directory, 'install.json'));
  assert.equal(install.installedAt === layoutOne.installedAt, false, 'the record was replaced');
  await assertTreeMatchesRecord(install, directory);
  await assertCompleteReleaseTree(install, directory);
  assert.notEqual(statSync(path.join(directory, install.binary)).size, 0, 'the binary survived the swap');

  // BaseMind's own data home is untouched by an install: the manager only writes its cache.
  assert.deepEqual(await listTreeOrEmpty(DATA_HOME), dataHomeBefore, 'the install created no file in BASEMIND_DATA_HOME');
  assert.equal(await fsp.readFile(sentinel, 'utf8'), sentinelBefore, 'the install did not rewrite an existing data-home file');
  t.diagnostic('layout-1 cache replaced by a verified layout-2 install');
});

test('M7 concurrent callers reuse one real install instead of copying or re-downloading', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async (t) => {
  assert.ok(state.selection, 'the cold install (M1) completed');
  assert.ok(state.repairCacheRoot, 'the repair cache (M5) was seeded');
  assert.ok(state.layoutOneRoot, 'the layout-1 cache (M6) was prepared');
  const installFile = path.join(state.installDir, 'install.json');
  const before = readJsonSync(installFile);

  // In-process: two independent managers over the already installed tree. This proves
  // "one cache, same path, no copy" — concurrent *first* selection (single-flight and the
  // cross-process install lock) is covered by the real race below and by
  // test/binary-concurrency.test.mjs, which owns the seam-level single-flight cases.
  const makeManager = () =>
    createBinaryManager({
      ctx: { subprocess: createSubprocessAdapter().subprocess },
      config: { binaryDownload: false, binaryPolicy: 'exact' },
      env: process.env,
      homedir: ROOT,
      cacheRoot: defaultCacheRoot(),
      logger: captureLogger().logger,
      fetchImpl: async () => {
        throw new Error('reuse must not download');
      },
    });
  const inProcess = [makeManager(), makeManager()];
  let selections;
  try {
    selections = await Promise.all(inProcess.map((manager) => manager.select()));
  } finally {
    await Promise.all(inProcess.map((manager) => manager.dispose()));
  }
  for (const selection of selections) {
    assert.equal(selection.ok, true, 'each concurrent caller got a selection');
    assert.equal(selection.path, state.selection.path, 'every caller uses the same installed binary');
  }
  assert.equal(readJsonSync(installFile).installedAt, before.installedAt, 'no second install ran');

  // Cross-process: two child processes race on an empty cache root with the real manager.
  state.raceCacheRoot = path.join(ROOT, 'cache-race');
  const counterDir = path.join(ROOT, 'race-counters');
  mkdirSync(counterDir, { recursive: true });
  const childEnv = { ...process.env };
  const CHILD_TIMEOUT_MS = 180_000;
  const start = () =>
    new Promise((resolve, reject) => {
      const child = spawnChild(
        process.execPath,
        [CHILD_FIXTURE, state.raceCacheRoot, targetKey(), state.archiveFile, state.checksumsFile, counterDir],
        { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      let stdout = '';
      let stderr = '';
      // A hung child must not hold the cache lock, the temp root or the test worker open.
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        reject(new Error(`the child selection did not exit within ${CHILD_TIMEOUT_MS} ms: ${stderr.slice(-1000)}`));
      }, CHILD_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

  const startedAt = Date.now();
  const children = await Promise.all([start(), start()]);
  metrics.crossProcessRaceMs = Date.now() - startedAt;
  const counter = await fsp.readdir(counterDir);
  const assetFetches = counter.filter((name) => name.startsWith('asset-')).length;
  const checksumsFetches = counter.filter((name) => name.startsWith('checksums-')).length;

  for (const child of children) {
    assert.equal(child.code, 0, `the child selection exited 0: ${child.stderr.slice(-2000)}`);
    const line = child.stdout.trim().split('\n').filter((entry) => entry !== '').pop();
    assert.ok(line, `the child printed a selection: ${child.stderr.slice(-2000)}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.selection.ok, true, `the child selection succeeded: ${parsed.selection.reason ?? ''}`);
    assert.equal(parsed.selection.source, 'managed', 'each child selected the managed install');
  }

  assert.equal(assetFetches, 1, 'exactly one of the two processes downloaded the archive');
  assert.equal(checksumsFetches, 1, 'exactly one of the two processes fetched the checksums');

  const racedInstall = path.join(managedTargetDir(state.raceCacheRoot), 'install.json');
  assert.equal(existsSync(racedInstall), true, 'the race produced one complete install');
  const install = readJsonSync(racedInstall);
  assert.equal(install.layout, 2, 'the raced install is a layout-2 tree');
  await assertTreeMatchesRecord(install, managedTargetDir(state.raceCacheRoot));
  const managedRoot = path.dirname(managedTargetDir(state.raceCacheRoot));
  assert.deepEqual(await fsp.readdir(managedRoot), [targetKey()], 'the race left exactly one target directory');
  assert.deepEqual(await listTreeOrEmpty(path.join(state.raceCacheRoot, 'download')), [], 'no staging directory survived');
  assert.equal(
    (await fsp.readdir(managedRoot)).filter((name) => name.startsWith('.old-')).length,
    0,
    'no parked tree survived the race',
  );

  // No per-session copy anywhere under the cache roots.
  const targetDirs = [state.cacheRoot, state.repairCacheRoot, state.raceCacheRoot, state.layoutOneCacheRoot]
    .map((root) => managedTargetDir(root))
    .filter((directory) => existsSync(directory));
  assert.equal(targetDirs.length, 4, 'each cache root holds exactly its own single target directory');

  t.diagnostic(
    `cross-process race ${metrics.crossProcessRaceMs} ms, ${assetFetches} archive download(s), ${checksumsFetches} checksums fetch(es)`,
  );
});

test('the managed binary serves the real MCP relay: initialize, tools, resources, tools that answer', { skip: SKIP, timeout: RUNTIME_TIMEOUT_MS }, async (t) => {
  assert.ok(state.selection, 'the cold install (M1) completed');
  const repo = createRepository('session-a');
  state.repo = repo;

  const adapter = createSubprocessAdapter();
  const { session, handshake, launch, handle } = await startRelay(adapter.subprocess, repo, state.selection);
  t.after(async () => {
    await closeQuietly(session);
  });

  // The relay is the managed binary, not anything on PATH.
  assert.equal(launch.argv[0], state.selection.path, 'the relay launches the managed binary');
  assert.equal(launch.mode, 'direct', 'the managed binary is a native executable, not a launcher');

  assert.equal(handshake.protocolVersion, PROTOCOL_VERSION, 'the negotiated protocol version');
  assert.equal(typeof handshake.serverInfo?.name, 'string', 'serverInfo.name is reported');
  assert.equal(typeof handshake.serverInfo?.version, 'string', 'serverInfo.version is reported');
  assert.equal(typeof handshake.instructions, 'string', 'MCP server instructions are reported');
  assert.ok(handshake.instructions.trim().length > 0, 'the BaseMind instructions are non-empty');

  const tools = await session.listTools();
  const names = tools.map((tool) => tool.name);
  for (const required of VERB_TOOLS) {
    assert.ok(names.includes(required), `0.34.0 advertises the verb tool ${required}`);
  }
  for (const retired of RETIRED_TOOLS) {
    assert.equal(names.includes(retired), false, `${retired} is retired in 0.34.0`);
  }
  const extras = names.filter((name) => !VERB_TOOLS.includes(name));
  for (const name of extras) {
    assert.ok(AGENT_TOOLS.includes(name), `${name} is a known 0.34.0 tool`);
  }
  metrics.advertisedTools = names.length;
  metrics.commsTools = extras.filter((name) => AGENT_TOOLS.includes(name)).length;

  // index_status: a cold index is empty at first, then the daemon builds it.
  const first = await session.callTool('index_status', {});
  assert.equal(first.isError, false, 'index_status succeeds');
  const firstPayload = indexPayload(first);
  assert.ok(firstPayload !== null && typeof firstPayload === 'object', 'index_status returns structured data');
  assert.equal(sameRoot(firstPayload.root, repo), true, `index_status reports the fixture repository: ${firstPayload.root}`);

  const startedAt = Date.now();
  const indexed = await ensureIndexed(session);
  metrics.indexMs = Date.now() - startedAt;
  assert.equal(sameRoot(indexed?.root, repo), true, 'the indexed workspace is the fixture repository');

  const outline = await session.callTool('code_outline', { path: 'src/math.js' });
  assert.equal(outline.isError, false, `code_outline succeeds: ${textOf(outline).slice(0, 300)}`);
  assert.match(textOf(outline), /^path: /, 'code_outline answers with TOON text, not JSON');
  assert.match(textOf(outline), /sumFiles/, 'the outline lists the fixture symbol');

  const symbols = await session.callTool('code_symbols', { name: 'sumFiles' });
  assert.equal(symbols.isError, false, `code_symbols succeeds: ${textOf(symbols).slice(0, 300)}`);
  assert.match(textOf(symbols), /sumFiles/, 'code_symbols finds the fixture definition');
  assert.match(JSON.stringify(symbols.structuredContent ?? ''), /src\/math\.js/, 'structuredContent carries the file');

  const read = await session.callTool('code_read', { path: 'src/math.js', symbol: 'sumFiles' });
  assert.equal(read.isError, false, `code_read succeeds: ${textOf(read).slice(0, 300)}`);
  assert.match(textOf(read), /values\.reduce/, 'code_read returns the symbol body');

  const refs = await session.callTool('code_refs', { name: 'multiply' });
  assert.equal(refs.isError, false, `code_refs succeeds: ${textOf(refs).slice(0, 300)}`);
  assert.match(textOf(refs), /math\.js/, 'code_refs reports where the symbol is defined or used');

  const grep = await session.callTool('code_grep', { pattern: 'sumFiles' });
  assert.equal(grep.isError, false, `code_grep succeeds: ${textOf(grep).slice(0, 300)}`);
  assert.equal(typeof grep.structuredContent?.hits, 'object', 'structuredContent.hits is preserved');
  assert.match(JSON.stringify(grep.structuredContent?.hits), /src\/math\.js/, 'the structured payload carries the hit');
  assert.match(textOf(grep), /sumFiles/, 'the text block carries the hit');

  const gitLog = await session.callTool('git_log', {});
  assert.equal(gitLog.isError, false, `git_log succeeds: ${textOf(gitLog).slice(0, 300)}`);
  assert.match(textOf(gitLog), /add the sample sources/, 'git_log reports the fixture commit');

  // Resources: list, templates and a read.
  const listed = await session.listResources();
  assert.ok(Array.isArray(listed?.resources), 'resources/list returns a resources array');
  assert.ok(
    listed.resources.some((resource) => resource?.uri === 'basemind://status'),
    'resources/list contains basemind://status',
  );
  const templates = await session.listResourceTemplates();
  assert.ok(templates !== null && typeof templates === 'object', 'resources/templates/list answers');
  assert.ok(Array.isArray(templates.resourceTemplates), 'resources/templates/list returns a resourceTemplates array');
  const readResource = await session.readResource('basemind://status');
  assert.ok(Array.isArray(readResource?.contents) && readResource.contents.length > 0, 'resources/read returns contents');
  assert.equal(readResource.contents[0].uri, 'basemind://status', 'the read resource keeps its uri');
  const statusJson = JSON.parse(readResource.contents[0].text);
  assert.ok(statusJson !== null && typeof statusJson === 'object', 'the status resource is JSON');

  // The relay closes on request: closing stdin would not be enough.
  await session.close();
  assert.equal(
    await handle.waitForExit(AbortSignal.timeout(EXIT_TIMEOUT_MS)),
    true,
    'the managed relay was terminated on close',
  );

  t.diagnostic(
    `MCP relay: ${metrics.advertisedTools} tools (${metrics.commsTools} comms), index ${metrics.indexMs} ms`,
  );
});

test('the managed binary answers the real CLI verbs through the CLI adapter', { skip: SKIP, timeout: RUNTIME_TIMEOUT_MS }, async (t) => {
  assert.ok(state.repo, 'the MCP test created the fixture repository');
  const adapter = createSubprocessAdapter();
  const ctx = {
    get: () => undefined,
    workingDirectory: {
      async ensure() {
        return state.repo;
      },
    },
    subprocess: adapter.subprocess,
  };
  const cli = createCliTool({
    serverName: 'basemind',
    binary: state.selection,
    ctx,
    config: resolveConfig({}),
    logger: captureLogger().logger,
  });

  /** Run one admitted verb and assert it used the managed binary in the fixture repository. */
  async function run(args, { timeoutMs = 120_000 } = {}) {
    const before = adapter.spawnSpecs.length;
    const startedAt = Date.now();
    const result = await cli.execute({ args, timeout_ms: timeoutMs }, { agent: { id: 'managed-test-agent' } });
    const elapsed = Date.now() - startedAt;
    const spec = adapter.spawnSpecs[adapter.spawnSpecs.length - 1];
    assert.equal(adapter.spawnSpecs.length, before + 1, `one process ran for '${args.join(' ')}'`);
    assert.equal(spec.argv[0], state.selection.path, `'${args.join(' ')}' used the verified managed binary`);
    assert.equal(path.resolve(spec.cwd), path.resolve(state.repo), `'${args.join(' ')}' ran in the agent workspace`);
    assert.deepEqual(spec.argv.slice(-2), ['--root', '.'], 'the workspace is passed as --root . with cwd = root');
    return { result, elapsed, spec };
  }

  const status = await run(['status']);
  assert.equal(status.result.isError, false, `basemind status succeeds: ${status.result.text.slice(0, 400)}`);
  assert.match(status.result.text, /index|file/i, 'status reports index facts');
  metrics.cliStatusMs = status.elapsed;

  const doctor = await run(['doctor']);
  const doctorText = `${status.result.text}\n${doctor.result.text}`;
  assert.doesNotMatch(
    doctorText,
    /0xC0000135|error while loading shared libraries|cannot open shared object file|library not loaded/i,
    'neither verb reported a dynamic-library load failure',
  );
  assert.ok(doctor.result.text.trim().length > 0, 'doctor produced output');
  if (doctor.result.isError) {
    t.diagnostic(`doctor exited non-zero: ${doctor.result.text.slice(0, 600)}`);
  }
  metrics.cliDoctorMs = doctor.elapsed;

  const overview = await run(['overview']);
  assert.equal(overview.result.isError, false, `overview succeeds: ${overview.result.text.slice(0, 400)}`);
  assert.match(overview.result.text, /math|greeting|JavaScript|js/i, 'overview describes the fixture repository');
  metrics.cliOverviewMs = overview.elapsed;

  // A CLI-only analysis that has no MCP verb: `code explain`.
  const explain = await run(['code', 'explain', 'src/math.js']);
  assert.equal(explain.result.isError, false, `code explain succeeds: ${explain.result.text.slice(0, 400)}`);
  assert.match(explain.result.text, /math\.js|outline|imports/i, 'code explain describes the file');
  metrics.cliExplainMs = explain.elapsed;

  // The allowlist still refuses a mutating verb instead of running it.
  const refused = await cli.execute({ args: ['scan'] }, { agent: { id: 'managed-test-agent' } });
  assert.equal(refused.isError, true, 'a mutating verb is refused');
  assert.match(refused.text, /destructive machine-global command/, 'the refusal explains why');

  // Cancellation: the same binary honours a pre-aborted call without spawning anything.
  const controller = new AbortController();
  controller.abort();
  const before = adapter.spawnSpecs.length;
  const cancelled = await cli.execute({ args: ['status'] }, { agent: { id: 'managed-test-agent' }, signal: controller.signal });
  assert.equal(cancelled.isError, true, 'an aborted call fails instead of running');
  assert.equal(adapter.spawnSpecs.length, before, 'an aborted call spawns no process');

  // MCP and CLI share exactly one binary selection.
  const adapterForRelay = createSubprocessAdapter();
  const launch = await resolveLaunch({
    ctx: { subprocess: adapterForRelay.subprocess },
    config: resolveConfig({}),
    root: state.repo,
    selection: state.selection,
  });
  assert.equal(launch.argv[0], state.selection.path, 'the relay and the CLI resolve the same binary');

  t.diagnostic(
    `CLI: status ${metrics.cliStatusMs} ms, doctor ${metrics.cliDoctorMs} ms, ` +
      `overview ${metrics.cliOverviewMs} ms, explain ${metrics.cliExplainMs} ms`,
  );
});

test('root normalization folds the platform spellings of one workspace', () => {
  const real = resolveRealPath(REPO_ROOT);
  assert.equal(sameRoot(real, REPO_ROOT), true, 'the same directory compares equal');
  assert.equal(sameRoot(`\\\\?\\${real}`, REPO_ROOT), true, 'a verbatim prefix is stripped');
  assert.equal(sameRoot(path.join(REPO_ROOT, 'lib', '..'), REPO_ROOT), true, 'a .. segment is resolved');
  assert.equal(sameRoot('', REPO_ROOT), false, 'an empty value never matches');
  assert.equal(sameRoot(real, path.join(REPO_ROOT, 'lib')), false, 'a subdirectory is not the workspace');

  // Measured on hosted runners: macOS reports /private/var/... for a fixture created under
  // /var/..., and Windows resolves an 8.3 short name (C:\Users\RUNNER~1\...) to its long
  // form. Both spellings name the same directory, so the comparison must fold them.
  if (process.platform === 'darwin') {
    assert.equal(sameRoot('/private/var', '/var'), true, 'macOS /var is /private/var');
  }
  if (process.platform === 'win32') {
    const temp = os.tmpdir();
    assert.equal(resolveRealPath(temp).startsWith('\\\\?\\'), false, 'the helper strips the verbatim prefix');
    assert.equal(sameRoot(`\\\\?\\${resolveRealPath(temp)}`, temp), true, 'the temp root compares equal across spellings');
  }
});
