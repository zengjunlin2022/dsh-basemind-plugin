import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename as renamePath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBinaryManager } from '../lib/binary/manager.js';
import { parseBasemindVersion } from '../lib/binary/probe.js';
import { UPSTREAM, assetFor } from '../lib/upstream.js';

const VERSION = UPSTREAM.version;
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const FIXED_NOW = 1_700_000_000_000;

/** A successful probe result shaped like the real one. */
function probed(version) {
  const parsed = parseBasemindVersion('basemind ' + version);
  return { ok: true, raw: 'basemind ' + version, parsed, version };
}

/** A failed probe result. */
function probeFailed(reason) {
  return { ok: false, reason };
}

/** An error that stands in for an unresolvable executable. */
function missing(command) {
  const error = new Error("'" + command + "' was not found");
  error.code = 'ENOENT';
  return error;
}

/** Quiet logger that keeps the warnings for assertions. */
function createLogger() {
  const warnings = [];
  return {
    warnings,
    warn(message) {
      warnings.push(String(message));
    },
    info() {},
    debug() {},
  };
}

/**
 * Build one manager with every seam injected: fake subprocess, fake probe,
 * fake checksums, fake downloader, fake extractor and a temp cache root.
 *
 * `resolve` maps a command to an absolute path, to an Error, or is absent (unresolvable).
 * `probe` maps an absolute exe path or a basename to a probe result (or a function).
 */
async function setup(t, spec = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bm-manager-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cacheRoot = spec.cacheRoot ?? path.join(dir, 'cache');
  const calls = { resolve: [], probe: [], checksums: [], download: [], extract: [], hash: [] };
  const logger = spec.logger ?? createLogger();

  const platform = spec.platform ?? 'linux';
  const arch = spec.arch ?? 'x64';
  const osKey = platform === 'win32' ? 'windows' : platform;
  const targetKey = osKey + '-' + arch;
  const asset = assetFor(targetKey);

  const resolveMap = { basemind: missing('basemind'), npx: missing('npx'), ...(spec.resolve ?? {}) };
  const ctx = {
    subprocess: {
      async resolveExecutable(command) {
        calls.resolve.push(command);
        const value = resolveMap[command];
        if (value === undefined) throw missing(command);
        if (value instanceof Error) throw value;
        return value;
      },
    },
    workingDirectory: { defaultDirectory: dir },
  };

  const rules = { basemind: probed(VERSION), 'basemind.exe': probed(VERSION), ...(spec.probe ?? {}) };
  const probeFn = async (options) => {
    calls.probe.push(options.exe);
    const base = path.basename(options.exe);
    const hit = Object.hasOwn(rules, options.exe)
      ? rules[options.exe]
      : Object.hasOwn(rules, base)
        ? rules[base]
        : rules['*'];
    const value = typeof hit === 'function' ? await hit(options) : hit;
    return value === undefined ? probeFailed('missing') : value;
  };

  const checksumsSpec = spec.checksums ?? 'ok';
  const checksumsFetcher = async (options) => {
    calls.checksums.push(options.url);
    if (typeof checksumsSpec === 'function') return await checksumsSpec(options);
    if (checksumsSpec === 'throw') throw new Error('checksums fetch failed');
    if (checksumsSpec === 'missing-line') return '# no digests here\n';
    return DIGEST + '  ' + (asset?.name ?? 'unknown-asset') + '\n';
  };

  const downloadSpec = spec.download ?? 'ok';
  const downloader = async (options) => {
    calls.download.push(options);
    if (typeof downloadSpec === 'function') return await downloadSpec(options);
    if (downloadSpec === 'throw') throw new Error('download failed');
    await mkdir(path.dirname(options.destFile), { recursive: true });
    await writeFile(options.destFile, 'fake archive bytes');
    return { sha256: options.sha256, bytes: 17 };
  };

  const extractSpec = spec.extract ?? 'ok';
  const extractor = async (options) => {
    calls.extract.push(options);
    if (typeof extractSpec === 'function') return await extractSpec(options);
    await mkdir(path.dirname(options.destFile), { recursive: true });
    await writeFile(options.destFile, 'MZ fake basemind binary');
    return { bytes: 23 };
  };

  const hasher = async (file) => {
    calls.hash.push(file);
    return spec.digest ?? DIGEST;
  };

  const manager = createBinaryManager({
    ctx,
    config: spec.config ?? {},
    logger,
    env: spec.env ?? {},
    platform,
    arch,
    fetchImpl:
      spec.fetchImpl ??
      (async () => {
        throw new Error('the network is disabled in these tests');
      }),
    now: spec.now ?? (() => FIXED_NOW),
    sleep: spec.sleep ?? (async () => {}),
    cacheRoot,
    homedir: dir,
    probeFn,
    downloader,
    extractor,
    checksumsFetcher,
    hasher,
    renameFn: spec.renameFn,
  });

  const managedRoot = path.join(cacheRoot, 'managed-binaries');
  return {
    dir,
    cacheRoot,
    calls,
    ctx,
    manager,
    logger,
    targetKey,
    assetName: asset?.name,
    managedRoot,
    targetDir: path.join(managedRoot, VERSION, targetKey),
    binaryName: osKey === 'windows' ? 'basemind.exe' : 'basemind',
  };
}

