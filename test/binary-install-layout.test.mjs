import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createBinaryManager } from '../lib/binary/manager.js';
import { parseBasemindVersion } from '../lib/binary/probe.js';
import { UPSTREAM, assetFor } from '../lib/upstream.js';

const VERSION = UPSTREAM.version;
/** The archive digest the checksums file publishes. */
const DIGEST = 'd'.repeat(64);
/** The digest of the unpacked main binary; deliberately different from DIGEST. */
const BINARY_DIGEST = 'e'.repeat(64);
const FIXED_NOW = 1_700_000_000_000;
const IS_WINDOWS = process.platform === 'win32';

const BINARY = Buffer.from('MZ pretend this is the basemind executable\n'.repeat(8));
const DLL = Buffer.from('MZ pretend this is heif.dll\n'.repeat(4));
const SECOND_DLL = Buffer.from('MZ pretend this is libde265.dll\n'.repeat(3));
const SHARED = Buffer.from('\x7fELF pretend this is libheif.so.1\n'.repeat(5));
const SECOND_SHARED = Buffer.from('\x7fELF pretend this is libde265.so.0\n'.repeat(2));
const LICENSE = Buffer.from('Apache License 2.0\n');
const ATTRIBUTIONS = Buffer.from('# third-party notices\n\n- heif\n');
const LICENCE_TEXT = Buffer.from('heif licence text\n');

// ------------------------------------------------------------------ helpers ---

