/**
 * Child-process fixture for the managed-binary install lock.
 *
 * Runs one real selection through lib/binary/manager.js with every network and
 * subprocess seam replaced by a slow, local fake, then prints the selection as JSON.
 * Two of these started together must install once: the second one waits on the
 * directory lock and then reuses the cache the first one committed.
 *
 * Usage: node fixtures/fake-managed-select.mjs <cacheRoot> <markerDir>
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createBinaryManager } from '../lib/binary/manager.js';
import { parseBasemindVersion } from '../lib/binary/probe.js';
import { UPSTREAM, assetFor } from '../lib/upstream.js';

const [cacheRoot, markerDir] = process.argv.slice(2);
if (!cacheRoot || !markerDir) {
  process.stderr.write('usage: fake-managed-select.mjs <cacheRoot> <markerDir>\n');
  process.exit(2);
}

const DIGEST = 'a'.repeat(64);
const VERSION = UPSTREAM.version;
const asset = assetFor('linux-x64');

/** The fake probe: the staged and installed binary both claim the pinned version. */
const probeFn = async (options) =>
  path.basename(options.exe) === 'basemind'
    ? { ok: true, raw: 'basemind ' + VERSION, parsed: parseBasemindVersion('basemind ' + VERSION), version: VERSION }
    : { ok: false, reason: 'missing' };

const ctx = {
  subprocess: {
    async resolveExecutable(command) {
      const error = new Error("'" + command + "' was not found");
      error.code = 'ENOENT';
      throw error;
    },
  },
};

const manager = createBinaryManager({
  ctx,
  config: { binaryDownload: true, binaryPolicy: 'exact' },
  env: {},
  platform: 'linux',
  arch: 'x64',
  cacheRoot,
  homedir: cacheRoot,
  logger: { warn() {}, info() {}, debug() {} },
  fetchImpl: async () => {
    throw new Error('the network is disabled in this fixture');
  },
  probeFn,
  checksumsFetcher: async () => DIGEST + '  ' + asset.name + '\n',
  downloader: async ({ destFile, sha256 }) => {
    // Record that this process started a download, then stay slow enough that the
    // second process must actually wait on the install lock.
    await mkdir(markerDir, { recursive: true });
    await writeFile(path.join(markerDir, 'download-' + process.pid + '.marker'), '');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await mkdir(path.dirname(destFile), { recursive: true });
    await writeFile(destFile, 'fake archive bytes');
    return { sha256, bytes: 18 };
  },
  extractor: async ({ destFile }) => {
    await mkdir(path.dirname(destFile), { recursive: true });
    await writeFile(destFile, 'MZ fake basemind binary');
    return { bytes: 23 };
  },
});

try {
  const selection = await manager.select();
  process.stdout.write(JSON.stringify(selection) + '\n');
} finally {
  await manager.dispose();
}