/** Seed a managed cache directory with a complete layout-2 tree and install record. */
async function seedCache(targetDir, binaryName, install = {}, extraFiles = {}) {
  const file = path.join(targetDir, binaryName);
  await mkdir(targetDir, { recursive: true });
  await writeFile(file, 'MZ installed basemind');
  const info = await stat(file);
  const files = [{ path: binaryName, size: info.size }];
  for (const [relative, data] of Object.entries(extraFiles)) {
    const extra = path.join(targetDir, relative);
    await mkdir(path.dirname(extra), { recursive: true });
    await writeFile(extra, data);
    files.push({ path: relative, size: Buffer.byteLength(data) });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const record = {
    layout: 2,
    version: VERSION,
    target: path.basename(targetDir),
    sha256: DIGEST,
    binarySha256: DIGEST,
    binary: binaryName,
    size: info.size,
    mtimeMs: info.mtimeMs,
    installedAt: new Date(FIXED_NOW).toISOString(),
    files,
    ...install,
  };
  await writeFile(path.join(targetDir, 'install.json'), JSON.stringify(record, null, 2) + '\n');
  return { file, info, record };
}

/** Seed the layout-1 cache shape an earlier release left behind. */
async function seedLayout1Cache(targetDir, binaryName) {
  const file = path.join(targetDir, binaryName);
  await mkdir(targetDir, { recursive: true });
  await writeFile(file, 'MZ installed basemind');
  const info = await stat(file);
  const record = {
    version: VERSION,
    target: path.basename(targetDir),
    sha256: DIGEST,
    size: info.size,
    mtimeMs: info.mtimeMs,
    installedAt: new Date(FIXED_NOW).toISOString(),
  };
  await writeFile(path.join(targetDir, 'install.json'), JSON.stringify(record, null, 2) + '\n');
  return { file, info, record };
}

// --------------------------------------------------------------- explicit -- -

test('an explicit compatible command is used as-is with no download', async (t) => {
  const h = await setup(t, {
    config: { command: '/opt/basemind/bin/basemind', binaryDownload: true },
    resolve: { '/opt/basemind/bin/basemind': '/opt/basemind/bin/basemind' },
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'command');
  assert.equal(selection.path, '/opt/basemind/bin/basemind');
  assert.equal(selection.version, VERSION);
  assert.equal(selection.compatible, true);
  assert.equal(selection.reason, 'match');
  assert.deepEqual(h.calls.resolve, ['/opt/basemind/bin/basemind'], 'PATH is never consulted');
  assert.equal(h.calls.download.length, 0);
  assert.equal(h.calls.checksums.length, 0);
});

test('an incompatible explicit command fails closed when binaryFallback is false', async (t) => {
  const h = await setup(t, {
    config: { command: '/opt/old/basemind', binaryFallback: false, binaryDownload: true },
    resolve: { '/opt/old/basemind': '/opt/old/basemind' },
    probe: { '/opt/old/basemind': probed('0.33.0') },
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.ok(selection.reason.includes('not compatible'), selection.reason);
  assert.ok(selection.reason.includes('0.33.0'), selection.reason);
  assert.equal(selection.found, '0.33.0');
  assert.deepEqual(h.calls.resolve, ['/opt/old/basemind']);
  assert.equal(h.calls.download.length, 0);
});

test('an incompatible explicit command falls through to PATH when fallback is allowed', async (t) => {
  const h = await setup(t, {
    config: { command: '/opt/old/basemind', binaryDownload: true },
    resolve: { '/opt/old/basemind': '/opt/old/basemind', basemind: '/usr/local/bin/basemind' },
    probe: { '/opt/old/basemind': probed('0.33.0') },
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'path');
  assert.equal(selection.path, '/usr/local/bin/basemind');
  assert.deepEqual(h.calls.resolve, ['/opt/old/basemind', 'basemind']);
  assert.equal(h.calls.download.length, 0);
});

// ------------------------------------------------------------------- env -----

test('BASEMIND_BIN is the explicit candidate only while command is the default', async (t) => {
  const useEnv = await setup(t, {
    env: { BASEMIND_BIN: '/pin/basemind' },
    resolve: { '/pin/basemind': '/pin/basemind' },
    config: { binaryDownload: true },
  });
  const fromEnv = await useEnv.manager.select();
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.path, '/pin/basemind');
  assert.deepEqual(useEnv.calls.resolve, ['/pin/basemind'], 'PATH is never consulted');

  const explicitWins = await setup(t, {
    env: { BASEMIND_BIN: '/pin/basemind' },
    resolve: { '/opt/custom/basemind': '/opt/custom/basemind', '/pin/basemind': '/pin/basemind' },
    config: { command: '/opt/custom/basemind', binaryDownload: true },
  });
  const fromCommand = await explicitWins.manager.select();
  assert.equal(fromCommand.source, 'command');
  assert.equal(explicitWins.calls.resolve.includes('/pin/basemind'), false, 'BASEMIND_BIN is ignored');
});

test('an incompatible BASEMIND_BIN fails closed when binaryFallback is false', async (t) => {
  const h = await setup(t, {
    env: { BASEMIND_BIN: '/pin/basemind' },
    resolve: { '/pin/basemind': '/pin/basemind', basemind: '/usr/local/bin/basemind' },
    probe: { '/pin/basemind': probed('0.35.0') },
    config: { binaryFallback: false, binaryDownload: false },
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.ok(selection.reason.includes('BASEMIND_BIN'), selection.reason);
  assert.ok(selection.reason.includes('0.35.0'), selection.reason);
  assert.deepEqual(h.calls.resolve, ['/pin/basemind']);
});

// ------------------------------------------------------------------ path -----

test('a compatible PATH binary is selected as source path', async (t) => {
  const h = await setup(t, {
    resolve: { basemind: '/usr/local/bin/basemind' },
    config: { binaryDownload: true },
  });

  const selection = await h.manager.select();
  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'path');
  assert.deepEqual(h.calls.resolve, ['basemind']);
});

test('a version mismatch on PATH falls through and records the real version', async (t) => {
  for (const version of ['0.33.0', '0.35.0', '0.34.1', '0.34.0-rc.1']) {
    const h = await setup(t, {
      resolve: { basemind: '/usr/local/bin/basemind' },
      probe: { '/usr/local/bin/basemind': probed(version) },
      config: { binaryDownload: false },
    });

    const selection = await h.manager.select();
    assert.equal(selection.ok, false, version);
    assert.ok(selection.reason.includes(version), selection.reason);
    assert.ok(selection.reason.includes('not compatible'), selection.reason);
  }
});

// ----------------------------------------------------------------- policy ----

test("binaryPolicy 'minor' accepts another patch but not another minor or a prerelease", async (t) => {
  const patch = await setup(t, {
    resolve: { basemind: '/usr/local/bin/basemind' },
    probe: { '/usr/local/bin/basemind': probed('0.34.2') },
    config: { binaryPolicy: 'minor', binaryDownload: false },
  });
  const patchSelection = await patch.manager.select();
  assert.equal(patchSelection.ok, true);
  assert.equal(patchSelection.policy, 'minor');

  for (const version of ['0.33.9', '0.35.1', '0.34.1-beta']) {
    const h = await setup(t, {
      resolve: { basemind: '/usr/local/bin/basemind' },
      probe: { '/usr/local/bin/basemind': probed(version) },
      config: { binaryPolicy: 'minor', binaryDownload: false },
    });
    const selection = await h.manager.select();
    assert.equal(selection.ok, false, version);
    assert.ok(selection.reason.includes(version), selection.reason);
  }
});

test("binaryPolicy 'any' accepts a prerelease, an old minor and an unparsable probe", async (t) => {
  const prerelease = await setup(t, {
    resolve: { basemind: '/usr/local/bin/basemind' },
    probe: { '/usr/local/bin/basemind': probed('0.34.0-rc.1') },
    config: { binaryPolicy: 'any', binaryDownload: false },
  });
  const preSelection = await prerelease.manager.select();
  assert.equal(preSelection.ok, true);
  assert.equal(preSelection.version, '0.34.0-rc.1');
  assert.equal(preSelection.policy, 'any');

  const old = await setup(t, {
    resolve: { basemind: '/usr/local/bin/basemind' },
    probe: { '/usr/local/bin/basemind': probed('0.29.3') },
    config: { binaryPolicy: 'any', binaryDownload: false },
  });
  assert.equal((await old.manager.select()).ok, true);

  const silent = await setup(t, {
    resolve: { basemind: '/usr/local/bin/basemind' },
    probe: { '/usr/local/bin/basemind': probeFailed('unparsable') },
    config: { binaryPolicy: 'any', binaryDownload: false },
  });
  const silentSelection = await silent.manager.select();
  assert.equal(silentSelection.ok, true, 'any accepts a binary that ran without a version line');
  assert.equal(silentSelection.source, 'path');
  assert.equal(silentSelection.version, undefined);
  assert.equal(silentSelection.reason, 'unverified');
});

// ----------------------------------------------------------- probe failures ---

test('timeout and unexecutable probe results are reported, never thrown', async (t) => {
  for (const reason of ['timeout', 'unexecutable', 'spawn-failed']) {
    const h = await setup(t, {
      resolve: { basemind: '/usr/local/bin/basemind' },
      probe: { '/usr/local/bin/basemind': probeFailed(reason) },
      config: { binaryDownload: false },
    });

    const selection = await h.manager.select();
    assert.equal(selection.ok, false);
    assert.ok(selection.reason.includes('could not be probed (' + reason + ')'), selection.reason);
    assert.equal(h.calls.download.length, 0);
  }
});

// ----------------------------------------------------------- managed cache ---

test('a valid managed cache is selected as source managed with zero network', async (t) => {
  const h = await setup(t, { config: { binaryDownload: true } });
  const seeded = await seedCache(h.targetDir, h.binaryName);

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'managed');
  assert.equal(selection.verified, true, 'a checksum-adopted managed binary is verified');
  assert.equal(selection.path, seeded.file);
  assert.equal(selection.version, VERSION);
  assert.deepEqual(h.calls.resolve, ['basemind'], 'only the PATH lookup was attempted');
  assert.equal(h.calls.checksums.length, 0);
  assert.equal(h.calls.download.length, 0);
  assert.equal(h.calls.hash.length, 0, 'a matching install record needs no re-hash');
});

test('binaryDownload false still uses a valid managed cache (no download is not no cache)', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false } });
  await seedCache(h.targetDir, h.binaryName);

  const selection = await h.manager.select();
  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'managed');
  assert.equal(h.calls.download.length, 0);
  assert.equal(h.calls.checksums.length, 0);
});

