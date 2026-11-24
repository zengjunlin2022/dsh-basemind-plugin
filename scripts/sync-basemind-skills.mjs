#!/usr/bin/env node
/**
 * Vendors the official BaseMind skills into `skills/` and verifies them.
 *
 * The upstream text is a frozen asset (upstream regenerates it and asserts its
 * mirrors are byte-identical), so the DSH adaptations are build steps declared
 * in `skills/.dsh-adapt.json` — never hand edits. Every rule must match exactly
 * `expectOccurrences` times; any other count fails the sync, which is how a
 * silent upstream rewording is caught instead of shipping stale wording.
 *
 * Usage:
 *   node scripts/sync-basemind-skills.mjs --tag v0.34.0 [--source <dir|url>]
 *   node scripts/sync-basemind-skills.mjs --tag v0.34.0 --check
 *
 * `--check` reads only the local `skills/**` tree and `UPSTREAM.json`: no
 * network and no writes. Exit code 1 means the vendored copy drifted.
 *
 * @module dsh-basemind-plugin/scripts/sync-basemind-skills
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UPSTREAM, skillsNames } from '../lib/upstream.js'

/** Repository root, derived from this module rather than the caller's cwd. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Directory that receives the vendored skills. */
export const SKILLS_ROOT = join(ROOT, 'skills')
/** Declarative adaptation rules (reviewable diff of the official text). */
export const ADAPT_FILE = join(SKILLS_ROOT, '.dsh-adapt.json')
/** Provenance recorded next to the vendored text. */
export const UPSTREAM_FILE = join(SKILLS_ROOT, 'UPSTREAM.json')
/** Verbatim upstream MIT license. */
export const LICENSE_FILE = join(SKILLS_ROOT, 'LICENSE-basemind.txt')

/** Files vendored for every skill, in the order upstream ships them. */
export const SKILL_FILES = Object.freeze(['SKILL.md', 'index.md'])
/** Adaptation ids the rule file must declare (R6 is a reviewed no-op). */
export const REQUIRED_RULE_IDS = Object.freeze(['R1', 'R2', 'R3', 'R4', 'R5'])
/** The only root-level entries the check tolerates besides skill directories. */
const ROOT_FILES = Object.freeze(['.dsh-adapt.json', 'UPSTREAM.json', 'LICENSE-basemind.txt'])

/** Failure that should abort a sync or a check with a readable message. */
export class SyncError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SyncError'
  }
}

/** Real Node I/O used when a caller does not inject its own dependencies. */
export const defaultDeps = Object.freeze({
  fetch: (...args) => globalThis.fetch(...args),
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data) => writeFile(path, data),
  mkdir: (path, options) => mkdir(path, options),
  readdir: (path, options) => readdir(path, options),
  stat: (path) => stat(path),
  now: () => new Date(),
})

/**
 * Parse the CLI arguments.
 * @param {string[]} argv
 * @returns {{ tag: string, source: string | undefined, check: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const options = { tag: UPSTREAM.tag, source: undefined, check: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') {
      options.check = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--tag' || arg === '--source') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new SyncError(`${arg} needs a value`)
      options[arg.slice(2)] = value
      index += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    if (arg.startsWith('--source=')) {
      options.source = arg.slice('--source='.length)
      continue
    }
    throw new SyncError(`unknown argument: ${arg}`)
  }
  return options
}

/**
 * Version carried by a release tag (`v0.34.0` -> `0.34.0`).
 * @param {string} tag
 * @returns {string}
 */
export function tagVersion(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag))
  if (match === null) throw new SyncError(`tag must look like v1.2.3, got ${JSON.stringify(tag)}`)
  return match[1]
}

