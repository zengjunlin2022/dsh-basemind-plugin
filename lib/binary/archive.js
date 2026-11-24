/**
 * Extract exactly one executable out of an official BaseMind release archive.
 *
 * Archive entry names are never used as filesystem paths: the caller supplies the only
 * path ever written (`destFile`), and the entry name is only ever compared. Both parsers
 * walk the whole archive (not only up to the target) so a link, a traversal name, an
 * encrypted entry or an oversized member anywhere rejects the archive before anything
 * is written.
 *
 * tar.gz: gunzip stream -> 512-byte block parser (ustar prefix supported); only regular
 * files (typeflag 0/NUL) are extractable, directories are skipped, pax/gnu long-name
 * headers are skipped without being applied, and every link/device/fifo entry is
 * rejected. A leading `./` is stripped before the target name is compared, because the
 * upstream release script packs with `tar czf ... -C "$STAGING" .`.
 * zip: EOCD scan -> central directory -> local header -> inflateRaw (deflate)
 * or a stored copy; zip64 and encrypted archives fail with a clear code.
 *
 * @module dsh-basemind-plugin/lib/binary/archive
 */

import { createReadStream } from 'node:fs';
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, inflateRawSync } from 'node:zlib';

/** Decompressed bytes one entry may claim. */
const DEFAULT_MAX_ENTRY_BYTES = 400 * 1024 * 1024;
/** Headers one archive may contain. */
const DEFAULT_MAX_ENTRIES = 1000;
/** Decompressed bytes one archive may claim in total. */
const DEFAULT_MAX_TOTAL_BYTES = 400 * 1024 * 1024;

const TAR_BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK);

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP_EOCD_MIN = 22;
const ZIP_MAX_COMMENT = 65535;
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;
const ZIP_FLAG_ENCRYPTED = 0x1;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_S_IFMT = 0o170000;
const ZIP_S_IFLNK = 0o120000;

/** Header types that carry metadata we intentionally do not apply. */
const TAR_METADATA_TYPES = new Set(['x', 'g', 'L', 'K']);

/**
 * A managed-binary archive failure.
 *
 * Codes: `bad-kind`, `bad-entry`, `io`, `malformed`, `bad-gzip`, `truncated-archive`,
 * `unsupported-entry-type`, `link-entry`, `unsupported-compression`, `encrypted`,
 * `zip64`, `path-traversal`, `too-many-entries`, `too-large`, `size-mismatch`,
 * `missing-entry`, `duplicate-entry`.
 */
export class ArchiveError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const DEFAULT_FS = { open, readFile, unlink, writeFile };

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Wrap a low-level failure as an {@link ArchiveError}.
 * @param {unknown} error
 * @param {{ what?: string }} [context]
 * @returns {ArchiveError}
 */
function asArchiveError(error, context = {}) {
  if (error instanceof ArchiveError) return error;
  const code = /** @type {any} */ (error)?.code;
  const what = context.what ?? 'the archive';
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOSPC') {
    return new ArchiveError('io', 'could not read ' + what + ': ' + errorMessage(error), { cause: error });
  }
  if (typeof code === 'string' && code.startsWith('Z_')) {
    return new ArchiveError('bad-gzip', what + ' is not a valid gzip stream: ' + errorMessage(error), { cause: error });
  }
  return new ArchiveError('malformed', what + ' could not be parsed: ' + errorMessage(error), { cause: error });
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.trunc(number);
}

/**
 * @param {{ maxEntryBytes?: number, maxEntries?: number, maxTotalBytes?: number }|undefined} limits
 */