test('a cached binary whose digest does not match its install record is invalidated', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false }, digest: OTHER_DIGEST });
  await seedCache(h.targetDir, h.binaryName, { size: 1, mtimeMs: 1 });

  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.equal(existsSync(h.targetDir), false, 'the corrupt cache is removed');
  assert.equal(h.calls.hash.length, 1);
  assert.equal(h.calls.download.length, 0);
});

test('a changed binary that still matches its recorded digest is accepted after a re-hash', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false }, digest: DIGEST });
  await seedCache(h.targetDir, h.binaryName, { size: 1, mtimeMs: 1 });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'managed');
  assert.equal(h.calls.hash.length, 1);
});

test('a hand-placed single binary is an incomplete cache: not adopted, not deleted', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false } });
  const file = path.join(h.targetDir, h.binaryName);
  await mkdir(h.targetDir, { recursive: true });
  await writeFile(file, 'MZ manually placed basemind');

  const selection = await h.manager.select();

  assert.equal(selection.ok, false, 'a single binary cannot be a self-sufficient managed install');
  assert.equal(selection.source, undefined);
  assert.equal(existsSync(file), true, 'the incomplete cache is left for the atomic replacement');
  assert.equal(existsSync(path.join(h.targetDir, 'install.json')), false, 'no adoption record is written');
  assert.equal(h.calls.download.length, 0, 'binaryDownload false still performs no download');
});