/**
 * Parse the flat-plus-one-level YAML subset the upstream frontmatter uses.
 * @param {string} text
 * @returns {{ attributes: Record<string, string | Record<string, string>>, body: string }}
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---\n')) {
    throw new SyncError('missing YAML frontmatter block')
  }
  const close = text.indexOf('\n---\n', 4)
  if (close < 0) throw new SyncError('unterminated YAML frontmatter block')
  const attributes = {}
  let parent
  for (const raw of text.slice(4, close).split('\n')) {
    if (raw.trim() === '') continue
    const nested = /^\s+/.test(raw)
    const line = raw.trim()
    const colon = line.indexOf(':')
    if (colon <= 0) throw new SyncError(`cannot parse frontmatter line: ${raw}`)
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    if (nested) {
      if (parent === undefined) throw new SyncError(`nested frontmatter without a parent: ${raw}`)
      parent[key] = value
      continue
    }
    if (value === '') {
      parent = {}
      attributes[key] = parent
      continue
    }
    attributes[key] = value
    parent = undefined
  }
  return { attributes, body: text.slice(close + 5) }
}

/**
 * Contract checks for one skill's frontmatter (name/description/license/author/repository).
 * @param {string} skill
 * @param {Record<string, unknown>} attributes
 * @returns {string[]} problems, empty when the frontmatter is valid
 */
export function validateFrontmatter(skill, attributes) {
  const problems = []
  const metadata = /** @type {Record<string, unknown> | undefined} */ (attributes.metadata)
  if (attributes.name !== skill) {
    problems.push(`${skill}: frontmatter name must be "${skill}", got ${JSON.stringify(attributes.name)}`)
  }
  if (typeof attributes.description !== 'string' || attributes.description.trim() === '') {
    problems.push(`${skill}: frontmatter description is missing`)
  }
  if (attributes.license !== 'MIT') problems.push(`${skill}: frontmatter license must be MIT`)
  if (typeof metadata?.author !== 'string' || metadata.author.trim() === '') {
    problems.push(`${skill}: frontmatter metadata.author is missing`)
  }
  if (metadata?.repository !== `https://github.com/${UPSTREAM.repository}`) {
    problems.push(`${skill}: frontmatter metadata.repository must be https://github.com/${UPSTREAM.repository}`)
  }
  return problems
}

/**
 * SHA-256 of UTF-8 text, hex encoded.
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The upstream `Content-Hash` line, preserved verbatim for traceability.
 * @param {string} text
 * @returns {string | undefined}
 */
export function contentHashLine(text) {
  const match = /^Content-Hash: .+$/m.exec(text)
  return match?.[0]
}

/**
 * Count non-overlapping occurrences of a literal needle.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
export function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
}

/**
 * Apply every rule declared for one upstream file and fail on a count mismatch.
 * @param {string} text
 * @param {Array<{ id: string, find: string, replace: string, expectOccurrences: number }>} rules
 * @param {string} location
 * @returns {{ text: string, applied: Array<{ id: string, count: number }> }}
 */
export function applyAdaptations(text, rules, location) {
  let output = text
  const applied = []
  for (const rule of rules) {
    const count = countOccurrences(output, rule.find)
    if (count !== rule.expectOccurrences) {
      throw new SyncError(
        `${rule.id} ${location}: expected ${rule.expectOccurrences} match(es) of the declared upstream text, ` +
          `found ${count} — the upstream wording changed; update skills/.dsh-adapt.json and re-run the sync`,
      )
    }
    output = output.split(rule.find).join(rule.replace)
    applied.push({ id: rule.id, count })
  }
  return { text: output, applied }
}

/**
 * Validate the shape of `.dsh-adapt.json`.
 * @param {unknown} document
 * @returns {string[]} problems, empty when the rule file is usable
 */
