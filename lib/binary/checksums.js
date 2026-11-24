/**
 * Parse the `sha256sum` checksums file published with an official BaseMind release.
 *
 * Upstream ships `basemind_<version>_checksums.txt`; each line is either
 * `<sha256>  <asset name>` (text mode) or `<sha256> *<asset name>` (binary mode).
 * Anything else is ignored, so one malformed line can never become a wrong digest.
 *
 * @module dsh-basemind-plugin/lib/binary/checksums
 */

/** `<64 hex><whitespace><optional '*'>name`; names may contain spaces. */
const LINE = /^([0-9a-fA-F]{64})[ \t]+\*?(.+?)\s*$/;

/**
 * Parse a checksums file into a name -> lowercase sha256 map.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseChecksums(text) {
  const digests = new Map();
  if (typeof text !== 'string') return digests;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (match === null) continue;
    digests.set(match[2], match[1].toLowerCase());
  }

  return digests;
}

/**
 * The digest published for one asset name, if the file listed it.
 * @param {Map<string, string>} digests
 * @param {string} assetName
 * @returns {string|undefined}
 */
export function digestFor(digests, assetName) {
  if (!(digests instanceof Map)) return undefined;
  if (typeof assetName !== 'string' || assetName === '') return undefined;
  return digests.get(assetName);
}
