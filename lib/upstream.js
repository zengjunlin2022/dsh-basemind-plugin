/**
 * The single source of truth for the upstream BaseMind release this plugin is
 * built against. Everything version-dependent (download URLs, checksum file
 * name, skills provenance, test fixtures, CI pins) must read from here; nothing
 * may derive a BaseMind version from package.json.
 *
 * @module dsh-basemind-plugin/lib/upstream
 */

/** Frozen upstream release facts for the BaseMind version this plugin targets. */
export const UPSTREAM = Object.freeze({
  version: '0.34.0',
  tag: 'v0.34.0',
  commit: '8e7b149',
  repository: 'Goldziher/basemind',
  releaseBase: 'https://github.com/Goldziher/basemind/releases/download',
  checksums: Object.freeze({
    /** Release asset name that lists every asset's sha256. */
    name: 'basemind_0.34.0_checksums.txt',
    format: 'sha256sum',
  }),
  assets: Object.freeze({
    'windows-x64': Object.freeze({ triple: 'x86_64-pc-windows-msvc', ext: 'zip', binary: 'basemind.exe', bytes: 75_627_742 }),
    'linux-x64': Object.freeze({ triple: 'x86_64-unknown-linux-gnu', ext: 'tar.gz', binary: 'basemind', bytes: 92_214_847 }),
    'linux-arm64': Object.freeze({ triple: 'aarch64-unknown-linux-gnu', ext: 'tar.gz', binary: 'basemind', bytes: 102_161_826 }),
    'darwin-arm64': Object.freeze({ triple: 'aarch64-apple-darwin', ext: 'tar.gz', binary: 'basemind', bytes: 88_184_663 }),
  }),
  skills: Object.freeze({
    count: 10,
    names: Object.freeze([
      'basemind',
      'basemind-cli',
      'basemind-code-search',
      'basemind-comms',
      'basemind-doctor',
      'basemind-documents',
      'basemind-git-history',
      'basemind-multi-agent-room',
      'basemind-scan',
      'basemind-stats',
    ]),
  }),
})

/**
 * Asset metadata for one platform target key (for example `windows-x64`).
 * @param {string} target
 * @returns {{ triple: string, ext: 'zip'|'tar.gz', binary: string, bytes: number, name: string, url: string } | undefined}
 */
export function assetFor(target) {
  const asset = UPSTREAM.assets[target]
  if (asset === undefined) return undefined
  const name = `basemind-${asset.triple}.${asset.ext}`
  return { ...asset, name, url: `${UPSTREAM.releaseBase}/${UPSTREAM.tag}/${name}` }
}

/** @returns {string[]} the vendored skill directory names, in upstream order. */
export function skillsNames() {
  return [...UPSTREAM.skills.names]
}

/** URL of the release checksums file for the pinned version. */
export function checksumsUrl() {
  return `${UPSTREAM.releaseBase}/${UPSTREAM.tag}/${UPSTREAM.checksums.name}`
}