export function validateAdaptations(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return ['skills/.dsh-adapt.json must be a JSON object']
  }
  const rules = /** @type {{ rules?: unknown, checked?: unknown }} */ (document).rules
  const checked = /** @type {{ checked?: unknown }} */ (document).checked
  const problems = []
  if (!Array.isArray(rules) || rules.length === 0) problems.push('skills/.dsh-adapt.json: rules must be a non-empty array')
  const ids = new Set()
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule === null || typeof rule !== 'object') {
      problems.push('skills/.dsh-adapt.json: every rule must be an object')
      continue
    }
    for (const field of ['id', 'skill', 'file', 'find', 'replace']) {
      if (typeof rule[field] !== 'string' || rule[field] === '') {
        problems.push(`skills/.dsh-adapt.json: rule is missing ${field}`)
      }
    }
    if (!UPSTREAM.skills.names.includes(rule.skill)) problems.push(`skills/.dsh-adapt.json: ${rule.id} names unknown skill ${rule.skill}`)
    if (!SKILL_FILES.includes(rule.file)) problems.push(`skills/.dsh-adapt.json: ${rule.id} names unknown file ${rule.file}`)
    if (!Number.isInteger(rule.expectOccurrences) || rule.expectOccurrences < 1) {
      problems.push(`skills/.dsh-adapt.json: ${rule.id} needs a positive integer expectOccurrences`)
    }
    if (typeof rule.id === 'string') ids.add(rule.id)
  }
  for (const id of REQUIRED_RULE_IDS) {
    if (!ids.has(id)) problems.push(`skills/.dsh-adapt.json: missing adaptation rule ${id}`)
  }
  for (const entry of Array.isArray(checked) ? checked : []) {
    if (entry === null || typeof entry !== 'object') {
      problems.push('skills/.dsh-adapt.json: every checked entry must be an object')
      continue
    }
    if (typeof entry.id !== 'string' || entry.id === '') problems.push('skills/.dsh-adapt.json: checked entry is missing id')
    if (!UPSTREAM.skills.names.includes(entry.skill)) problems.push(`skills/.dsh-adapt.json: checked ${entry.id} names unknown skill`)
    if (!SKILL_FILES.includes(entry.file)) problems.push(`skills/.dsh-adapt.json: checked ${entry.id} names unknown file`)
    if (typeof entry.note !== 'string' || entry.note.trim() === '') problems.push(`skills/.dsh-adapt.json: checked ${entry.id} needs a note`)
  }
  return problems
}

/**
 * Parse and validate the declarative rule file.
 * @param {string} raw
 * @param {string} [label]
 * @returns {any}
 */
export function parseAdaptationRules(raw, label = 'skills/.dsh-adapt.json') {
  let document
  try {
    document = JSON.parse(raw)
  } catch (error) {
    throw new SyncError(`${label} is not valid JSON: ${error.message}`)
  }
  const problems = validateAdaptations(document)
  if (problems.length > 0) throw new SyncError(problems.join('\n'))
  return document
}

