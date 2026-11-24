/**
 * Read official BaseMind release archives with pure Node built-ins.
 *
 * `extractSingleFile()` extracts exactly one root-level executable and keeps its
 * original contract: the caller supplies the only path ever written (`destFile`), and
 * the entry name is only ever compared. `extractArchive()` writes the complete release
 * tree (the binary, the bundled DLL/SO/DYLIB files and the licence files) while using
 * the same parsers and protections.
 *
 * Both parsers walk the whole archive (not only up to a target) so a link, a traversal
 * name, an encrypted entry or an oversized member anywhere rejects the archive before
 * anything accepted is returned.
 *
 * tar.gz: gunzip stream -> 512-byte block parser (ustar prefix supported); regular
 * files (typeflag 0/NUL) and directories (typeflag 5) are handled, pax/gnu long-name
 * headers are skipped without being applied, and every link/device/fifo entry is
 * rejected. A leading `./` is stripped, because the upstream release script packs with
 * `tar czf ... -C "$STAGING" .`. Regular-file modes are applied on POSIX only
 * (0o755 when the header carries an execute bit, 0o644 otherwise).
 * zip: EOCD scan -> central directory -> local header -> inflateRaw (deflate)
 * or a stored copy; zip64 and encrypted archives fail with a clear code. The official
 * Windows archive carries no Unix mode, so extracted files default to 0o755 on POSIX.
 *
 * Destination contract: entry names only ever produce a path that must resolve inside
 * the destination directory (defence in depth beyond the name checks). On any error a
 * partially written tree may be left behind, so the caller of `extractArchive()` must
 * delete the whole destination directory; the function never reports such a tree as a
 * result. `extractSingleFile()` cleans its own `destFile`.
 *
 * @module dsh-basemind-plugin/lib/binary/archive
 */

import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

/** File modes applied on POSIX; zip entries never carry a trustworthy mode. */
const MODE_FILE = 0o644;
const MODE_EXECUTABLE = 0o755;
const MODE_DIRECTORY = 0o755;

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

const DEFAULT_FS = { chmod, mkdir, open, readFile, unlink, writeFile };

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
 * Reject absolute and parent-escaping entry names. `\\server\share` normalizes to
 * `//server/share`, so the absolute-path check rejects a UNC name too.
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
 * Normalize one archive entry name into a relative POSIX-style path: backslashes
 * become `/`, one leading `./` and any trailing `/` are stripped.
 * @param {string} name
 * @returns {string}
 */
function normalizeEntryPath(name) {
  let entry = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
  while (entry.endsWith('/')) entry = entry.slice(0, -1);
  const collapsed = path.posix.normalize(entry);
  return collapsed === '.' || collapsed === './' ? '' : collapsed;
}

/**
 * Compare key used for duplicate detection: case-insensitive on Windows.
 * @param {string} entry
 * @returns {string}
 */
