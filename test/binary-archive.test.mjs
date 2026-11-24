import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { extractSingleFile, extractArchive, ArchiveError } from '../lib/binary/archive.js';

const BINARY = Buffer.from('MZ pretend this is the basemind executable\n'.repeat(8));

// ------------------------------------------------------------------ helpers ---

async function withTempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bm-archive-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Octal field: `length - 1` digits and a terminating NUL. */
function octalField(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

/** One ustar header block with a correct checksum. */
function tarHeader({ name = '', size = 0, type = '0', prefix = '', mode = 0o644 }) {
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
  if (prefix !== '') block.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octalField(sum, 7) + ' ', 148, 8, 'ascii');
  return block;
}

/** Build a tar stream; `entries` are { name, data, type, prefix, mode }. */
function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const data = type === '0' ? Buffer.from(entry.data ?? []) : Buffer.from(entry.data ?? []);
    parts.push(tarHeader({ name: entry.name, size: data.length, type, prefix: entry.prefix, mode: entry.mode }));
    if (data.length > 0) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Gzip a tar stream. */
function tarGz(entries) {
  return zlib.gzipSync(buildTar(entries));
}

/** Build a zip archive; entries are { name, data, method, externalAttrs, flags, uncompSize }. */
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
    const compSize = entry.compSize ?? payload.length;
    const uncompSize = entry.uncompSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.externalAttrs ?? 0) >>> 0, 38);
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

/** Assert that extraction fails with a specific ArchiveError code. */
async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArchiveError, 'expected an ArchiveError, got ' + String(error));
    assert.equal(error.code, code, 'error.message');
    return true;
  });
}

// ------------------------------------------------------------------ tar.gz ----

test('tar.gz: extracts the root-level binary and reports its size', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(archive, tarGz([{ name: 'basemind', data: BINARY }]));

  const result = await extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest });

  assert.deepEqual(result, { bytes: BINARY.length });
  assert.deepEqual(await readFile(dest), BINARY);
});

test('tar.gz: extracts basemind.exe when that is the entry name', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind.exe');
  await writeFile(archive, tarGz([{ name: 'basemind.exe', data: BINARY }]));

  const result = await extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind.exe', destFile: dest });
  assert.equal(result.bytes, BINARY.length);
  assert.deepEqual(await readFile(dest), BINARY);
});

test('tar.gz: a Buffer archive is accepted too', async (t) => {
  const dir = await withTempDir(t);
  const dest = path.join(dir, 'basemind');
  const result = await extractSingleFile({
    archive: tarGz([{ name: 'basemind', data: BINARY }]),
    kind: 'tar.gz',
    entryPath: 'basemind',
    destFile: dest,
  });
  assert.equal(result.bytes, BINARY.length);
});

test('tar.gz: skips directory, pax and GNU long-name headers before the binary', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(
    archive,
    tarGz([
      { name: './', type: '5' },
      { name: 'pax-header', type: 'x', data: Buffer.from('30 mtime=1700000000\n') },
      { name: '././@LongLink', type: 'L', data: Buffer.from('some/long/name\0') },
      { name: 'basemind', data: BINARY },
    ]),
  );

  const result = await extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest });
  assert.equal(result.bytes, BINARY.length);
  assert.deepEqual(await readFile(dest), BINARY);
});

test('tar.gz: only a root-level entry is extractable (ustar prefix does not count)', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(archive, tarGz([{ name: 'basemind', prefix: 'nested/dir', data: BINARY }]));

  await expectFailure(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest }),
    'missing-entry',
  );
  assert.equal(existsSync(dest), false);
});

test('tar.gz: rejects a symlink entry anywhere in the archive', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(
    archive,
    tarGz([
      { name: 'evil-link', type: '2' },
      { name: 'basemind', data: BINARY },
    ]),
  );

  await expectFailure(extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest }), 'link-entry');
  assert.equal(existsSync(dest), false, 'nothing is written when a link entry is present');
});