// --------------------------------------------------------------- download ----

test('a layout-2 install records the complete extracted tree', async (t) => {
  const h = await setup(t, {
    config: { binaryDownload: true },
    extract: async (options) => {
      await mkdir(path.join(options.destDir, 'lib'), { recursive: true });
      await mkdir(path.join(options.destDir, 'licenses'), { recursive: true });
      await writeFile(options.destFile, 'MZ fake basemind binary');
      await writeFile(path.join(options.destDir, 'lib', 'libheif.so.1'), 'fake shared object');
      await writeFile(path.join(options.destDir, 'LICENSE'), 'Apache License 2.0\n');
      return { files: [], bytes: 0 };
    },
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(h.calls.extract.length, 1);
  assert.equal(path.basename(h.calls.extract[0].destDir), 'extracted', 'the whole archive is unpacked into staging/extracted');
  assert.equal(h.calls.extract[0].limits.maxTotalBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(h.calls.extract[0].limits.maxEntryBytes, 1024 * 1024 * 1024);
  assert.equal(h.calls.extract[0].limits.maxEntries, undefined, 'the default entry-count limit still applies');

  const install = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(install.layout, 2);
  assert.equal(install.binary, 'basemind');
  assert.deepEqual(install.files.map((file) => file.path), ['LICENSE', 'basemind', 'lib/libheif.so.1']);
  assert.deepEqual(install.files.find((file) => file.path === 'lib/libheif.so.1'), {
    path: 'lib/libheif.so.1',
    size: 'fake shared object'.length,
  });
  assert.equal(install.size, 'MZ fake basemind binary'.length);
  assert.equal(existsSync(path.join(h.targetDir, 'lib', 'libheif.so.1')), true);
  assert.equal(existsSync(path.join(h.targetDir, 'LICENSE')), true);
});

test('a layout-1 cache is treated as incomplete and re-downloaded', async (t) => {
  const h = await setup(t, { config: { binaryDownload: true } });
  const seeded = await seedLayout1Cache(h.targetDir, h.binaryName);

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'managed');
  assert.equal(h.calls.download.length, 1, 'the single-file cache is replaced, not patched');
  const install = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(install.layout, 2);
  assert.equal(install.binary, h.binaryName);
  assert.deepEqual(install.files, [{ path: h.binaryName, size: 'MZ fake basemind binary'.length }]);
  assert.equal(seeded.record.layout, undefined, 'the seeded record was the old layout');
});

test('a layout-2 record without a binary digest is treated as incomplete', async (t) => {
  // `sha256` is the archive digest and can never verify the unpacked binary, so a record
  // that does not carry `binarySha256` cannot prove its own contents.
  const h = await setup(t, { config: { binaryDownload: true } });
  await seedCache(h.targetDir, h.binaryName, { binarySha256: undefined });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(h.calls.download.length, 1, 'the unprovable cache is replaced');
  const install = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(install.layout, 2);
  assert.equal(install.binarySha256, DIGEST, 'the new record carries the binary digest');
});

test('a layout-2 cache with a missing lib file is detected and re-downloaded', async (t) => {
  const h = await setup(t, { config: { binaryDownload: true } });
  await seedCache(h.targetDir, h.binaryName, {}, { 'lib/libheif.so.1': 'fake shared object' });
  await rm(path.join(h.targetDir, 'lib', 'libheif.so.1'));

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(h.calls.download.length, 1, 'an incomplete tree is never reused');
  assert.ok(
    h.logger.warnings.some((warning) => warning.includes('incomplete') && warning.includes('lib/libheif.so.1')),
    'the missing file is reported',
  );
  const install = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(install.layout, 2);
  assert.deepEqual(install.files.map((file) => file.path), [h.binaryName]);
});

test('a layout-2 Windows cache missing heif.dll is detected and re-downloaded', async (t) => {
  const h = await setup(t, { platform: 'win32', arch: 'x64', config: { binaryDownload: true } });
  await seedCache(h.targetDir, 'basemind.exe', {}, { 'heif.dll': 'MZ fake heif' });
  await rm(path.join(h.targetDir, 'heif.dll'));

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(h.calls.download.length, 1, 'the statically imported DLL is part of the install');
  assert.ok(h.logger.warnings.some((warning) => warning.includes('heif.dll')), 'the missing DLL is reported');
  const install = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(install.layout, 2);
  assert.deepEqual(install.files, [{ path: 'basemind.exe', size: 'MZ fake basemind binary'.length }]);
});

test('binaryPath follows install.json.binary when it names the binary', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false } });
  const seeded = await seedCache(h.targetDir, 'basemind.exe');

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.path, seeded.file);
});