function duplicateKey(entry) {
  return process.platform === 'win32' ? entry.toLowerCase() : entry;
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
 * @returns {{ name: string, size: number, typeflag: string, mode: number }}
 */
function parseTarHeader(block) {
  verifyTarChecksum(block);
  const name = readTarString(block, 0, 100);
  const size = readTarNumber(block, 124, 12);
  const mode = readTarNumber(block, 100, 8);
  const typeflag = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
  const magic = readTarString(block, 257, 6);
  const prefix = magic.startsWith('ustar') ? readTarString(block, 345, 155) : '';
  const fullName = prefix === '' ? name : prefix + '/' + name;
  return { name: fullName, size, typeflag, mode };
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
 * @typedef {{
 *   write(chunk: Buffer): Promise<void>,
 *   finish(): Promise<void>,
 *   abort(): Promise<void>,
 * }} PayloadWriter
 */

/**
 * @typedef {{
 *   regular(params: { name: string, size: number, mode: number|undefined }): Promise<PayloadWriter|undefined>,
 *   directory?(name: string): Promise<void>,
 *   result(): Promise<any>,
 *   abort?(): Promise<void>,
 * }} ArchiveSink
 */

/**
 * Sink that writes exactly one root-level regular entry to `destFile`.
 * @param {{ entry: string, destFile: string, fs: any, matches: (name: string) => boolean }} params
 * @returns {ArchiveSink}
 */
function createSingleFileSink({ entry, destFile, fs, matches }) {
  let found = false;
  let created = false;
  let bytes = 0;

  return {
    async regular({ name, size }) {
      if (matches(name) !== true) return undefined;
      if (found) throw new ArchiveError('duplicate-entry', 'the archive contains ' + JSON.stringify(entry) + ' twice');
      found = true;
      const handle = await openTarget(fs, destFile);
      created = true;
      let closed = false;
      let written = 0;
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          await handle.close();
        } catch {
          // The destination is being discarded or was already closed.
        }
      };
      return {
        async write(chunk) {
          await writeChunk(handle, chunk, destFile);
          written += chunk.length;
          bytes += chunk.length;
        },
        async finish() {
          await close();
          if (written !== size) {
            throw new ArchiveError(
              'size-mismatch',
              'tar entry ' + JSON.stringify(entry) + ' produced ' + written + ' bytes but declares ' + size,
            );
          }
        },
        async abort() {
          await close();
        },
      };
    },

    async result() {
      if (!found) {
        throw new ArchiveError('missing-entry', 'the archive has no root-level ' + JSON.stringify(entry) + ' entry');
      }
      return { bytes };
    },

    async abort() {
      if (created) await discardFile(fs, destFile);
    },
  };
}

/**
 * Sink that writes the complete archive tree under `destDir`. The caller owns cleanup:
 * a failure may leave a partial tree, which the caller must delete with its staging
 * directory.
 * @param {{ destDir: string, fs: any }} params
 * @returns {ArchiveSink & { result(): Promise<{ files: { path: string, size: number }[], bytes: number }> }}
 */