test('tar.gz: rejects a hardlink entry', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(archive, tarGz([{ name: 'hard', type: '1' }, { name: 'basemind', data: BINARY }]));

  await expectFailure(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: path.join(dir, 'out') }),
    'link-entry',
  );
});

test('tar.gz: rejects a device/fifo entry type', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(archive, tarGz([{ name: 'fifo', type: '6' }, { name: 'basemind', data: BINARY }]));

  await expectFailure(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: path.join(dir, 'out') }),
    'unsupported-entry-type',
  );
});

test('tar.gz: rejects a traversal entry and never writes outside destFile', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(archive, tarGz([{ name: '../../evil.txt', data: BINARY }, { name: 'basemind', data: BINARY }]));

  await expectFailure(extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest }), 'path-traversal');
  assert.equal(existsSync(dest), false);
  assert.deepEqual((await readdir(dir)).sort(), ['basemind.tar.gz']);
});

test('tar.gz: an absolute entry name is rejected', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(archive, tarGz([{ name: '/etc/evil', data: BINARY }, { name: 'basemind', data: BINARY }]));

  await expectFailure(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: path.join(dir, 'out') }),
    'path-traversal',
  );
});

test('tar.gz: a missing entry fails with missing-entry', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(archive, tarGz([{ name: 'other', data: BINARY }]));

  await expectFailure(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: path.join(dir, 'out') }),
    'missing-entry',
  );
});

test('tar.gz: a corrupt gzip stream fails with bad-gzip', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(archive, Buffer.from('this is definitely not gzip data'));

  await expectFailure(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: path.join(dir, 'out') }),
    'bad-gzip',
  );
});

test('tar.gz: gzip of non-tar bytes fails instead of guessing', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(archive, zlib.gzipSync(Buffer.from('x'.repeat(1024))));

  await expectFailure(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: path.join(dir, 'out') }),
    'malformed',
  );
});

test('tar.gz: a truncated entry stream fails', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'out');
  // The header declares 1024 bytes but only one 512-byte block follows.
  const truncated = Buffer.concat([tarHeader({ name: 'basemind', size: 1024 }), Buffer.alloc(512, 1)]);
  await writeFile(archive, zlib.gzipSync(truncated));

  await assert.rejects(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest }),
    (error) => {
      assert.ok(error instanceof ArchiveError);
      assert.match(error.code, /truncated-archive|malformed/);
      return true;
    },
  );
  assert.equal(existsSync(dest), false);
});

test('tar.gz: maxEntryBytes is enforced', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(archive, tarGz([{ name: 'basemind', data: BINARY }]));

  await expectFailure(
    extractSingleFile({
      archive,
      kind: 'tar.gz',
      entryPath: 'basemind',
      destFile: path.join(dir, 'out'),
      limits: { maxEntryBytes: 16 },
    }),
    'too-large',
  );
});

test('tar.gz: maxEntries is enforced', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(
    archive,
    tarGz([
      { name: 'a', data: BINARY },
      { name: 'b', data: BINARY },
      { name: 'basemind', data: BINARY },
    ]),
  );

  await expectFailure(
    extractSingleFile({
      archive,
      kind: 'tar.gz',
      entryPath: 'basemind',
      destFile: path.join(dir, 'out'),
      limits: { maxEntries: 2 },
    }),
    'too-many-entries',
  );
});

test('tar.gz: maxTotalBytes is enforced across entries', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(
    archive,
    tarGz([
      { name: 'a', data: BINARY },
      { name: 'b', data: BINARY },
      { name: 'basemind', data: BINARY },
    ]),
  );

  await expectFailure(
    extractSingleFile({
      archive,
      kind: 'tar.gz',
      entryPath: 'basemind',
      destFile: path.join(dir, 'out'),
      limits: { maxTotalBytes: BINARY.length * 2 },
    }),
    'too-large',
  );
});