function boundLimits(limits) {
  const given = limits !== undefined && limits !== null && typeof limits === 'object' ? limits : {};
  return {
    maxEntryBytes: positiveInteger(given.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES),
    maxEntries: positiveInteger(given.maxEntries, DEFAULT_MAX_ENTRIES),
    maxTotalBytes: positiveInteger(given.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
  };
}

/**
 * Reject absolute and parent-escaping entry names. Archives are searched, not unpacked,
 * but a traversal name is a strong signal that the file is not a genuine release asset.
 * @param {string} name
 * @param {string} kind
 */
function assertSafeName(name, kind) {
  const normalized = String(name).replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw new ArchiveError('path-traversal', kind + ' entry has an absolute path: ' + JSON.stringify(name));
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new ArchiveError('path-traversal', kind + ' entry has a drive-absolute path: ' + JSON.stringify(name));
  }
  if (normalized.split('/').includes('..')) {
    throw new ArchiveError('path-traversal', kind + ' entry escapes the archive root: ' + JSON.stringify(name));
  }
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isZeroBlock(buffer) {
  if (buffer.length === 0) return true;
  if (buffer.length === TAR_BLOCK && buffer.equals(ZERO_BLOCK)) return true;
  return buffer.every((value) => value === 0);
}

/**
 * @param {Buffer} block
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function readTarString(block, offset, length) {
  const end = Math.min(block.length, offset + length);
  let stop = offset;
  while (stop < end && block[stop] !== 0) stop += 1;
  return block.toString('utf8', offset, stop).trim();
}

/**
 * Read a tar numeric field: octal text, or GNU base-256 for large values.
 * @param {Buffer} block
 * @param {number} offset
 * @param {number} length
 * @returns {number}
 */
function readTarNumber(block, offset, length) {
  if ((block[offset] & 0x80) !== 0) {
    let value = 0;
    for (let index = offset + 1; index < offset + length; index += 1) value = value * 256 + block[index];
    return value;
  }
  const text = readTarString(block, offset, length);
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new ArchiveError('malformed', 'tar header has an unreadable numeric field: ' + JSON.stringify(text));
  }
  return value;
}

/**
 * @param {Buffer} block
 */
function verifyTarChecksum(block) {
  const stored = readTarNumber(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (sum !== stored) {
    throw new ArchiveError(
      'malformed',
      'tar header checksum mismatch (' + stored + ' != ' + sum + '); the archive is corrupt or not a tar file',
    );
  }
}

/**
 * Strip the `./` prefix GNU tar writes for `tar czf ... -C DIR .`. Entry names are only
 * ever compared, never used as paths, so normalizing here cannot widen what is written.
 * @param {string} name
 * @returns {string}
 */
function normalizeTarEntryName(name) {
  return name.replace(/^\.\//, '');
}

/**
 * @param {Buffer} block
 * @returns {{ name: string, size: number, typeflag: string }}
 */
function parseTarHeader(block) {
  verifyTarChecksum(block);
  const name = readTarString(block, 0, 100);
  const size = readTarNumber(block, 124, 12);
  const typeflag = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
  const magic = readTarString(block, 257, 6);
  const prefix = magic.startsWith('ustar') ? readTarString(block, 345, 155) : '';
  const fullName = prefix === '' ? name : prefix + '/' + name;
  return { name: fullName, size, typeflag };
}

/**
 * Yield the decompressed tar stream as 512-byte blocks; `state.remainder` receives the
 * trailing partial block (if the stream does not end on a block boundary).
 * @param {AsyncIterable<Buffer>} stream
 * @param {{ remainder: Buffer }} state
 */
async function* tarBlocks(stream, state) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
    while (pending.length >= TAR_BLOCK) {
      yield pending.subarray(0, TAR_BLOCK);
      pending = pending.subarray(TAR_BLOCK);
    }
  }
  state.remainder = pending;
}

/**
 * @param {{ open: Function }} fs
 * @param {string} destFile
 */
async function openTarget(fs, destFile) {
  try {
    return await fs.open(destFile, 'w');
  } catch (error) {
    throw new ArchiveError('io', 'could not open ' + destFile + ' for writing: ' + errorMessage(error), {
      cause: error,
    });
  }
}

/**
 * @param {any} handle
 * @param {Buffer} chunk
 * @param {string} destFile
 */
async function writeChunk(handle, chunk, destFile) {
  try {
    await handle.write(chunk);
  } catch (error) {
    throw new ArchiveError('io', 'could not write ' + destFile + ': ' + errorMessage(error), { cause: error });
  }
}

/**
 * Best-effort removal of a destination this call created; a partial binary must never
 * survive a failed extraction for a later probe to pick up.
 * @param {{ unlink?: Function }} fs
 * @param {string} destFile
 */