test('a failed re-install leaves the previous cache directory untouched', async (t) => {
  const h = await setup(t, { config: { binaryDownload: true }, download: 'throw' });
  const seeded = await seedLayout1Cache(h.targetDir, h.binaryName);

  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.equal(existsSync(seeded.file), true, 'the previous binary survives a failed download');
  const record = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(record.layout, undefined, 'the previous record is not rewritten');
  const staging = path.join(h.cacheRoot, 'download');
  assert.deepEqual(existsSync(staging) ? await readdir(staging) : [], [], 'staging is cleaned up');
});

test('an interrupted swap is recovered from the parked .old tree without a download', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false } });
  const parked = path.join(path.dirname(h.targetDir), '.old-linux-x64-crashed');
  await seedCache(parked, h.binaryName);

  const selection = await h.manager.select();

  assert.equal(selection.ok, true, selection.reason);
  assert.equal(selection.source, 'managed');
  assert.equal(h.calls.download.length, 0, 'recovery never downloads');
  assert.equal(h.calls.checksums.length, 0);
  assert.equal(existsSync(path.join(h.targetDir, h.binaryName)), true, 'the parked tree is back in place');
  assert.deepEqual(
    (await readdir(path.dirname(h.targetDir))).filter((name) => name.startsWith('.old-')),
    [],
    'the parked tree is consumed, not copied',
  );
});