test('tar.gz: a duplicate target entry is rejected', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  await writeFile(
    archive,
    tarGz([
      { name: 'basemind', data: BINARY },
      { name: 'basemind', data: BINARY },
    ]),
  );

  await expectFailure(
    extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: path.join(dir, 'out') }),
    'duplicate-entry',
  );
});

// The upstream release script packs with `tar czf ... -C "$STAGING_DIR" .`, so every
// member name is `./`-prefixed and other regular files surround the binary.
const RELEASE_LICENSE = Buffer.from('Apache License 2.0\n');
const RELEASE_SHARED_OBJECT = Buffer.from('\x7fELF pretend shared object payload\n'.repeat(4));

test('tar.gz: extracts ./basemind from a package-release.sh shaped archive', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind-x86_64-unknown-linux-gnu.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(
    archive,
    tarGz([
      { name: './', type: '5' },
      { name: './LICENSE', data: RELEASE_LICENSE },
      { name: './basemind', data: BINARY },
      { name: './lib/libx.so', data: RELEASE_SHARED_OBJECT },
    ]),
  );

  const result = await extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest });

  assert.deepEqual(result, { bytes: BINARY.length });
  assert.deepEqual(await readFile(dest), BINARY, 'only the target payload is written');
});

test('tar.gz: extracts ./basemind when it is the first entry', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(
    archive,
    tarGz([
      { name: './basemind', data: BINARY },
      { name: './LICENSE', data: RELEASE_LICENSE },
    ]),
  );

  const result = await extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest });
  assert.deepEqual(result, { bytes: BINARY.length });
  assert.deepEqual(await readFile(dest), BINARY);
});

test('tar.gz: extracts ./basemind when it is the last entry', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(
    archive,
    tarGz([
      { name: './', type: '5' },
      { name: './LICENSE', data: RELEASE_LICENSE },
      { name: './basemind', data: BINARY },
    ]),
  );

  const result = await extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest });
  assert.deepEqual(result, { bytes: BINARY.length });
  assert.deepEqual(await readFile(dest), BINARY);
});

test('tar.gz: a regular file after the target is not appended to destFile', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(
    archive,
    tarGz([
      { name: 'basemind', data: BINARY },
      { name: 'LICENSE', data: RELEASE_LICENSE },
    ]),
  );

  const result = await extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest });
  assert.deepEqual(result, { bytes: BINARY.length });
  assert.deepEqual(await readFile(dest), BINARY);
});

// --------------------------------------------------------------------- zip ----

test('zip: extracts a deflated root-level binary', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  const dest = path.join(dir, 'basemind.exe');
  await writeFile(archive, buildZip([{ name: 'basemind.exe', data: BINARY }]));

  const result = await extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: dest });

  assert.deepEqual(result, { bytes: BINARY.length });
  assert.deepEqual(await readFile(dest), BINARY);
});

test('zip: extracts a stored (method 0) entry and skips directory entries', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  const dest = path.join(dir, 'basemind.exe');
  await writeFile(
    archive,
    buildZip([
      { name: 'docs/', data: Buffer.alloc(0) },
      { name: 'basemind.exe', data: BINARY, method: 0 },
    ]),
  );

  const result = await extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: dest });
  assert.equal(result.bytes, BINARY.length);
  assert.deepEqual(await readFile(dest), BINARY);
});

test('zip: accepts a Buffer archive', async (t) => {
  const dir = await withTempDir(t);
  const dest = path.join(dir, 'basemind.exe');
  const result = await extractSingleFile({
    archive: buildZip([{ name: 'basemind.exe', data: BINARY }]),
    kind: 'zip',
    entryPath: 'basemind.exe',
    destFile: dest,
  });
  assert.equal(result.bytes, BINARY.length);
});