function createTreeSink({ destDir, fs }) {
  const root = path.resolve(destDir);
  const posix = process.platform !== 'win32';
  /** @type {{ path: string, size: number }[]} */
  const files = [];
  const seen = new Set();
  /** @type {(() => Promise<void>)|undefined} */
  let openClose;

  /**
   * Record one entry name and return its normalized relative path.
   * @param {string} name
   * @returns {string}
   */
  function record(name) {
    const entry = normalizeEntryPath(name);
    if (entry === '') return '';
    const key = duplicateKey(entry);
    if (seen.has(key)) {
      throw new ArchiveError('duplicate-entry', 'the archive contains ' + JSON.stringify(entry) + ' more than once');
    }
    seen.add(key);
    return entry;
  }

  /**
   * Resolve `entry` under the destination root and refuse anything that lands outside.
   * @param {string} entry
   * @returns {string}
   */
  function targetFor(entry) {
    const resolved = path.resolve(root, entry);
    if (resolved === root || !resolved.startsWith(root + path.sep)) {
      throw new ArchiveError(
        'path-traversal',
        'archive entry ' + JSON.stringify(entry) + ' resolves outside the destination directory',
      );
    }
    return resolved;
  }

  /**
   * @param {string} entry
   */
  async function makeDirectory(entry) {
    try {
      await fs.mkdir(targetFor(entry), { recursive: true, mode: MODE_DIRECTORY });
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      throw new ArchiveError('io', 'could not create the directory for ' + JSON.stringify(entry) + ': ' + errorMessage(error), {
        cause: error,
      });
    }
  }

  return {
    async directory(name) {
      const entry = record(name);
      if (entry === '') return;
      await makeDirectory(entry);
    },

    async regular({ name, size, mode }) {
      const entry = record(name);
      if (entry === '') {
        throw new ArchiveError('malformed', 'archive entry ' + JSON.stringify(name) + ' is a file without a name');
      }
      const target = targetFor(entry);
      let handle;
      try {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: MODE_DIRECTORY });
        handle = await fs.open(target, 'w');
      } catch (error) {
        if (error instanceof ArchiveError) throw error;
        throw new ArchiveError('io', 'could not open ' + target + ' for writing: ' + errorMessage(error), {
          cause: error,
        });
      }
      const fileMode = posix ? (mode === undefined || (mode & 0o111) !== 0 ? MODE_EXECUTABLE : MODE_FILE) : undefined;
      let closed = false;
      let count = 0;
      const close = async () => {
        openClose = undefined;
        if (closed) return;
        closed = true;
        try {
          await handle.close();
        } catch {
          // The caller discards the tree.
        }
      };
      openClose = close;
      return {
        async write(chunk) {
          try {
            await handle.write(chunk);
          } catch (error) {
            throw new ArchiveError('io', 'could not write ' + target + ': ' + errorMessage(error), { cause: error });
          }
          count += chunk.length;
        },
        async finish() {
          await close();
          if (count !== size) {
            throw new ArchiveError(
              'size-mismatch',
              'archive entry ' + JSON.stringify(entry) + ' produced ' + count + ' bytes but declares ' + size,
            );
          }
          if (fileMode !== undefined && typeof fs.chmod === 'function') {
            try {
              await fs.chmod(target, fileMode);
            } catch (error) {
              throw new ArchiveError('io', 'could not set the mode of ' + target + ': ' + errorMessage(error), {
                cause: error,
              });
            }
          }
          files.push({ path: entry, size: count });
        },
        async abort() {
          await close();
        },
      };
    },

    async result() {
      const sorted = files.slice().sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      let bytes = 0;
      for (const file of sorted) bytes += file.size;
      return { files: sorted, bytes };
    },

    async abort() {
      if (openClose !== undefined) await openClose();
    },
  };
}

/**
 * Walk a tar.gz archive once and hand every entry to `sink`.
 * @param {{ archive: string|Buffer, bounds: any, sink: ArchiveSink }} params
 * @returns {Promise<any>} the sink result.
 */