test('a locked destination rename fails with an actionable message and keeps the old tree', async (t) => {
  let targetDir;
  let attempts = 0;
  const h = await setup(t, {
    config: { binaryDownload: true },
    renameFn: async (from, to) => {
      // Block only the swap of the extracted tree; the restore of the parked tree must
      // still be able to run once the lock clears.
      if (to === targetDir && path.basename(from).startsWith('.old-') === false) {
        attempts += 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return await renamePath(from, to);
    },
  });
  targetDir = h.targetDir;
  const seeded = await seedLayout1Cache(h.targetDir, h.binaryName);

  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.equal(attempts, 5, 'the rename retry is bounded');
  assert.ok(selection.reason.includes('after 5 attempts'), selection.reason);
  assert.ok(selection.reason.includes('restart DSH'), selection.reason);
  assert.equal(existsSync(seeded.file), true, 'the old tree is restored after the failed swap');
  const record = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(record.layout, undefined, 'the old record survives');
  assert.deepEqual(
    (await readdir(path.dirname(h.targetDir))).filter((name) => name.startsWith('.old-')),
    [],
    'no half-installed directory is left behind',
  );
});


test('binaryDownload true installs once when nothing local is usable', async (t) => {
  const h = await setup(t, { config: { binaryDownload: true } });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'managed');
  assert.equal(selection.path, path.join(h.targetDir, h.binaryName));
  assert.equal(h.calls.checksums.length, 1);
  assert.equal(h.calls.download.length, 1);
  assert.equal(h.calls.extract.length, 1);
  assert.equal(h.calls.extract[0].kind, 'tar.gz');
  assert.equal(h.calls.extract[0].entryPath, 'basemind');

  const install = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(install.sha256, DIGEST, 'sha256 is the downloaded archive digest');
  assert.equal(install.binarySha256, DIGEST, 'binarySha256 comes from the hasher seam');
  assert.equal(install.version, VERSION);
  assert.equal(install.target, 'linux-x64');
  assert.equal(install.tag, UPSTREAM.tag);
  assert.ok(install.url.includes('/' + UPSTREAM.tag + '/'));
  assert.equal(typeof install.installedAt, 'string');
  assert.equal(existsSync(path.join(h.targetDir, h.binaryName)), true);
});