test('zip: ../../evil.txt is rejected and nothing is written', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  const dest = path.join(dir, 'basemind.exe');
  await writeFile(
    archive,
    buildZip([
      { name: '../../evil.txt', data: Buffer.from('pwned') },
      { name: 'basemind.exe', data: BINARY },
    ]),
  );

  await expectFailure(extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: dest }), 'path-traversal');

  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(path.join(dir, '..', '..', 'evil.txt')), false);
  assert.deepEqual((await readdir(dir)).sort(), ['basemind.zip']);
});

test('zip: a symlink entry is rejected via the external attributes', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  const dest = path.join(dir, 'basemind.exe');
  await writeFile(
    archive,
    buildZip([
      { name: 'evil-link', data: Buffer.from('/etc/passwd'), externalAttrs: 0o120777 << 16 },
      { name: 'basemind.exe', data: BINARY },
    ]),
  );

  await expectFailure(extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: dest }), 'link-entry');
  assert.equal(existsSync(dest), false);
});

test('zip: an encrypted entry is rejected', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  await writeFile(archive, buildZip([{ name: 'basemind.exe', data: BINARY, flags: 0x1 }]));

  await expectFailure(
    extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: path.join(dir, 'out') }),
    'encrypted',
  );
});

test('zip: a truncated archive (no EOCD) fails', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  const full = buildZip([{ name: 'basemind.exe', data: BINARY }]);
  await writeFile(archive, full.subarray(0, full.length - 22));

  await expectFailure(
    extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: path.join(dir, 'out') }),
    'malformed',
  );
});

test('zip: a central directory offset beyond the file fails', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  const full = buildZip([{ name: 'basemind.exe', data: BINARY }]);
  const patched = Buffer.from(full);
  patched.writeUInt32LE(full.length + 100, full.length - 22 + 16);
  await writeFile(archive, patched);

  await expectFailure(
    extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: path.join(dir, 'out') }),
    'truncated-archive',
  );
});

test('zip: a zip64 marker fails with a clear zip64 code', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  const full = buildZip([{ name: 'basemind.exe', data: BINARY }]);
  const patched = Buffer.from(full);
  patched.writeUInt16LE(0xffff, full.length - 22 + 10); // total entries sentinel
  await writeFile(archive, patched);

  await expectFailure(
    extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: path.join(dir, 'out') }),
    'zip64',
  );
});

test('zip: a missing entry fails with missing-entry', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  await writeFile(archive, buildZip([{ name: 'other.exe', data: BINARY }]));

  await expectFailure(
    extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: path.join(dir, 'out') }),
    'missing-entry',
  );
});

test('zip: an unsupported compression method is reported', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  const patched = buildZip([{ name: 'basemind.exe', data: BINARY, method: 0 }]);
  // Patch the central-directory method to bzip2 (12) so the local header stays readable.
  const centralStart = patched.readUInt32LE(patched.length - 22 + 16);
  patched.writeUInt16LE(12, centralStart + 10);
  await writeFile(archive, patched);

  await expectFailure(
    extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: path.join(dir, 'out') }),
    'unsupported-compression',
  );
});

test('zip: an entry above maxEntryBytes is rejected before inflating', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  await writeFile(archive, buildZip([{ name: 'basemind.exe', data: BINARY }]));

  await expectFailure(
    extractSingleFile({
      archive,
      kind: 'zip',
      entryPath: 'basemind.exe',
      destFile: path.join(dir, 'out'),
      limits: { maxEntryBytes: 8 },
    }),
    'too-large',
  );
});

test('zip: maxEntries is enforced', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  await writeFile(
    archive,
    buildZip([
      { name: 'a', data: BINARY },
      { name: 'b', data: BINARY },
      { name: 'basemind.exe', data: BINARY },
    ]),
  );

  await expectFailure(
    extractSingleFile({
      archive,
      kind: 'zip',
      entryPath: 'basemind.exe',
      destFile: path.join(dir, 'out'),
      limits: { maxEntries: 2 },
    }),
    'too-many-entries',
  );
});