/** Octal field: `length - 1` digits and a terminating NUL. */
function octalField(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

/** One ustar header block with a correct checksum. */
function tarHeader({ name = '', size = 0, type = '0', mode = 0o644 }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(octalField(mode, 8), 100, 8, 'ascii');
  block.write(octalField(0, 8), 108, 8, 'ascii');
  block.write(octalField(0, 8), 116, 8, 'ascii');
  block.write(octalField(size, 12), 124, 12, 'ascii');
  block.write(octalField(0, 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octalField(sum, 7) + ' ', 148, 8, 'ascii');
  return block;
}

/** Build a tar stream; entries are { name, data, type, mode }. */
function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const data = Buffer.from(entry.data ?? []);
    parts.push(tarHeader({ name: entry.name, size: data.length, type, mode: entry.mode }));
    if (data.length > 0) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Build a zip archive (deflate unless method 0); entries are { name, data } or directories. */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? []);
    const method = entry.method ?? 8;
    const payload = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(data) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

/** The official Windows x64 release shape: root DLLs, empty lib/, licences. */
function windowsReleaseZip() {
  return buildZip([
    { name: 'ATTRIBUTIONS.md', data: ATTRIBUTIONS },
    { name: 'basemind.exe', data: BINARY },
    { name: 'heif.dll', data: DLL },
    { name: 'lib/', data: Buffer.alloc(0) },
    { name: 'libde265.dll', data: SECOND_DLL },
    { name: 'LICENSE', data: LICENSE },
    { name: 'licenses/', data: Buffer.alloc(0) },
    { name: 'licenses/heif.dll.txt', data: LICENCE_TEXT },
    { name: 'THIRD_PARTY_LICENSES', data: ATTRIBUTIONS },
  ]);
}

/** The official Linux x64 release shape: ./ prefix, lib/ and licences. */
function linuxReleaseTarGz() {
  return zlib.gzipSync(
    buildTar([
      { name: './', type: '5' },
      { name: './THIRD_PARTY_LICENSES', data: ATTRIBUTIONS },
      { name: './licenses/', type: '5' },
      { name: './licenses/libheif.so.1.txt', data: LICENCE_TEXT },
      { name: './LICENSE', data: LICENSE },
      { name: './ATTRIBUTIONS.md', data: ATTRIBUTIONS },
      { name: './lib/', type: '5' },
      { name: './lib/libde265.so.0', data: SECOND_SHARED, mode: 0o755 },
      { name: './lib/libheif.so.1', data: SHARED, mode: 0o755 },
      { name: './basemind', data: BINARY, mode: 0o755 },
    ]),
  );
}

/** An error that stands in for an unresolvable executable. */
function missing(command) {
  const error = new Error("'" + command + "' was not found");
  error.code = 'ENOENT';
  return error;
}

/**
 * A manager with every network and subprocess seam mocked but the real archive
 * extractor: the downloader only writes the pre-built archive bytes.
 */
async function setup(t, spec) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bm-layout-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const cacheRoot = spec.cacheRoot ?? path.join(dir, 'cache');
  const archiveBytes = spec.archive;
  const asset = assetFor(spec.targetKey);
  const calls = { resolve: [], checksums: 0, download: 0, probe: [] };
  const strictCache = spec.strictCache === true;
  const refuse = (message) => {
    throw new Error(message);
  };

  const ctx = {
    subprocess: {
      async resolveExecutable(command) {
        calls.resolve.push(command);
        throw missing(command);
      },
    },
  };
  const probeFn = async ({ exe }) => {
    calls.probe.push(exe);
    return { ok: true, raw: 'basemind ' + VERSION, parsed: parseBasemindVersion('basemind ' + VERSION), version: VERSION };
  };

  const manager = createBinaryManager({
    ctx,
    config: { binaryDownload: true, binaryPolicy: 'exact' },
    logger: { warn() {}, info() {}, debug() {} },
    env: {},
    platform: spec.platform,
    arch: 'x64',
    cacheRoot,
    homedir: dir,
    fetchImpl: async () => {
      throw new Error('the network is disabled in this test');
    },
    now: () => FIXED_NOW,
    sleep: async () => {},
    probeFn,
    checksumsFetcher: async () => {
      calls.checksums += 1;
      if (strictCache) refuse('the checksums must not be fetched for a valid cache');
      return DIGEST + '  ' + asset.name + '\n';
    },
    downloader: async ({ destFile, sha256 }) => {
      calls.download += 1;
      if (strictCache) refuse('the asset must not be downloaded for a valid cache');
      await mkdir(path.dirname(destFile), { recursive: true });
      await writeFile(destFile, archiveBytes);
      return { sha256, bytes: archiveBytes.length };
    },
    hasher: async () => {
      if (strictCache) refuse('an intact layout-2 tree must not be hashed');
      return BINARY_DIGEST;
    },
  });

  return {
    dir,
    cacheRoot,
    calls,
    manager,
    targetDir: path.join(cacheRoot, 'managed-binaries', VERSION, spec.targetKey),
  };
}

/** @param {string} file @returns {Promise<number>} the POSIX permission bits. */
async function modeOf(file) {
  return (await stat(file)).mode & 0o777;
}

// ------------------------------------------------------------------- tests ---