test('a second manager instance reuses the installed cache with zero downloads', async (t) => {
  const first = await setup(t, { config: { binaryDownload: true } });
  const installed = await first.manager.select();
  assert.equal(installed.ok, true);

  const second = await setup(t, { cacheRoot: first.cacheRoot, config: { binaryDownload: true } });
  const reused = await second.manager.select();

  assert.equal(reused.ok, true);
  assert.equal(reused.source, 'managed');
  assert.equal(reused.path, installed.path);
  assert.equal(second.calls.download.length, 0);
  assert.equal(second.calls.checksums.length, 0);
  assert.equal(second.calls.extract.length, 0);
});

test('binaryDownload false performs no download, no checksums fetch and no cache write', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false } });

  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.ok(selection.reason.includes('binaryDownload is false'), selection.reason);
  assert.equal(h.calls.download.length, 0);
  assert.equal(h.calls.checksums.length, 0);
  assert.equal(existsSync(h.cacheRoot), false, 'the cache root is never created');
});

test('an incompatible local binary falls through to a managed download', async (t) => {
  const h = await setup(t, {
    resolve: { basemind: '/usr/local/bin/basemind' },
    probe: { '/usr/local/bin/basemind': probed('0.33.0') },
    config: { binaryDownload: true },
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'managed');
  assert.equal(h.calls.download.length, 1);
});

// ------------------------------------------------------------- unsupported ---

test('an unsupported platform fails with a diagnostic and never downloads', async (t) => {
  const h = await setup(t, { platform: 'darwin', arch: 'x64', config: { binaryDownload: true } });

  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.equal(selection.unsupported, true);
  assert.ok(selection.reason.includes('darwin-x64'), selection.reason);
  assert.ok(selection.reason.includes('build BaseMind from source'), selection.reason);
  assert.equal(h.calls.resolve.length, 0);
  assert.equal(h.calls.download.length, 0);
  assert.equal(h.calls.checksums.length, 0);
  assert.equal(existsSync(h.cacheRoot), false);

  const status = h.manager.status();
  assert.equal(status.platform, undefined);
  assert.ok(String(status.unsupported).includes('darwin-x64'));
});

test("Node's win32 platform maps onto the windows-x64 asset", async (t) => {
  const h = await setup(t, { platform: 'win32', arch: 'x64', config: { binaryDownload: true } });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.path, path.join(h.cacheRoot, 'managed-binaries', VERSION, 'windows-x64', 'basemind.exe'));
  assert.equal(h.calls.extract[0].entryPath, 'basemind.exe');
  assert.equal(h.calls.extract[0].kind, 'zip');
});

// ---------------------------------------------------------------- cooldown ---

test('a failed download starts a cooldown that blocks the next instance with zero network', async (t) => {
  const first = await setup(t, { config: { binaryDownload: true }, download: 'throw' });
  const failedSelection = await first.manager.select();

  assert.equal(failedSelection.ok, false);
  assert.ok(failedSelection.reason.includes('download failed'), failedSelection.reason);
  assert.equal(first.calls.download.length, 1);
  assert.equal(first.calls.checksums.length, 1);

  const state = JSON.parse(await readFile(path.join(first.cacheRoot, 'state.json'), 'utf8'));
  assert.equal(typeof state.lastFailureAt['linux-x64'], 'number');

  const second = await setup(t, { cacheRoot: first.cacheRoot, config: { binaryDownload: true } });
  const cooledSelection = await second.manager.select();

  assert.equal(cooledSelection.ok, false);
  assert.ok(cooledSelection.reason.includes('cooling down'), cooledSelection.reason);
  assert.equal(second.calls.download.length, 0);
  assert.equal(second.calls.checksums.length, 0);
  assert.equal(second.manager.status().download.state, 'cooldown');
});

test('a missing checksums line fails the install without a download', async (t) => {
  const h = await setup(t, { config: { binaryDownload: true }, checksums: 'missing-line' });

  const selection = await h.manager.select();

  assert.equal(selection.ok, false);
  assert.ok(selection.reason.includes('checksums'), selection.reason);
  assert.equal(h.calls.download.length, 0, 'no unverified binary is ever fetched');
});

