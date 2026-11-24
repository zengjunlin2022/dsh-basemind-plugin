import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { createBinaryManager } from '../lib/binary/manager.js';
import { parseBasemindVersion } from '../lib/binary/probe.js';
import { UPSTREAM, assetFor } from '../lib/upstream.js';

const VERSION = UPSTREAM.version;
const DIGEST = 'a'.repeat(64);
const FIXED_NOW = 1_700_000_000_000;
const FIXTURE = fileURLToPath(new URL('../fixtures/fake-managed-select.mjs', import.meta.url));

/** A promise plus its settle functions. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** An error that stands in for an unresolvable executable. */
function missing(command) {
  const error = new Error("'" + command + "' was not found");
  error.code = 'ENOENT';
  return error;
}

/** A manager with every seam injected; `download` may hold the download open. */
async function setup(t, spec = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bm-conc-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cacheRoot = spec.cacheRoot ?? path.join(dir, 'cache');
  const calls = { resolve: [], probe: [], checksums: [], download: [], extract: [] };
  const asset = assetFor('linux-x64');

  const ctx = {
    subprocess: {
      async resolveExecutable(command) {
        calls.resolve.push(command);
        throw missing(command);
      },
    },
  };

  const probeFn = async (options) => {
    calls.probe.push(options.exe);
    return {
      ok: true,
      raw: 'basemind ' + VERSION,
      parsed: parseBasemindVersion('basemind ' + VERSION),
      version: VERSION,
    };
  };

  const checksumsFetcher = async () => {
    calls.checksums.push(1);
    return DIGEST + '  ' + asset.name + '\n';
  };

  const downloader = async (options) => {
    calls.download.push(options);
    if (typeof spec.download === 'function') return await spec.download(options);
    await mkdir(path.dirname(options.destFile), { recursive: true });
    await writeFile(options.destFile, 'fake archive bytes');
    return { sha256: options.sha256, bytes: 18 };
  };

  const extractor = async (options) => {
    calls.extract.push(options);
    await mkdir(path.dirname(options.destFile), { recursive: true });
    await writeFile(options.destFile, 'MZ fake basemind binary');
    return { bytes: 23 };
  };

  const manager = createBinaryManager({
    ctx,
    config: spec.config ?? { binaryDownload: true },
    logger: spec.logger ?? { warn() {}, info() {}, debug() {} },
    env: {},
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => {
      throw new Error('the network is disabled in these tests');
    },
    now: spec.now ?? (() => FIXED_NOW),
    sleep: spec.sleep ?? (async () => {}),
    cacheRoot,
    homedir: dir,
    probeFn,
    downloader,
    extractor,
    checksumsFetcher,
    hasher: async () => 'c'.repeat(64),
  });

  return {
    dir,
    cacheRoot,
    calls,
    ctx,
    manager,
    managedRoot: path.join(cacheRoot, 'managed-binaries'),
    targetDir: path.join(cacheRoot, 'managed-binaries', VERSION, 'linux-x64'),
  };
}

/** Find a pid that is guaranteed not to be running (for a stale lock owner). */
function deadPid() {
  for (const candidate of [2147483646, 2147483645, 999999, 987654]) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return candidate;
    }
  }
  return undefined;
}

/** Can this environment start child processes at all? */
async function canSpawnChildren() {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve(false);
    }, 10000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Run the fixture once and collect its outcome. */
function runFixture(cacheRoot, markerDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, cacheRoot, markerDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      reject(new Error('the fixture child timed out: ' + stderr));
    }, 25000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------- single flight ----

test('ten concurrent select() calls trigger exactly one download', async (t) => {
  const gate = deferred();
  const h = await setup(t, {
    download: async (options) => {
      await gate.promise;
      await mkdir(path.dirname(options.destFile), { recursive: true });
      await writeFile(options.destFile, 'fake archive bytes');
      return { sha256: options.sha256, bytes: 18 };
    },
  });

  const callers = Array.from({ length: 10 }, () => h.manager.select());
  gate.resolve();
  const results = await Promise.all(callers);

  assert.equal(results.length, 10);
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].source, 'managed');
  assert.equal(h.calls.download.length, 1, 'one shared download');
  assert.equal(h.calls.checksums.length, 1, 'one shared checksums fetch');
  assert.equal(h.calls.extract.length, 1, 'one shared extraction');
});

test('a second manager instance in the same process tree reuses the installed cache', async (t) => {
  const first = await setup(t);
  const installed = await first.manager.select();
  assert.equal(installed.ok, true);

  const second = await setup(t, { cacheRoot: first.cacheRoot });
  const reused = await second.manager.select();

  assert.equal(reused.ok, true);
  assert.equal(reused.source, 'managed');
  assert.equal(reused.path, installed.path);
  assert.equal(second.calls.download.length, 0);
  assert.equal(second.calls.checksums.length, 0);
});

// ----------------------------------------------------------------- aborts ----