test('a Windows-shaped zip installs the complete release tree and its record', async (t) => {
  const h = await setup(t, {
    platform: 'win32',
    targetKey: 'windows-x64',
    archive: windowsReleaseZip(),
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.source, 'managed');
  assert.equal(selection.path, path.join(h.targetDir, 'basemind.exe'));
  assert.equal(h.calls.download, 1);

  assert.deepEqual((await readdir(h.targetDir)).sort(), [
    'ATTRIBUTIONS.md',
    'LICENSE',
    'THIRD_PARTY_LICENSES',
    'basemind.exe',
    'heif.dll',
    'install.json',
    'lib',
    'libde265.dll',
    'licenses',
  ]);
  assert.deepEqual(await readFile(path.join(h.targetDir, 'heif.dll')), DLL);
  assert.deepEqual(await readFile(path.join(h.targetDir, 'libde265.dll')), SECOND_DLL);
  assert.deepEqual(await readFile(path.join(h.targetDir, 'licenses', 'heif.dll.txt')), LICENCE_TEXT);
  assert.equal((await stat(path.join(h.targetDir, 'lib'))).isDirectory(), true, 'the empty lib/ directory exists');
  assert.deepEqual(await readdir(path.join(h.targetDir, 'lib')), []);

  const install = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(install.layout, 2);
  assert.equal(install.version, VERSION);
  assert.equal(install.target, 'windows-x64');
  assert.equal(install.binary, 'basemind.exe');
  assert.equal(install.sha256, DIGEST, 'sha256 stays the downloaded archive digest');
  assert.equal(install.binarySha256, BINARY_DIGEST, 'binarySha256 is the unpacked binary digest');
  assert.equal(install.tag, UPSTREAM.tag);
  assert.equal(typeof install.installedAt, 'string');
  assert.equal(install.size, BINARY.length);
  assert.deepEqual(install.files.map((file) => file.path), [
    'ATTRIBUTIONS.md',
    'LICENSE',
    'THIRD_PARTY_LICENSES',
    'basemind.exe',
    'heif.dll',
    'libde265.dll',
    'licenses/heif.dll.txt',
  ]);
  for (const file of install.files) {
    assert.equal((await stat(path.join(h.targetDir, file.path))).size, file.size, file.path);
  }

  const staging = path.join(h.cacheRoot, 'download');
  assert.deepEqual(existsSync(staging) ? await readdir(staging) : [], [], 'staging is cleaned up');
});

test('a Linux-shaped tar.gz installs the tree and applies executable modes on POSIX', async (t) => {
  const h = await setup(t, {
    platform: 'linux',
    targetKey: 'linux-x64',
    archive: linuxReleaseTarGz(),
  });

  const selection = await h.manager.select();

  assert.equal(selection.ok, true);
  assert.equal(selection.path, path.join(h.targetDir, 'basemind'));
  assert.deepEqual((await readdir(path.join(h.targetDir, 'lib'))).sort(), ['libde265.so.0', 'libheif.so.1']);
  assert.deepEqual(await readFile(path.join(h.targetDir, 'lib', 'libheif.so.1')), SHARED);
  assert.deepEqual(await readFile(path.join(h.targetDir, 'ATTRIBUTIONS.md')), ATTRIBUTIONS);

  const install = JSON.parse(await readFile(path.join(h.targetDir, 'install.json'), 'utf8'));
  assert.equal(install.layout, 2);
  assert.equal(install.target, 'linux-x64');
  assert.equal(install.binary, 'basemind');
  assert.equal(install.size, BINARY.length);
  assert.deepEqual(install.files.map((file) => file.path), [
    'ATTRIBUTIONS.md',
    'LICENSE',
    'THIRD_PARTY_LICENSES',
    'basemind',
    'lib/libde265.so.0',
    'lib/libheif.so.1',
    'licenses/libheif.so.1.txt',
  ]);

  if (IS_WINDOWS === false) {
    for (const relative of ['basemind', 'lib/libheif.so.1', 'lib/libde265.so.0']) {
      assert.equal(await modeOf(path.join(h.targetDir, relative)), 0o755, relative);
    }
    for (const relative of ['LICENSE', 'ATTRIBUTIONS.md', 'licenses/libheif.so.1.txt']) {
      assert.equal(await modeOf(path.join(h.targetDir, relative)), 0o644, relative);
    }
  }
});

test('an installed layout-2 tree is reused with zero network and zero extraction', async (t) => {
  const first = await setup(t, { platform: 'linux', targetKey: 'linux-x64', archive: linuxReleaseTarGz() });
  const installed = await first.manager.select();
  assert.equal(installed.ok, true);

  const second = await setup(t, {
    platform: 'linux',
    targetKey: 'linux-x64',
    archive: linuxReleaseTarGz(),
    cacheRoot: first.cacheRoot,
    strictCache: true,
  });
  const reused = await second.manager.select();

  assert.equal(reused.ok, true);
  assert.equal(reused.source, 'managed');
  assert.equal(reused.path, installed.path);
  assert.equal(second.calls.checksums, 0);
  assert.equal(second.calls.download, 0);
});
