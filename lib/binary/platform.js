/**
 * Map a Node platform/arch pair onto the official BaseMind release asset for it.
 *
 * `lib/upstream.js` owns the asset table; this module only answers "which published
 * asset (if any) serves this machine" and never invents a triple or a URL. Unsupported
 * combinations (Intel macOS, Windows on ARM, BSD) resolve to `{ unsupported: true }`
 * with an actionable message instead of throwing, because the binary manager reports
 * that as a diagnostic and keeps the rest of the plugin working.
 *
 * @module dsh-basemind-plugin/lib/binary/platform
 */

import { UPSTREAM } from '../upstream.js';

/** Target keys that have an official release asset, in upstream order. */
export const SUPPORTED_TARGETS = Object.freeze(Object.keys(UPSTREAM.assets));

/**
 * Per-combination guidance for the platforms upstream does not publish. Anything
 * else falls back to the generic build-from-source sentence.
 */
const UNSUPPORTED_HINTS = Object.freeze({
  'darwin-x64':
    'official releases do not include an Intel macOS asset; run on Apple Silicon or build BaseMind from source ' +
    '(cargo build --release) and point config.command or BASEMIND_BIN at the result',
  'win32-arm64':
    'official releases do not include a Windows ARM64 asset; run the x64 build under emulation (use an x64 Node) ' +
    'or build BaseMind from source (cargo build --release) and point config.command or BASEMIND_BIN at the result',
  'freebsd-x64':
    'BaseMind publishes no BSD assets; build BaseMind from source (cargo build --release) and point ' +
    'config.command or BASEMIND_BIN at the result',
});

const GENERIC_HINT =
  'build BaseMind from source (cargo build --release) and point config.command or BASEMIND_BIN at the result';

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Build the diagnostic for an unsupported platform/arch pair.
 * @param {string} platform
 * @param {string} arch
 * @returns {string}
 */
function unsupportedReason(platform, arch) {
  const key = platform + '-' + arch;
  const hint = UNSUPPORTED_HINTS[key] ?? GENERIC_HINT;
  return (
    'no official BaseMind ' +
    UPSTREAM.version +
    ' asset for ' +
    key +
    '; supported targets are ' +
    SUPPORTED_TARGETS.join(', ') +
    '. ' +
    hint
  );
}

/**
 * Resolve the official release asset that serves a platform/arch pair.
 *
 * @param {{ platform?: NodeJS.Platform|string, arch?: string }} [params]
 * @returns {{ key: string, triple: string, ext: 'zip'|'tar.gz', binary: string }
 *           | { unsupported: true, reason: string }}
 */
export function resolveTarget(params = {}) {
  const { platform = process.platform, arch = process.arch } = params ?? {};
  const os = text(platform);
  const cpu = text(arch);

  if (os === '' || cpu === '') {
    return {
      unsupported: true,
      reason:
        'platform and arch must both be non-empty strings (got platform=' +
        JSON.stringify(String(platform)) +
        ', arch=' +
        JSON.stringify(String(arch)) +
        ')',
    };
  }

  // Node reports the Windows platform as 'win32'; release assets use 'windows'.
  const osKey = os === 'win32' ? 'windows' : os;
  const key = osKey + '-' + cpu;
  const asset = UPSTREAM.assets[key];
  if (asset === undefined) return { unsupported: true, reason: unsupportedReason(os, cpu) };

  return { key, triple: asset.triple, ext: asset.ext, binary: asset.binary };
}
