/**
 * Child-process fixture for the real managed-binary install lock.
 *
 * `test/integration-managed.test.mjs` starts two of these at once against one empty
 * cache root. Each child runs the product's own `createBinaryManager` with the real
 * downloader, the real checksum verification, the real archive extraction and the real
 * `--version` probe; only the network transport is replayed from the already verified
 * official archive captured by the parent's real download. Exactly one child may
 * install, and the other must wait on the directory lock and then reuse the committed
 * tree.
 *
 * Usage: node fixtures/managed-real-select.mjs <cacheRoot> <targetKey> <archiveFile> <checksumsFile> <counterDir>
 *
 * It prints one JSON line (the product's selection plus timing) and appends one marker
 * file per served request, so the parent can count downloads across processes.
 */
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createBinaryManager } from '../lib/binary/manager.js';
import { UPSTREAM, assetFor, checksumsUrl } from '../lib/upstream.js';

const [cacheRoot, targetKey, archiveFile, checksumsFile, counterDir] = process.argv.slice(2);
if (!cacheRoot || !targetKey || !archiveFile || !checksumsFile || !counterDir) {
  process.stderr.write('usage: managed-real-select.mjs <cacheRoot> <targetKey> <archiveFile> <checksumsFile> <counterDir>\n');
  process.exit(2);
}

const asset = assetFor(targetKey);
if (asset === undefined) {
  process.stderr.write('unknown target ' + targetKey + '\n');
  process.exit(2);
}

const log = (level, text) => process.stderr.write('[' + level + '] ' + text + '\n');

/** Record one served request so the parent can count downloads across processes. */
async function record(kind) {
  await mkdir(counterDir, { recursive: true });
  await writeFile(
    path.join(counterDir, kind + '-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)),
    '',
  );
}

/**
 * Serve the already verified official bytes instead of the network. The product still
 * hashes what it receives against the published checksum, so a corrupted replay fails.
 */
async function replayFetch(url) {
  const text = String(url);
  if (text === checksumsUrl()) {
    await record('checksums');
    const body = await readFile(checksumsFile, 'utf8');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  if (text === asset.url) {
    await record('asset');
    const facts = await stat(archiveFile);
    return new Response(Readable.toWeb(createReadStream(archiveFile)), {
      status: 200,
      headers: { 'content-length': String(facts.size) },
    });
  }
  throw new Error('the replay transport has no bytes for ' + text);
}

/** The subprocess surface the manager and the version probe need, backed by real children. */
const subprocess = {
  async resolveExecutable(command) {
    const error = new Error("'" + command + "' is not resolvable in this fixture");
    error.code = 'ENOENT';
    throw error;
  },
  spawn(spec) {
    const mode = (value) => (value === 'ignore' ? 'ignore' : 'pipe');
    const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: [mode(spec?.stdio?.stdin), mode(spec?.stdio?.stdout), mode(spec?.stdio?.stderr)],
      windowsHide: true,
    });
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
      terminate() {
        if (exitFacts !== null) return;
        if (process.platform === 'win32' && typeof child.pid === 'number') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
          return;
        }
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      },
      waitForExit(signal) {
        if (exitFacts !== null) return Promise.resolve(true);
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 60000);
          timer.unref?.();
          child.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
          });
          signal?.addEventListener?.('abort', () => resolve(false), { once: true });
        });
      },
    };
  },
};

const manager = createBinaryManager({
  ctx: { subprocess },
  config: { binaryDownload: true, binaryPolicy: 'exact' },
  env: process.env,
  homedir: cacheRoot,
  cacheRoot,
  logger: { info: (text) => log('info', text), warn: (text) => log('warn', text), debug: () => {} },
  fetchImpl: replayFetch,
});

try {
  const selection = await manager.select();
  process.stdout.write(JSON.stringify({ selection, target: targetKey, expected: UPSTREAM.version }) + '\n');
} catch (error) {
  process.stderr.write('selection threw: ' + (error?.stack ?? String(error)) + '\n');
  process.exitCode = 1;
} finally {
  await manager.dispose();
}