test('zip: a declared size that does not match the payload fails', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind.zip');
  await writeFile(archive, buildZip([{ name: 'basemind.exe', data: BINARY, uncompSize: BINARY.length + 10 }]));

  await assert.rejects(
    extractSingleFile({ archive, kind: 'zip', entryPath: 'basemind.exe', destFile: path.join(dir, 'out') }),
    (error) => {
      assert.ok(error instanceof ArchiveError);
      assert.match(error.code, /size-mismatch|too-large|malformed/);
      return true;
    },
  );
});

// --------------------------------------------------------------- arguments ----

test('an unknown kind, a nested entryPath and a missing archive are rejected', async (t) => {
  const dir = await withTempDir(t);
  const dest = path.join(dir, 'out');

  await expectFailure(extractSingleFile({ archive: Buffer.alloc(1), kind: 'tar', entryPath: 'basemind', destFile: dest }), 'bad-kind');
  await expectFailure(extractSingleFile({ archive: Buffer.alloc(1), kind: undefined, entryPath: 'basemind', destFile: dest }), 'bad-kind');
  await expectFailure(
    extractSingleFile({ archive: Buffer.alloc(1), kind: 'zip', entryPath: 'nested/basemind', destFile: dest }),
    'bad-entry',
  );
  await expectFailure(extractSingleFile({ kind: 'zip', entryPath: 'basemind', destFile: dest }), 'io');
  await expectFailure(extractSingleFile({ archive: Buffer.alloc(1), kind: 'zip', entryPath: 'basemind' }), 'io');
});

test('a missing archive file surfaces as an io failure', async (t) => {
  const dir = await withTempDir(t);

  await expectFailure(
    extractSingleFile({
      archive: path.join(dir, 'nope.tar.gz'),
      kind: 'tar.gz',
      entryPath: 'basemind',
      destFile: path.join(dir, 'out'),
    }),
    'io',
  );
  await expectFailure(
    extractSingleFile({
      archive: path.join(dir, 'nope.zip'),
      kind: 'zip',
      entryPath: 'basemind',
      destFile: path.join(dir, 'out'),
    }),
    'io',
  );
});

test('extractSingleFile with no arguments fails with a clear code instead of throwing a TypeError', async () => {
  await expectFailure(extractSingleFile(), 'bad-kind');
});

test('ArchiveError carries the failure code and is an Error', () => {
  const error = new ArchiveError('path-traversal', 'nope');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ArchiveError');
  assert.equal(error.code, 'path-traversal');
});

// --------------------------------------------------------- whole archive -----

const RELEASE_DLL = Buffer.from('MZ pretend this is heif.dll\n'.repeat(4));
const SECOND_DLL = Buffer.from('MZ pretend this is libde265.dll\n'.repeat(2));
const ATTRIBUTIONS = Buffer.from('# third-party notices\n\n- heif\n');
const EMPTY = Buffer.alloc(0);