async function discardFile(fs, destFile) {
  if (typeof fs?.unlink !== 'function') return;
  try {
    await fs.unlink(destFile);
  } catch {
    // The destination was never created.
  }
}

/**
 * @param {{ archive: string|Buffer, entry: string, destFile: string, bounds: any, fs: any }} params
 */
async function extractTarGz({ archive, entry, destFile, bounds, fs }) {
  const source =
    typeof archive === 'string'
      ? createReadStream(archive)
      : Buffer.isBuffer(archive) || archive instanceof Uint8Array
        ? Readable.from([Buffer.from(archive)])
        : undefined;
  if (source === undefined) throw new ArchiveError('io', 'archive must be a file path or a Buffer');

  const gunzip = createGunzip();
  const drained = pipeline(source, gunzip).then(
    () => undefined,
    (error) => error,
  );

  const state = { remainder: Buffer.alloc(0) };
  let entries = 0;
  let declaredTotal = 0;
  let consumed = 0;
  let remaining = 0;
  let writing = false;
  let found = false;
  let bytes = 0;
  let created = false;
  /** @type {any} */
  let handle;

  try {
    for await (const block of tarBlocks(gunzip, state)) {
      consumed += TAR_BLOCK;
      if (consumed > bounds.maxTotalBytes + TAR_BLOCK) {
        throw new ArchiveError('too-large', 'the tar stream exceeds the ' + bounds.maxTotalBytes + ' byte limit');
      }

      if (remaining > 0) {
        const take = Math.min(TAR_BLOCK, remaining);
        if (writing) {
          const slice = block.subarray(0, take);
          await writeChunk(handle, slice, destFile);
          bytes += slice.length;
        }
        remaining -= take;
        // The target entry is done; the next block is a header again, not more payload.
        if (remaining === 0) writing = false;
        continue;
      }

      if (isZeroBlock(block)) continue;

      const header = parseTarHeader(block);
      entries += 1;
      if (entries > bounds.maxEntries) {
        throw new ArchiveError('too-many-entries', 'the archive has more than ' + bounds.maxEntries + ' entries');
      }
      assertSafeName(header.name, 'tar');

      if (header.typeflag === '0') {
        if (header.size > bounds.maxEntryBytes) {
          throw new ArchiveError(
            'too-large',
            'tar entry ' + JSON.stringify(header.name) + ' declares ' + header.size + ' bytes (limit ' + bounds.maxEntryBytes + ')',
          );
        }
        declaredTotal += header.size;
        if (declaredTotal > bounds.maxTotalBytes) {
          throw new ArchiveError('too-large', 'the tar archive expands past the ' + bounds.maxTotalBytes + ' byte limit');
        }
        if (normalizeTarEntryName(header.name) === entry) {
          if (found) throw new ArchiveError('duplicate-entry', 'the archive contains ' + JSON.stringify(entry) + ' twice');
          found = true;
          remaining = header.size;
          writing = remaining > 0;
          handle = await openTarget(fs, destFile);
          created = true;
          continue;
        }
        remaining = header.size;
        continue;
      }

      if (header.typeflag === '5') {
        remaining = header.size;
        continue;
      }
      if (TAR_METADATA_TYPES.has(header.typeflag)) {
        if (header.size > bounds.maxTotalBytes) {
          throw new ArchiveError('too-large', 'a tar metadata header declares ' + header.size + ' bytes');
        }
        remaining = header.size;
        continue;
      }
      if (header.typeflag === '1' || header.typeflag === '2') {
        throw new ArchiveError(
          'link-entry',
          'tar archive contains a ' + (header.typeflag === '1' ? 'hardlink' : 'symlink') + ' entry: ' + JSON.stringify(header.name),
        );
      }
      throw new ArchiveError(
        'unsupported-entry-type',
        'tar entry ' + JSON.stringify(header.name) + ' has unsupported type ' + JSON.stringify(header.typeflag),
      );
    }

    const streamFailure = await drained;
    if (streamFailure instanceof Error) throw asArchiveError(streamFailure, { what: 'the tar.gz archive' });

    if (state.remainder.length > 0 && !isZeroBlock(state.remainder)) {
      throw new ArchiveError('malformed', 'the tar stream ends with a partial block');
    }
    if (remaining > 0) {
      throw new ArchiveError('truncated-archive', 'the tar stream ends before the last entry is complete');
    }
    if (!found) {
      throw new ArchiveError('missing-entry', 'the archive has no root-level ' + JSON.stringify(entry) + ' entry');
    }

    return { bytes };
  } catch (error) {
    if (created) await discardFile(fs, destFile);
    throw asArchiveError(error, { what: 'the tar.gz archive' });
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The destination is being discarded or was already closed.
      }
    }
    try {
      gunzip.destroy();
    } catch {
      // Already closed.
    }
    await drained;
  }
}