/** @param {string[]} ids @returns {string[]} */
function sortIds(ids) {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

/** @param {string} url @returns {string} */
function withTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`
}

/** @param {string} baseUrl @param {string} path @returns {string} */
function joinUrl(baseUrl, path) {
  return withTrailingSlash(baseUrl) + path.replace(/^\/+/, '')
}

/** @param {string} source @returns {boolean} */
export function isRemoteSource(source) {
  return /^https?:\/\//i.test(source)
}

/**
 * Read one text file from a remote base URL or a local directory.
 * @param {string} location
 * @param {boolean} remote
 * @param {typeof defaultDeps} deps
 * @returns {Promise<string>}
 */
export async function readText(location, remote, deps = defaultDeps) {
  if (remote) {
    let response
    try {
      response = await deps.fetch(location)
    } catch (error) {
      throw new SyncError(`GET ${location} failed: ${error.message}`)
    }
    if (response === undefined || response.ok !== true) {
      throw new SyncError(`GET ${location} failed with HTTP ${response?.status ?? 'no response'}`)
    }
    return response.text()
  }
  try {
    return await deps.readFile(location, 'utf8')
  } catch (error) {
    throw new SyncError(`cannot read ${location}: ${error.message}`)
  }
}

/** @param {string} text @returns {string} */
export function parseCargoVersion(text) {
  const match = /\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(text)
  if (match === null) throw new SyncError('Cargo.toml does not declare [package] version')
  return match[1]
}

/** @param {string} text @returns {number} */
export function parseReleaseMinor(text) {
  const match = /RELEASE_MINOR\s*:\s*u16\s*=\s*(\d+)/.exec(text)
  if (match === null) throw new SyncError('src/version.rs does not declare RELEASE_MINOR')
  return Number(match[1])
}

/**
 * Rebuild a version from `RELEASE_MINOR` (`0.X.y` -> `X`; `1.x` -> `100 + x`).
 * @param {number} minor
 * @returns {string}
 */
export function versionFromReleaseMinor(minor) {
  if (minor >= 100) return `${Math.floor(minor / 100)}.${minor % 100}.0`
  return `0.${minor}.0`
}

/**
 * Resolve the local skills root from either a clone root or the skills dir itself.
 * @param {string} source
 * @param {typeof defaultDeps} deps
 * @returns {Promise<string>}
 */
export async function resolveLocalSkillsRoot(source, deps = defaultDeps) {
  const root = resolve(source)
  const nested = join(root, 'skills')
  const hasSkillAt = async (candidate) => {
    try {
      return (await deps.stat(join(candidate, 'basemind', 'SKILL.md'))).isFile()
    } catch {
      return false
    }
  }
  if (await hasSkillAt(nested)) return nested
  if (await hasSkillAt(root)) return root
  throw new SyncError(`--source ${root} has neither skills/basemind/SKILL.md nor basemind/SKILL.md`)
}

/**
 * Read the tag version from Cargo.toml, falling back to src/version.rs.
 * @param {string} repoRoot
 * @param {boolean} remote
 * @param {typeof defaultDeps} deps
 * @returns {Promise<string>}
 */
export async function readUpstreamVersion(repoRoot, remote, deps = defaultDeps) {
  const cargo = remote ? joinUrl(repoRoot, 'Cargo.toml') : join(repoRoot, 'Cargo.toml')
  try {
    return parseCargoVersion(await readText(cargo, remote, deps))
  } catch (error) {
    const versionRs = remote ? joinUrl(repoRoot, 'src/version.rs') : join(repoRoot, 'src', 'version.rs')
    try {
      return versionFromReleaseMinor(parseReleaseMinor(await readText(versionRs, remote, deps)))
    } catch {
      throw new SyncError(`cannot verify the tag version from ${cargo}: ${error.message}`)
    }
  }
}

/**
 * Cross-check the upstream skills manifest (count, file set, per-file sha256).
 * @param {unknown} manifest
 * @param {Map<string, string>} files
 * @returns {void}
 */
export function validateUpstreamManifest(manifest, files) {
  const expected = skillsNames().flatMap((skill) => SKILL_FILES.map((file) => `${skill}/${file}`)).sort()
  const problems = []
  const record = /** @type {{ skill_count?: unknown, source?: unknown, files?: Record<string, string> }} */ (manifest ?? {})
  if (record.skill_count !== skillsNames().length) {
    problems.push(`upstream manifest skill_count is ${record.skill_count}, expected ${skillsNames().length}`)
  }
  if (record.source !== 'plugin/skills') problems.push('upstream manifest source is not plugin/skills')
  const listed = Object.keys(record.files ?? {}).sort()
  if (listed.join('\n') !== expected.join('\n')) {
    problems.push(`upstream manifest file set differs from the expected ${expected.length} files`)
  }
  for (const path of expected) {
    const text = files.get(path)
    const expectedHash = record.files?.[path]
    if (text === undefined) continue
    if (typeof expectedHash !== 'string' || sha256(text) !== expectedHash) {
      problems.push(`upstream manifest hash mismatch for ${path}`)
    }
  }
  if (problems.length > 0) throw new SyncError(problems.join('\n'))
}

/**
 * Read the version-checked upstream tree (network for a URL, disk for a directory).
 * @param {{ tag?: string, source?: string }} options
 * @param {typeof defaultDeps} deps
 * @returns {Promise<{ tag: string, version: string, skillsRoot: string, files: Map<string, string>, license: string, remote: boolean }>}
 */
export async function readSource(options = {}, deps = defaultDeps) {
  const tag = options.tag ?? UPSTREAM.tag
  const version = tagVersion(tag)
  if (version !== UPSTREAM.version) {
    throw new SyncError(`tag ${tag} does not match lib/upstream.js version ${UPSTREAM.version}`)
  }
  const configured = options.source ?? `https://raw.githubusercontent.com/${UPSTREAM.repository}/${tag}/skills/`
  const remote = isRemoteSource(configured)
  const skillsRoot = remote ? withTrailingSlash(configured) : await resolveLocalSkillsRoot(configured, deps)
  const repoRoot = remote ? skillsRoot.replace(/\/skills\/$/, '/') : dirname(skillsRoot)
  const sourceVersion = await readUpstreamVersion(repoRoot, remote, deps)
  if (sourceVersion !== version) {
    throw new SyncError(`upstream source declares version ${sourceVersion}, but tag ${tag} means ${version}`)
  }
  const license = await readText(remote ? joinUrl(repoRoot, 'LICENSE') : join(repoRoot, 'LICENSE'), remote, deps)
  const files = new Map()
  for (const skill of skillsNames()) {
    for (const file of SKILL_FILES) {
      const path = `${skill}/${file}`
      files.set(path, await readText(remote ? joinUrl(skillsRoot, path) : join(skillsRoot, skill, file), remote, deps))
    }
  }
  const manifestPath = remote ? joinUrl(skillsRoot, '.ai-rulez-public-skills.json') : join(skillsRoot, '.ai-rulez-public-skills.json')
  let manifestText
  try {
    manifestText = await readText(manifestPath, remote, deps)
  } catch (error) {
    if (remote) throw error
  }
  if (manifestText !== undefined) {
    let manifest
    try {
      manifest = JSON.parse(manifestText)
    } catch (error) {
      throw new SyncError(`${manifestPath} is not valid JSON: ${error.message}`)
    }
    validateUpstreamManifest(manifest, files)
  }
  if (!remote) {
    const entries = await deps.readdir(skillsRoot, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    const expected = [...skillsNames()].sort()
    if (dirs.join('\n') !== expected.join('\n')) {
      throw new SyncError(`skills directories (${dirs.join(', ')}) do not match lib/upstream.js (${expected.join(', ')})`)
    }
  }
  return { tag, version, skillsRoot, files, license, remote }
}

/**
 * Vendor the skills: apply the declared adaptations, then write the tree and UPSTREAM.json.
 * @param {{ tag?: string, source?: string, skillsRoot?: string }} [options]
 * @param {typeof defaultDeps} [deps]
 * @returns {Promise<{ tag: string, version: string, skills: number, files: number, checked: number, bytes: number, written: string[], rules: Array<{ id: string, skill: string, file: string, count: number }> }>}
 */
export async function syncSkills(options = {}, deps = defaultDeps) {
  const skillsRoot = options.skillsRoot ?? SKILLS_ROOT
  const adaptRaw = await readText(join(skillsRoot, '.dsh-adapt.json'), false, deps)
  const adaptation = parseAdaptationRules(adaptRaw)
  const source = await readSource(options, deps)

  const outputs = new Map()
  const skills = {}
  const rules = []
  for (const skill of skillsNames()) {
    const files = {}
    for (const file of SKILL_FILES) {
      const path = `${skill}/${file}`
      const sourceText = source.files.get(path)
      if (sourceText === undefined) throw new SyncError(`upstream is missing ${path}`)
      if (file === 'SKILL.md') {
        const problems = validateFrontmatter(skill, parseFrontmatter(sourceText).attributes)
        if (problems.length > 0) throw new SyncError(problems.join('\n'))
      }
      const selected = adaptation.rules.filter((rule) => rule.skill === skill && rule.file === file)
      const applied = applyAdaptations(sourceText, selected, path)
      for (const entry of applied.applied) rules.push({ ...entry, skill, file })
      const checked = adaptation.checked
        .filter((entry) => entry.skill === skill && entry.file === file)
        .map((entry) => entry.id)
      outputs.set(path, applied.text)
      files[file] = {
        sourcePath: `skills/${path}`,
        sourceSha256: sha256(sourceText),
        outputSha256: sha256(applied.text),
        contentHash: contentHashLine(sourceText),
        adaptations: sortIds([...applied.applied.map((entry) => entry.id), ...checked]),
      }
    }
    skills[skill] = {
      sourcePath: `skills/${skill}/SKILL.md`,
      sourceSha256: files['SKILL.md'].sourceSha256,
      outputSha256: files['SKILL.md'].outputSha256,
      adaptations: files['SKILL.md'].adaptations,
      files,
    }
  }

  if (!/^MIT License\n/.test(source.license) || !source.license.includes('Permission is hereby granted')) {
    throw new SyncError('upstream LICENSE is not the expected MIT text')
  }
  const copyright = /^Copyright .+$/m.exec(source.license)?.[0]
  if (copyright === undefined) throw new SyncError('upstream LICENSE has no Copyright line')

  const checkedCount = adaptation.checked.length
  const record = {
    upstream: {
      repository: UPSTREAM.repository,
      tag: source.tag,
      commit: UPSTREAM.commit,
      license: 'MIT',
      copyright,
    },
    version: source.version,
    syncedAt: deps.now().toISOString().slice(0, 10),
    adaptRulesSha256: sha256(adaptRaw),
    licenseFile: {
      sourcePath: 'LICENSE',
      outputPath: 'skills/LICENSE-basemind.txt',
      sourceSha256: sha256(source.license),
      outputSha256: sha256(source.license),
    },
    skills,
  }
  const recordText = `${JSON.stringify(record, null, 2)}\n`

  const written = []
  let bytes = 0
  for (const [path, text] of outputs) {
    const target = join(skillsRoot, ...path.split('/'))
    await deps.mkdir(dirname(target), { recursive: true })
    await deps.writeFile(target, text)
    written.push(`skills/${path}`)
    bytes += Buffer.byteLength(text, 'utf8')
  }
  await deps.writeFile(join(skillsRoot, 'LICENSE-basemind.txt'), source.license)
  written.push('skills/LICENSE-basemind.txt')
  bytes += Buffer.byteLength(source.license, 'utf8')
  await deps.writeFile(join(skillsRoot, 'UPSTREAM.json'), recordText)
  written.push('skills/UPSTREAM.json')
  bytes += Buffer.byteLength(recordText, 'utf8')

  return {
    tag: source.tag,
    version: source.version,
    skills: skillsNames().length,
    files: outputs.size,
    checked: checkedCount,
    bytes,
    written,
    rules,
  }
}

/**
 * Verify the vendored tree against `UPSTREAM.json` without network or writes.
 * @param {{ tag?: string, skillsRoot?: string }} [options]
 * @param {typeof defaultDeps} [deps]
 * @returns {Promise<{ ok: boolean, drift: Array<{ path: string, reason: string }> }>}
 */
export async function checkSkills(options = {}, deps = defaultDeps) {
  const skillsRoot = options.skillsRoot ?? SKILLS_ROOT
  const drift = []
  const add = (path, reason) => drift.push({ path, reason })
  if (options.tag !== undefined && options.tag !== UPSTREAM.tag) {
    add('--tag', `${options.tag} does not match lib/upstream.js tag ${UPSTREAM.tag}`)
  }

  let adaptRaw
  let adaptation
  try {
    adaptRaw = await deps.readFile(join(skillsRoot, '.dsh-adapt.json'), 'utf8')
    adaptation = parseAdaptationRules(adaptRaw)
  } catch (error) {
    add('skills/.dsh-adapt.json', error.message)
    return { ok: false, drift }
  }

  let record
  let recordRaw
  try {
    recordRaw = await deps.readFile(join(skillsRoot, 'UPSTREAM.json'), 'utf8')
    record = JSON.parse(recordRaw)
  } catch (error) {
    add('skills/UPSTREAM.json', error.message)
    return { ok: false, drift }
  }

  const identities = [
    ['upstream.repository', record.upstream?.repository, UPSTREAM.repository],
    ['upstream.tag', record.upstream?.tag, UPSTREAM.tag],
    ['version', record.version, UPSTREAM.version],
    ['upstream.commit', record.upstream?.commit, UPSTREAM.commit],
    ['upstream.license', record.upstream?.license, 'MIT'],
  ]
  for (const [field, actual, expected] of identities) {
    if (actual !== expected) add(`skills/UPSTREAM.json ${field}`, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  }
  if (record.adaptRulesSha256 !== sha256(adaptRaw)) {
    add('skills/.dsh-adapt.json', 'adaptation rules changed after the last sync; re-run the sync')
  }

  const recordedNames = Object.keys(record.skills ?? {}).sort()
  const expectedNames = [...skillsNames()].sort()
  if (recordedNames.join('\n') !== expectedNames.join('\n')) {
    add('skills/UPSTREAM.json skills', 'skill keys do not match lib/upstream.js')
  }

  let entries
  try {
    entries = await deps.readdir(skillsRoot, { withFileTypes: true })
  } catch (error) {
    add('skills/', error.message)
    return { ok: false, drift }
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  if (dirs.join('\n') !== expectedNames.join('\n')) add('skills/', 'skill directories do not match lib/upstream.js')
  for (const entry of entries) {
    if (!entry.isDirectory() && !ROOT_FILES.includes(entry.name)) add(`skills/${entry.name}`, 'unexpected file in the vendored skills root')
  }

  for (const skill of skillsNames()) {
    for (const file of SKILL_FILES) {
      const path = `${skill}/${file}`
      const recorded = record.skills?.[skill]?.files?.[file]
      let text
      try {
        text = await deps.readFile(join(skillsRoot, skill, file), 'utf8')
      } catch (error) {
        add(`skills/${path}`, error.message)
        continue
      }
      if (recorded === undefined) {
        add(`skills/${path}`, 'not recorded in UPSTREAM.json')
        continue
      }
      if (sha256(text) !== recorded.outputSha256) add(`skills/${path}`, 'sha256 differs from UPSTREAM.json outputSha256')
      if (text.includes('${CLAUDE_PLUGIN_ROOT}')) add(`skills/${path}`, 'still references ${CLAUDE_PLUGIN_ROOT}')
      if (text.includes('mcp-launch.sh')) add(`skills/${path}`, 'still references the Claude plugin launcher mcp-launch.sh')
      if (file === 'SKILL.md') {
        try {
          const problems = validateFrontmatter(skill, parseFrontmatter(text).attributes)
          for (const problem of problems) add(`skills/${path}`, problem)
        } catch (error) {
          add(`skills/${path}`, error.message)
        }
      }
      if (typeof recorded.contentHash === 'string' && !text.includes(recorded.contentHash)) {
        add(`skills/${path}`, 'the upstream Content-Hash line was modified')
      }
      const expectedAdaptations = sortIds([
        ...adaptation.rules.filter((rule) => rule.skill === skill && rule.file === file).map((rule) => rule.id),
        ...adaptation.checked.filter((entry) => entry.skill === skill && entry.file === file).map((entry) => entry.id),
      ])
      if (JSON.stringify(recorded.adaptations) !== JSON.stringify(expectedAdaptations)) {
        add(`skills/${path}`, `recorded adaptations ${JSON.stringify(recorded.adaptations)} != ${JSON.stringify(expectedAdaptations)}`)
      }
    }
  }

  try {
    const license = await deps.readFile(join(skillsRoot, 'LICENSE-basemind.txt'), 'utf8')
    if (sha256(license) !== record.licenseFile?.outputSha256) add('skills/LICENSE-basemind.txt', 'sha256 differs from UPSTREAM.json')
    if (!/^MIT License\n/.test(license) || !license.includes(`${record.upstream?.copyright ?? ''}`)) {
      add('skills/LICENSE-basemind.txt', 'does not contain the upstream MIT text and copyright')
    }
  } catch (error) {
    add('skills/LICENSE-basemind.txt', error.message)
  }

  return { ok: drift.length === 0, drift }
}

const USAGE = `Usage: node scripts/sync-basemind-skills.mjs --tag v${UPSTREAM.version} [--source <dir|url>] [--check]`

/**
 * CLI entry point. Returns the process exit code instead of exiting.
 * @param {string[]} [argv]
 * @param {typeof defaultDeps} [deps]
 * @returns {Promise<number>}
 */
export async function runCli(argv = process.argv.slice(2), deps = defaultDeps) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.check) {
    const result = await checkSkills(options, deps)
    if (!result.ok) {
      for (const item of result.drift) console.error(`drift ${item.path}: ${item.reason}`)
      return 1
    }
    console.log(`skills check ok: ${UPSTREAM.skills.count} skills, ${UPSTREAM.skills.count * 2} files match skills/UPSTREAM.json (${UPSTREAM.tag})`)
    return 0
  }
  const result = await syncSkills(options, deps)
  const counts = new Map()
  for (const rule of result.rules) counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1)
  const summary = [...counts.entries()].map(([id, count]) => `${id} ×${count}`).join(', ')
  console.log(
    `synced ${result.tag}: ${result.skills} skills, ${result.files} files, ${result.bytes} bytes written to skills/`,
  )
  console.log(`adaptations applied: ${summary}${result.checked > 0 ? ` (${result.checked} checked-only)` : ''}`)
  console.log(`wrote ${result.written.length} files, including skills/UPSTREAM.json`)
  return 0
}

/** @param {string} metaUrl @param {string | undefined} entry @returns {boolean} */
function isMain(metaUrl, entry) {
  if (typeof entry !== 'string') return false
  return resolve(entry) === fileURLToPath(metaUrl)
}

if (isMain(import.meta.url, process.argv[1])) {
  runCli().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`sync-basemind-skills: ${error.message}`)
      process.exitCode = 1
    },
  )
}