/** Every regular file a whole-tree extraction must produce, sorted by path. */
function expectedFiles(entries) {
  return entries
    .map((entry) => ({ path: entry.path, size: entry.data.length }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

test('tar.gz whole archive: extracts the ./ prefixed tree, creates lib/ and keeps modes', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind-x86_64-unknown-linux-gnu.tar.gz');
  const destDir = path.join(dir, 'out');
  const binary = Buffer.from(BINARY);
  await writeFile(
    archive,
    tarGz([
      { name: './', type: '5' },
      { name: './THIRD_PARTY_LICENSES', data: RELEASE_LICENSE },
      { name: './licenses/', type: '5' },
      { name: './licenses/libheif.so.1.txt', data: ATTRIBUTIONS },
      { name: './basemind', data: binary, mode: 0o755 },
      { name: './lib/', type: '5' },
      { name: './lib/libheif.so.1', data: RELEASE_SHARED_OBJECT, mode: 0o755 },
      { name: './lib/libde265.so.0', data: SECOND_DLL, mode: 0o755 },
      { name: './LICENSE', data: RELEASE_LICENSE },
      { name: './ATTRIBUTIONS.md', data: ATTRIBUTIONS },
    ]),
  );

  const result = await extractArchive({ archive, kind: 'tar.gz', destDir });

  assert.deepEqual(
    result.files,
    expectedFiles([
      { path: 'ATTRIBUTIONS.md', data: ATTRIBUTIONS },
      { path: 'LICENSE', data: RELEASE_LICENSE },
      { path: 'THIRD_PARTY_LICENSES', data: RELEASE_LICENSE },
      { path: 'basemind', data: binary },
      { path: 'lib/libde265.so.0', data: SECOND_DLL },
      { path: 'lib/libheif.so.1', data: RELEASE_SHARED_OBJECT },
      { path: 'licenses/libheif.so.1.txt', data: ATTRIBUTIONS },
    ]),
  );
  assert.equal(
    result.bytes,
    ATTRIBUTIONS.length + RELEASE_LICENSE.length * 2 + binary.length + SECOND_DLL.length + RELEASE_SHARED_OBJECT.length + ATTRIBUTIONS.length,
  );
  assert.deepEqual(await readFile(path.join(destDir, 'basemind')), binary);
  assert.deepEqual(await readFile(path.join(destDir, 'lib', 'libheif.so.1')), RELEASE_SHARED_OBJECT);
  assert.deepEqual((await readdir(path.join(destDir, 'lib'))).sort(), ['libde265.so.0', 'libheif.so.1']);
  assert.deepEqual((await readdir(destDir)).sort(), [
    'ATTRIBUTIONS.md',
    'LICENSE',
    'THIRD_PARTY_LICENSES',
    'basemind',
    'lib',
    'licenses',
  ]);

  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(destDir, 'basemind'))).mode & 0o777, 0o755);
    assert.equal((await stat(path.join(destDir, 'lib', 'libheif.so.1'))).mode & 0o777, 0o755);
    assert.equal((await stat(path.join(destDir, 'LICENSE'))).mode & 0o777, 0o644);
    assert.equal((await stat(path.join(destDir, 'licenses'))).mode & 0o777, 0o755);
  }
});

test('zip whole archive: root DLLs, an empty lib/ directory entry and licences', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind-x86_64-pc-windows-msvc.zip');
  const destDir = path.join(dir, 'out');
  await writeFile(
    archive,
    buildZip([
      { name: 'basemind.exe', data: BINARY },
      { name: 'heif.dll', data: RELEASE_DLL },
      { name: 'libde265.dll', data: SECOND_DLL },
      { name: 'lib/', data: EMPTY },
      { name: 'licenses/', data: EMPTY },
      { name: 'licenses/heif.dll.txt', data: ATTRIBUTIONS },
      { name: 'LICENSE', data: RELEASE_LICENSE },
    ]),
  );

  const result = await extractArchive({ archive, kind: 'zip', destDir });

  assert.deepEqual(
    result.files,
    expectedFiles([
      { path: 'LICENSE', data: RELEASE_LICENSE },
      { path: 'basemind.exe', data: BINARY },
      { path: 'heif.dll', data: RELEASE_DLL },
      { path: 'libde265.dll', data: SECOND_DLL },
      { path: 'licenses/heif.dll.txt', data: ATTRIBUTIONS },
    ]),
  );
  assert.equal((await stat(path.join(destDir, 'lib'))).isDirectory(), true, 'the empty lib/ entry is created');
  assert.equal((await stat(path.join(destDir, 'licenses'))).isDirectory(), true);
  assert.deepEqual((await readdir(path.join(destDir, 'lib'))), []);
  assert.deepEqual(await readFile(path.join(destDir, 'heif.dll')), RELEASE_DLL);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(destDir, 'basemind.exe'))).mode & 0o777, 0o755);
    assert.equal((await stat(path.join(destDir, 'LICENSE'))).mode & 0o777, 0o755);
  }
});