test('a caller abort rejects only its own wait while the shared download completes', async (t) => {
  const gate = deferred();
  const started = deferred();
  const h = await setup(t, {
    download: async (options) => {
      started.resolve();
      await gate.promise;
      await mkdir(path.dirname(options.destFile), { recursive: true });
      await writeFile(options.destFile, 'fake archive bytes');
      return { sha256: options.sha256, bytes: 18 };
    },
  });

  const controller = new AbortController();
  const abortedCaller = h.manager.select(undefined, controller.signal);
  await started.promise;

  const patientCaller = h.manager.select();
  controller.abort();
  await assert.rejects(abortedCaller, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });

  gate.resolve();
  const selection = await patientCaller;

  assert.equal(selection.ok, true, 'the shared download still completes');
  assert.equal(selection.source, 'managed');
  assert.equal(h.calls.download.length, 1, 'the abort did not cancel the download');
  assert.equal(existsSync(path.join(h.targetDir, 'basemind')), true);
});

// --------------------------------------------------------------- cooldown ----

test('a failure cooldown prevents a retry storm across five sequential sessions', async (t) => {
  const first = await setup(t, {
    download: async () => {
      throw new Error('download broke');
    },
  });
  const failed = await first.manager.select();
  assert.equal(failed.ok, false);
  assert.ok(failed.reason.includes('download broke'), failed.reason);
  assert.equal(first.calls.checksums.length, 1);
  assert.equal(first.calls.download.length, 1);

  let checksums = 0;
  let downloads = 0;
  for (let session = 0; session < 4; session += 1) {
    const next = await setup(t, { cacheRoot: first.cacheRoot });
    const result = await next.manager.select();
    assert.equal(result.ok, false, 'session ' + session);
    assert.ok(result.reason.includes('cooling down'), result.reason);
    checksums += next.calls.checksums.length;
    downloads += next.calls.download.length;
  }

  assert.equal(checksums, 0, 'no checksums fetch during the cooldown');
  assert.equal(downloads, 0, 'no download during the cooldown');
});

// ------------------------------------------------------------------- lock ----

test('a stale lock naming this host and a dead pid is recovered', async (t) => {
  const pid = deadPid();
  if (pid === undefined) {
    t.skip('this host has no reliably-dead pid to name in a stale lock');
    return;
  }

  const h = await setup(t, {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
  });

  const lockDir = path.join(h.managedRoot, '.lock-' + VERSION + '-linux-x64');
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid, hostname: os.hostname(), startedAt: Date.now() }),
    'utf8',
  );

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'managed');
  assert.equal(h.calls.download.length, 1);
  assert.equal(existsSync(lockDir), false, 'the stale lock is removed');
});

test('a lock held by a live process is waited out, not broken', { timeout: 30000 }, async (t) => {
  // An advancing clock keeps the 120 s lock timeout fast without ever making the lock
  // look stale: startedAt is far in the future, so only the deadline can expire.
  let clock = Date.now();
  const h = await setup(t, {
    now: () => {
      clock += 10000;
      return clock;
    },
    sleep: async () => {},
  });

  const lockDir = path.join(h.managedRoot, '.lock-' + VERSION + '-linux-x64');
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: Number.MAX_SAFE_INTEGER }),
    'utf8',
  );

  // The live owner never releases: the selection must give up rather than steal it.
  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.ok(selection.reason.includes('timed out waiting'), selection.reason);
  assert.equal(h.calls.download.length, 0);
  assert.equal(existsSync(lockDir), true, 'the live lock is left alone');
});

// --------------------------------------------------------- cross process -----

test('two child processes install the managed binary exactly once', { timeout: 60000 }, async (t) => {
  if (!(await canSpawnChildren())) {
    t.skip('this environment cannot start child processes');
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bm-cross-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const cacheRoot = path.join(dir, 'cache');
  const markerDir = path.join(dir, 'markers');

  const [first, second] = await Promise.all([runFixture(cacheRoot, markerDir), runFixture(cacheRoot, markerDir)]);

  for (const [name, child] of [
    ['first', first],
    ['second', second],
  ]) {
    assert.equal(child.code, 0, name + ' child exited ' + child.code + ': ' + child.stderr);
    const selection = JSON.parse(child.stdout.trim());
    assert.equal(selection.ok, true, name + ' selection: ' + child.stdout);
    assert.equal(selection.source, 'managed');
  }

  const markers = existsSync(markerDir)
    ? (await readdir(markerDir)).filter((name) => name.endsWith('.marker'))
    : [];
  assert.deepEqual(markers.length, 1, 'exactly one process ran the downloader');

  const targetDir = path.join(cacheRoot, 'managed-binaries', VERSION, 'linux-x64');
  const installed = await readdir(targetDir);
  assert.ok(installed.includes('basemind'), 'the binary is installed');
  assert.ok(installed.includes('install.json'), 'the install record is written');
  const stagingRoot = path.join(cacheRoot, 'download');
  const staging = existsSync(stagingRoot) ? await readdir(stagingRoot) : [];
  assert.deepEqual(staging.length, 0, 'the staging area is cleaned up');
});