/**
 * @param {Buffer} buffer
 * @returns {{ entries: number, centralOffset: number, centralSize: number }}
 */
function findEocd(buffer) {
  const first = Math.max(0, buffer.length - ZIP_EOCD_MIN - ZIP_MAX_COMMENT);
  for (let offset = buffer.length - ZIP_EOCD_MIN; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD) continue;
    const entries = buffer.readUInt16LE(offset + 10);
    const centralSize = buffer.readUInt32LE(offset + 12);
    const centralOffset = buffer.readUInt32LE(offset + 16);
    if (entries === ZIP64_16 || centralSize === ZIP64_32 || centralOffset === ZIP64_32) {
      throw new ArchiveError('zip64', 'zip64 archives are not supported; BaseMind release assets use plain zip');
    }
    if (centralOffset + centralSize > buffer.length) {
      throw new ArchiveError('truncated-archive', 'the zip central directory lies outside the file');
    }
    return { entries, centralOffset, centralSize };
  }
  throw new ArchiveError('malformed', 'no zip end-of-central-directory record was found (truncated archive)');
}

/**
 * @param {{ archive: string|Buffer, entry: string, destFile: string, bounds: any, fs: any }} params
 */
async function extractZip({ archive, entry, destFile, bounds, fs }) {
  let buffer = archive;
  if (typeof buffer === 'string') {
    try {
      buffer = await fs.readFile(buffer);
    } catch (error) {
      throw asArchiveError(error, { what: 'the zip archive' });
    }
  }
  if (buffer instanceof Uint8Array && !Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (!Buffer.isBuffer(buffer)) throw new ArchiveError('io', 'archive must be a file path or a Buffer');
  if (buffer.length < ZIP_EOCD_MIN) {
    throw new ArchiveError('malformed', 'the zip archive is too short to be a zip file');
  }

  const eocd = findEocd(buffer);
  const end = eocd.centralOffset + eocd.centralSize;

  let offset = eocd.centralOffset;
  let seen = 0;
  let declaredTotal = 0;
  /** @type {{ name: string, method: number, compSize: number, uncompSize: number, localOffset: number }|undefined} */
  let found;

  while (offset + 46 <= end) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL) {
      throw new ArchiveError('malformed', 'bad zip central directory header at offset ' + offset);
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const uncompSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    seen += 1;
    if (seen > bounds.maxEntries) {
      throw new ArchiveError('too-many-entries', 'the archive has more than ' + bounds.maxEntries + ' entries');
    }
    if (compSize === ZIP64_32 || uncompSize === ZIP64_32 || localOffset === ZIP64_32) {
      throw new ArchiveError('zip64', 'zip64 archives are not supported; BaseMind release assets use plain zip');
    }
    if ((flags & ZIP_FLAG_ENCRYPTED) !== 0) {
      throw new ArchiveError('encrypted', 'zip entry ' + JSON.stringify(name) + ' is encrypted');
    }
    assertSafeName(name, 'zip');

    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & ZIP_S_IFMT) === ZIP_S_IFLNK) {
      throw new ArchiveError('link-entry', 'zip archive contains a symlink entry: ' + JSON.stringify(name));
    }

    const isDirectory = name.endsWith('/');
    if (!isDirectory) {
      if (uncompSize > bounds.maxEntryBytes) {
        throw new ArchiveError(
          'too-large',
          'zip entry ' + JSON.stringify(name) + ' declares ' + uncompSize + ' bytes (limit ' + bounds.maxEntryBytes + ')',
        );
      }
      declaredTotal += uncompSize;
      if (declaredTotal > bounds.maxTotalBytes) {
        throw new ArchiveError('too-large', 'the zip archive expands past the ' + bounds.maxTotalBytes + ' byte limit');
      }
      if (name.replace(/\\/g, '/').replace(/^\.\//, '') === entry) {
        if (found !== undefined) {
          throw new ArchiveError('duplicate-entry', 'the archive contains ' + JSON.stringify(entry) + ' twice');
        }
        found = { name, method, compSize, uncompSize, localOffset };
      }
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (found === undefined) {
    throw new ArchiveError('missing-entry', 'the archive has no root-level ' + JSON.stringify(entry) + ' entry');
  }

  if (found.localOffset + 30 > buffer.length || buffer.readUInt32LE(found.localOffset) !== ZIP_LOCAL) {
    throw new ArchiveError('malformed', 'bad zip local file header for ' + JSON.stringify(found.name));
  }
  const localNameLength = buffer.readUInt16LE(found.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(found.localOffset + 28);
  const dataStart = found.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + found.compSize;
  if (dataEnd > buffer.length) {
    throw new ArchiveError('truncated-archive', 'zip entry data lies outside the file');
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  let data;
  if (found.method === ZIP_METHOD_STORED) {
    data = compressed;
  } else if (found.method === ZIP_METHOD_DEFLATE) {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, found.uncompSize) });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ArchiveError('too-large', 'zip entry ' + JSON.stringify(found.name) + ' inflated past its declared size');
      }
      throw new ArchiveError(
        'malformed',
        'could not inflate zip entry ' + JSON.stringify(found.name) + ': ' + errorMessage(error),
        { cause: error },
      );
    }
  } else {
    throw new ArchiveError(
      'unsupported-compression',
      'zip method ' + found.method + ' is not supported (stored and deflate only)',
    );
  }

  if (data.length !== found.uncompSize) {
    throw new ArchiveError(
      'size-mismatch',
      'zip entry ' + JSON.stringify(found.name) + ' produced ' + data.length + ' bytes but declares ' + found.uncompSize,
    );
  }

  try {
    await fs.writeFile(destFile, data);
  } catch (error) {
    await discardFile(fs, destFile);
    throw new ArchiveError('io', 'could not write ' + destFile + ': ' + errorMessage(error), { cause: error });
  }

  return { bytes: data.length };
}