test('whole archive: a nested .. escape is refused and nothing is written outside', async (t) => {
  const dir = await withTempDir(t);
  const destDir = path.join(dir, 'nested', 'out');
  const tarArchive = path.join(dir, 'escape.tar.gz');
  await writeFile(tarArchive, tarGz([{ name: './licenses/../../evil.txt', data: BINARY }]));

  await expectFailure(extractArchive({ archive: tarArchive, kind: 'tar.gz', destDir }), 'path-traversal');
  assert.equal(existsSync(path.join(dir, 'evil.txt')), false);
  assert.equal(existsSync(path.join(dir, 'nested', 'evil.txt')), false);
  assert.deepEqual(await readdir(destDir), [], 'the destination holds no accepted file');

  const zipArchive = path.join(dir, 'escape.zip');
  await writeFile(zipArchive, buildZip([{ name: 'lib/../../../evil.txt', data: BINARY }]));
  await expectFailure(extractArchive({ archive: zipArchive, kind: 'zip', destDir }), 'path-traversal');
  assert.equal(existsSync(path.join(dir, 'evil.txt')), false);

  const uncArchive = path.join(dir, 'unc.tar.gz');
  await writeFile(uncArchive, tarGz([{ name: '\\\\server\\share\\evil.txt', data: BINARY }]));
  await expectFailure(extractArchive({ archive: uncArchive, kind: 'tar.gz', destDir }), 'path-traversal');
});

test('whole archive: duplicate entry names are refused', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'duplicate.tar.gz');
  await writeFile(
    archive,
    tarGz([
      { name: './lib/libheif.so.1', data: RELEASE_SHARED_OBJECT },
      { name: './lib/libheif.so.1', data: RELEASE_SHARED_OBJECT },
    ]),
  );

  await expectFailure(extractArchive({ archive, kind: 'tar.gz', destDir: path.join(dir, 'out') }), 'duplicate-entry');
});

test('whole archive: case-variant duplicates are refused on Windows and kept on POSIX', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'case.zip');
  const destDir = path.join(dir, 'out');
  await writeFile(
    archive,
    buildZip([
      { name: 'LICENSE', data: RELEASE_LICENSE },
      { name: 'license', data: ATTRIBUTIONS },
    ]),
  );

  if (process.platform === 'win32') {
    await expectFailure(extractArchive({ archive, kind: 'zip', destDir }), 'duplicate-entry');
    return;
  }
  const result = await extractArchive({ archive, kind: 'zip', destDir });
  assert.deepEqual(result.files.map((file) => file.path), ['LICENSE', 'license']);
});

test('whole archive: symlink, hardlink and device entries are refused', async (t) => {
  const dir = await withTempDir(t);
  for (const [name, type, code] of [
    ['evil-link', '2', 'link-entry'],
    ['hard', '1', 'link-entry'],
    ['fifo', '6', 'unsupported-entry-type'],
  ]) {
    const archive = path.join(dir, 'entry-' + name + '.tar.gz');
    await writeFile(
      archive,
      tarGz([
        { name: './basemind', data: BINARY },
        { name: './' + name, type },
      ]),
    );
    const destDir = path.join(dir, 'out-' + name);
    await expectFailure(extractArchive({ archive, kind: 'tar.gz', destDir }), code);
  }

  const zipArchive = path.join(dir, 'symlink.zip');
  await writeFile(
    zipArchive,
    buildZip([
      { name: 'basemind.exe', data: BINARY },
      { name: 'evil-link', data: Buffer.from('/etc/passwd'), externalAttrs: 0o120777 << 16 },
    ]),
  );
  await expectFailure(extractArchive({ archive: zipArchive, kind: 'zip', destDir: path.join(dir, 'out-link') }), 'link-entry');
});