async function walkTarGz({ archive, bounds, sink }) {
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
  /** @type {PayloadWriter|undefined} */
  let writer;

  try {
    for await (const block of tarBlocks(gunzip, state)) {
      consumed += TAR_BLOCK;
      if (consumed > bounds.maxTotalBytes + TAR_BLOCK) {
        throw new ArchiveError('too-large', 'the tar stream exceeds the ' + bounds.maxTotalBytes + ' byte limit');
      }

      if (remaining > 0) {
        const take = Math.min(TAR_BLOCK, remaining);
        if (writer !== undefined) await writer.write(block.subarray(0, take));
        remaining -= take;
        if (remaining === 0) {
          const finished = writer;
          writer = undefined;
          if (finished !== undefined) await finished.finish();
        }
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
        writer = await sink.regular({ name: header.name, size: header.size, mode: header.mode });
        remaining = header.size;
        if (remaining === 0) {
          const empty = writer;
          writer = undefined;
          if (empty !== undefined) await empty.finish();
        }
        continue;
      }

      if (header.typeflag === '5') {
        if (sink.directory !== undefined) await sink.directory(header.name);
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

    return await sink.result();
  } catch (error) {
    if (writer !== undefined) await writer.abort();
    await sink.abort?.();
    throw asArchiveError(error, { what: 'the tar.gz archive' });
  } finally {
    if (writer !== undefined) {
      try {
        await writer.abort();
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
 * @typedef {{
 *   name: string,
 *   method: number,
 *   compSize: number,
 *   uncompSize: number,
 *   localOffset: number,
 *   isDirectory: boolean,
 * }} ZipEntry
 */

/**
 * Read the zip archive into a Buffer, whichever form the caller used.
 * @param {string|Buffer} archive
 * @param {any} fs
 * @returns {Promise<Buffer>}
 */
async function readZipBuffer(archive, fs) {
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
  return buffer;
}

/**
 * Walk the central directory once: every protection is applied here, before a byte is
 * written, so an unsafe archive never produces a partial tree.
 *
 * @param {Buffer} buffer
 * @param {any} bounds
 * @param {{ entry?: string, rejectDuplicates?: boolean }} [options]
 * @returns {{ entries: ZipEntry[], found: ZipEntry|undefined }}
 */
function scanZipDirectory(buffer, bounds, options = {}) {
  const entry = options.entry;
  const rejectDuplicates = options.rejectDuplicates === true;
  const eocd = findEocd(buffer);
  const end = eocd.centralOffset + eocd.centralSize;

  let offset = eocd.centralOffset;
  let seen = 0;
  let declaredTotal = 0;
  /** @type {ZipEntry|undefined} */
  let found;
  /** @type {ZipEntry[]} */
  const entries = [];
  const names = new Set();

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
      const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '');
      if (entry !== undefined && normalized === entry) {
        if (found !== undefined) {
          throw new ArchiveError('duplicate-entry', 'the archive contains ' + JSON.stringify(entry) + ' twice');
        }
        found = { name, method, compSize, uncompSize, localOffset, isDirectory };
      }
    }

    if (rejectDuplicates) {
      const normalized = normalizeEntryPath(name);
      if (normalized !== '') {
        const key = duplicateKey(normalized);
        if (names.has(key)) {
          throw new ArchiveError('duplicate-entry', 'the archive contains ' + JSON.stringify(normalized) + ' more than once');
        }
        names.add(key);
      }
    }

    entries.push({ name, method, compSize, uncompSize, localOffset, isDirectory });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, found };
}

/**
 * Read and verify one zip entry's payload.
 * @param {Buffer} buffer
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
function readZipEntryData(buffer, entry) {
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== ZIP_LOCAL) {
    throw new ArchiveError('malformed', 'bad zip local file header for ' + JSON.stringify(entry.name));
  }
  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compSize;
  if (dataEnd > buffer.length) {
    throw new ArchiveError('truncated-archive', 'zip entry data lies outside the file');
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  let data;
  if (entry.method === ZIP_METHOD_STORED) {
    data = compressed;
  } else if (entry.method === ZIP_METHOD_DEFLATE) {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompSize) });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ArchiveError('too-large', 'zip entry ' + JSON.stringify(entry.name) + ' inflated past its declared size');
      }
      throw new ArchiveError(
        'malformed',
        'could not inflate zip entry ' + JSON.stringify(entry.name) + ': ' + errorMessage(error),
        { cause: error },
      );
    }
  } else {
    throw new ArchiveError(
      'unsupported-compression',
      'zip method ' + entry.method + ' is not supported (stored and deflate only)',
    );
  }

  if (data.length !== entry.uncompSize) {
    throw new ArchiveError(
      'size-mismatch',
      'zip entry ' + JSON.stringify(entry.name) + ' produced ' + data.length + ' bytes but declares ' + entry.uncompSize,
    );
  }
  return data;
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

  if (kind === 'tar.gz') {
    const sink = createSingleFileSink({
      entry,
      destFile,
      fs,
      matches: (name) => normalizeTarEntryName(name) === entry,
    });
    return await walkTarGz({ archive, bounds, sink });
  }

  const buffer = await readZipBuffer(archive, fs);
  const scan = scanZipDirectory(buffer, bounds, { entry });
  if (scan.found === undefined) {
    throw new ArchiveError('missing-entry', 'the archive has no root-level ' + JSON.stringify(entry) + ' entry');
  }
  const data = readZipEntryData(buffer, scan.found);

  try {
    await fs.writeFile(destFile, data);
  } catch (error) {
    await discardFile(fs, destFile);
    throw new ArchiveError('io', 'could not write ' + destFile + ': ' + errorMessage(error), { cause: error });
  }

  return { bytes: data.length };
}

/**
 * Extract the complete archive tree under `destDir`.
 *
 * The whole archive is walked with the same checks as `extractSingleFile()`: absolute,
 * drive-absolute, UNC and `..` names, duplicates (case-insensitive on Windows), links,
 * devices, encrypted entries, zip64, entry-count and size limits, header checksums and
 * per-entry declared sizes. In addition every destination path is resolved and must stay
 * inside `destDir` (defence in depth against ZIP Slip).
 *
 * Nested paths and directory entries are created (`lib/`, `licenses/`); a leading `./`
 * is stripped and `\` is treated as `/`. On POSIX, tar regular files become 0o755 when
 * the header carries an execute bit and 0o644 otherwise; zip entries (no trustworthy
 * mode from a Windows-built archive) default to 0o755. The archive's directory entries
 * are created 0o755. Windows keeps the modes it is given.
 *
 * On success the result is deterministic:
 * `{ files: [{ path, size }], bytes }`, files sorted by path with forward slashes.
 *
 * On any error this function rejects and no result is reported. A partially written
 * tree may remain, so the caller must delete the whole destination directory (the
 * managed-binary installer removes its staging directory). Open handles are always
 * closed. There is no cancellation input: an aborted caller discards the destination.
 *
 * @param {{ archive?: string|Buffer, kind?: 'tar.gz'|'zip', destDir?: string,
 *           limits?: { maxEntryBytes?: number, maxEntries?: number, maxTotalBytes?: number },
 *           fs?: { mkdir: Function, open: Function, readFile: Function, chmod?: Function } }} [params]
 * @returns {Promise<{ files: { path: string, size: number }[], bytes: number }>}
 */
export async function extractArchive({ archive, kind, destDir, limits, fs = DEFAULT_FS } = {}) {
  if (kind !== 'tar.gz' && kind !== 'zip') {
    throw new ArchiveError(
      'bad-kind',
      'unsupported archive kind ' + JSON.stringify(String(kind)) + "; expected 'tar.gz' or 'zip'",
    );
  }
  if (archive === undefined || archive === null || (typeof archive !== 'string' && !Buffer.isBuffer(archive) && !(archive instanceof Uint8Array))) {
    throw new ArchiveError('io', 'archive must be a file path or a Buffer');
  }
  if (typeof destDir !== 'string' || destDir === '') {
    throw new ArchiveError('io', 'destDir is required');
  }

  const bounds = boundLimits(limits);
  const sink = createTreeSink({ destDir, fs });

  try {
    await fs.mkdir(path.resolve(destDir), { recursive: true, mode: MODE_DIRECTORY });
  } catch (error) {
    throw new ArchiveError('io', 'could not create ' + destDir + ': ' + errorMessage(error), { cause: error });
  }

  if (kind === 'tar.gz') return await walkTarGz({ archive, bounds, sink });

  const buffer = await readZipBuffer(archive, fs);
  const scan = scanZipDirectory(buffer, bounds, { rejectDuplicates: true });

  /** @type {PayloadWriter|undefined} */
  let writer;
  try {
    for (const entry of scan.entries) {
      if (entry.isDirectory) {
        await sink.directory?.(entry.name);
        continue;
      }
      const data = readZipEntryData(buffer, entry);
      writer = await sink.regular({ name: entry.name, size: entry.uncompSize, mode: undefined });
      if (writer === undefined) continue;
      await writer.write(data);
      const finished = writer;
      writer = undefined;
      await finished.finish();
    }
    return await sink.result();
  } catch (error) {
    if (writer !== undefined) await writer.abort();
    await sink.abort?.();
    throw asArchiveError(error, { what: 'the zip archive' });
  } finally {
    if (writer !== undefined) {
      try {
        await writer.abort();
      } catch {
        // The caller discards the destination.
      }
    }
  }
}