/**
 * Extract exactly one root-level entry to `destFile`.
 *
 * @param {{ archive?: string|Buffer, kind?: 'tar.gz'|'zip', entryPath?: string, destFile?: string,
 *           limits?: { maxEntryBytes?: number, maxEntries?: number, maxTotalBytes?: number },
 *           fs?: { open: Function, readFile: Function, writeFile: Function } }} [params]
 * @returns {Promise<{ bytes: number }>}
 */
export async function extractSingleFile({
  archive,
  kind,
  entryPath,
  destFile,
  limits,
  fs = DEFAULT_FS,
} = {}) {
  if (kind !== 'tar.gz' && kind !== 'zip') {
    throw new ArchiveError(
      'bad-kind',
      'unsupported archive kind ' + JSON.stringify(String(kind)) + "; expected 'tar.gz' or 'zip'",
    );
  }
  if (archive === undefined || archive === null || (typeof archive !== 'string' && !Buffer.isBuffer(archive) && !(archive instanceof Uint8Array))) {
    throw new ArchiveError('io', 'archive must be a file path or a Buffer');
  }

  const entry = typeof entryPath === 'string' ? entryPath.replace(/\\/g, '/').replace(/^\.\//, '') : '';
  if (entry === '' || entry.includes('/')) {
    throw new ArchiveError(
      'bad-entry',
      'entryPath must be a single root-level file name, got ' + JSON.stringify(String(entryPath)),
    );
  }
  if (typeof destFile !== 'string' || destFile === '') {
    throw new ArchiveError('io', 'destFile is required');
  }

  const bounds = boundLimits(limits);
  if (kind === 'tar.gz') return await extractTarGz({ archive, entry, destFile, bounds, fs });
  return await extractZip({ archive, entry, destFile, bounds, fs });
}