test('whole archive: entry, entry-count and total limits are enforced', async (t) => {
  const dir = await withTempDir(t);
  const totalEntries = [
    { name: './basemind', data: BINARY },
    { name: './LICENSE', data: RELEASE_LICENSE },
  ];
  const archive = path.join(dir, 'limits.tar.gz');
  await writeFile(archive, tarGz(totalEntries));

  await expectFailure(
    extractArchive({ archive, kind: 'tar.gz', destDir: path.join(dir, 'out-entry'), limits: { maxEntryBytes: 8 } }),
    'too-large',
  );
  await expectFailure(
    extractArchive({
      archive,
      kind: 'tar.gz',
      destDir: path.join(dir, 'out-total'),
      limits: { maxTotalBytes: BINARY.length + RELEASE_LICENSE.length - 1 },
    }),
    'too-large',
  );
  await expectFailure(
    extractArchive({ archive, kind: 'tar.gz', destDir: path.join(dir, 'out-count'), limits: { maxEntries: 1 } }),
    'too-many-entries',
  );

  const zipArchive = path.join(dir, 'limits.zip');
  await writeFile(
    zipArchive,
    buildZip([
      { name: 'a.dll', data: RELEASE_DLL },
      { name: 'b.dll', data: SECOND_DLL },
      { name: 'c.dll', data: BINARY },
    ]),
  );
  await expectFailure(
    extractArchive({ archive: zipArchive, kind: 'zip', destDir: path.join(dir, 'out-zip-count'), limits: { maxEntries: 2 } }),
    'too-many-entries',
  );
});

test('whole archive: a mid-tree failure rejects and the caller discards the destination', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'damaged.tar.gz');
  const destDir = path.join(dir, 'out');
  const goodHeader = tarHeader({ name: 'LICENSE', size: RELEASE_LICENSE.length });
  const badHeader = tarHeader({ name: 'basemind', size: BINARY.length });
  badHeader.write('0000000\0', 148, 8, 'ascii');
  const pad = (512 - (RELEASE_LICENSE.length % 512)) % 512;
  await writeFile(
    archive,
    zlib.gzipSync(
      Buffer.concat([goodHeader, RELEASE_LICENSE, Buffer.alloc(pad), badHeader, Buffer.alloc(512, 0x41), Buffer.alloc(1024)]),
    ),
  );

  await expectFailure(extractArchive({ archive, kind: 'tar.gz', destDir }), 'malformed');
  // The caller owns cleanup: the supported contract is to delete the whole staging tree
  // and never treat a partial destination as an installed archive.
  await rm(destDir, { recursive: true, force: true });
  assert.equal(existsSync(destDir), false);
});

test('extractSingleFile still writes only the binary from a complete release tree', async (t) => {
  const dir = await withTempDir(t);
  const archive = path.join(dir, 'basemind-x86_64-unknown-linux-gnu.tar.gz');
  const dest = path.join(dir, 'basemind');
  await writeFile(
    archive,
    tarGz([
      { name: './', type: '5' },
      { name: './LICENSE', data: RELEASE_LICENSE },
      { name: './lib/', type: '5' },
      { name: './lib/libheif.so.1', data: RELEASE_SHARED_OBJECT },
      { name: './basemind', data: BINARY },
      { name: './licenses/', type: '5' },
      { name: './licenses/heif.txt', data: ATTRIBUTIONS },
    ]),
  );

  const result = await extractSingleFile({ archive, kind: 'tar.gz', entryPath: 'basemind', destFile: dest });

  assert.deepEqual(result, { bytes: BINARY.length });
  assert.deepEqual(await readFile(dest), BINARY);
  assert.deepEqual((await readdir(dir)).sort(), ['basemind', 'basemind-x86_64-unknown-linux-gnu.tar.gz']);
});