// ------------------------------------------------------------------ order ----

test('the candidate order is explicit -> env -> PATH -> managed cache', async (t) => {
  const envThenPath = await setup(t, {
    env: { BASEMIND_BIN: '/pin/basemind' },
    resolve: { '/pin/basemind': '/pin/basemind', basemind: '/usr/local/bin/basemind' },
    probe: { '/pin/basemind': probed('0.33.0'), '/usr/local/bin/basemind': probed('0.34.1') },
    config: { binaryDownload: false },
  });
  const envThenPathSelection = await envThenPath.manager.select();
  assert.equal(envThenPathSelection.ok, false);
  assert.deepEqual(envThenPath.calls.resolve, ['/pin/basemind', 'basemind']);
  assert.equal(envThenPath.calls.download.length, 0);

  const commandThenPathThenCache = await setup(t, {
    config: { command: '/opt/custom/basemind', binaryDownload: true },
    resolve: { '/opt/custom/basemind': '/opt/custom/basemind', basemind: '/usr/local/bin/basemind' },
    probe: { '/opt/custom/basemind': probed('0.33.0'), '/usr/local/bin/basemind': probed('0.35.0') },
  });
  await seedCache(commandThenPathThenCache.targetDir, commandThenPathThenCache.binaryName);
  const cached = await commandThenPathThenCache.manager.select();

  assert.equal(cached.ok, true);
  assert.equal(cached.source, 'managed');
  assert.deepEqual(commandThenPathThenCache.calls.resolve, ['/opt/custom/basemind', 'basemind']);
  assert.equal(commandThenPathThenCache.calls.download.length, 0, 'the cache short-circuits the download');
});

// ------------------------------------------------------------------- npx -----

test('the legacy npx fallback is last and only with autoProvision', async (t) => {
  const h = await setup(t, {
    resolve: { npx: '/usr/local/bin/npx' },
    config: { binaryDownload: false, autoProvision: true, npxSpec: 'basemind@0.34.0' },
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'npx');
  assert.equal(selection.reason, 'legacy');
  assert.equal(selection.verified, false, 'the unverified npx path must never be treated as verified');
  assert.deepEqual(selection.extraArgs, ['-y', 'basemind@0.34.0']);
  assert.deepEqual(h.calls.resolve, ['basemind', 'npx'], 'npx is resolved after PATH');
});

// ----------------------------------------------------------------- status ----

test('status() reports selection, cache and download state', async (t) => {
  const h = await setup(t, { config: { binaryDownload: true } });

  const before = h.manager.status();
  assert.equal(typeof before.pluginVersion, 'string');
  assert.equal(before.expected, VERSION);
  assert.equal(before.policy, 'exact');
  assert.equal(before.platform, 'linux-x64');
  assert.equal(before.selection, undefined);
  assert.equal(before.cache.root, h.managedRoot);
  assert.equal(before.cache.target, 'linux-x64');
  assert.equal(before.cache.present, false);
  assert.equal(before.download.state, 'idle');

  await h.manager.select();

  const after = h.manager.status();
  assert.equal(after.selection.source, 'managed');
  assert.equal(after.selection.compatible, true);
  assert.equal(after.selection.version, VERSION);
  assert.equal(after.cache.present, true);
  assert.equal(after.cache.valid, true);
  assert.equal(after.cache.sha256, DIGEST);
  assert.equal(typeof after.cache.installedAt, 'string');
  assert.ok(after.download.attempts >= 1);
});

test('status() also reports a failed selection', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false } });
  await h.manager.select();

  const status = h.manager.status();
  assert.equal(status.selection.compatible, false);
  assert.ok(status.selection.reason.includes('no compatible'));
  assert.equal(status.cache.present, false);
});

test('dispose() stops accepting callers and aborts an in-flight install', async (t) => {
  const h = await setup(t, { config: { binaryDownload: false } });
  await h.manager.dispose();
  const afterDispose = await h.manager.select();
  assert.equal(afterDispose.ok, false);
  assert.ok(afterDispose.reason.includes('shutting down'), afterDispose.reason);
});
