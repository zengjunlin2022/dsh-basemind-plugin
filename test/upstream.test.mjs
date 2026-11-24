/**
 * Repo-level consistency checks for the pinned BaseMind release and the
 * vendored skills provenance. These tests are offline: everything they assert
 * is read from `lib/upstream.js`, `skills/**`, `fixtures/` and (when present)
 * `lib/binary/platform.js`.
 *
 * @module dsh-basemind-plugin/test/upstream
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { UPSTREAM, skillsNames } from '../lib/upstream.js'
import { applyAdaptations, checkSkills, parseAdaptationRules, parseArgs, validateAdaptations } from '../scripts/sync-basemind-skills.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILLS = join(ROOT, 'skills')
const RECORD = JSON.parse(readFileSync(join(SKILLS, 'UPSTREAM.json'), 'utf8'))
const NAMES = skillsNames()
const FILES = ['SKILL.md', 'index.md']
const CLAUDE_ROOT = '$' + '{CLAUDE_PLUGIN_ROOT}'

/** @param {string} text @returns {string} */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(path, 'utf8')

/**
 * Minimal independent frontmatter reader: flat keys plus one indented metadata map.
 * @param {string} text
 * @returns {{ top: Map<string, string>, metadata: Map<string, string> }}
 */
function readFrontmatter(text) {
  assert.ok(text.startsWith('---\n'), 'SKILL.md must start with a frontmatter block')
  const end = text.indexOf('\n---\n', 4)
  assert.ok(end > 0, 'SKILL.md must close its frontmatter block')
  const top = new Map()
  const metadata = new Map()
  let section = null
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^(\s*)([A-Za-z_-]+):(.*)$/.exec(line)
    assert.ok(match, 'unparseable frontmatter line: ' + line)
    const [, indent, key, rawValue] = match
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (indent.length > 0) {
      assert.equal(section, 'metadata', 'only metadata may be nested: ' + line)
      metadata.set(key, value)
      continue
    }
    if (value === '') {
      section = key === 'metadata' ? 'metadata' : null
      continue
    }
    section = null
    top.set(key, value)
  }
  return { top, metadata }
}

/** @returns {Array<{ path: string, text: string }>} */
function corpus() {
  const entries = []
  for (const skill of NAMES) {
    for (const file of FILES) {
      entries.push({ path: 'skills/' + skill + '/' + file, text: read(join(SKILLS, skill, file)) })
    }
  }
  return entries
}

test('UPSTREAM.assets keys match the platform module supported set', { skip: existsSync(join(ROOT, 'lib/binary/platform.js')) ? false : 'lib/binary/platform.js is not present in this checkout yet' }, async () => {
  const platform = await import(pathToFileURL(join(ROOT, 'lib/binary/platform.js')).href)
  assert.equal(typeof platform.resolveTarget, 'function', 'lib/binary/platform.js must export resolveTarget()')
  assert.ok(Array.isArray(platform.SUPPORTED_TARGETS), 'lib/binary/platform.js must export SUPPORTED_TARGETS')
  assert.deepEqual([...platform.SUPPORTED_TARGETS].sort(), Object.keys(UPSTREAM.assets).sort())
  for (const key of platform.SUPPORTED_TARGETS) {
    const split = key.indexOf('-')
    const target = platform.resolveTarget({ platform: key.slice(0, split), arch: key.slice(split + 1) })
    assert.equal(target.key, key, key + ' does not resolve back to its own asset key')
    assert.equal(target.triple, UPSTREAM.assets[key].triple, key + ' triple drifted from UPSTREAM.assets')
    assert.equal(target.ext, UPSTREAM.assets[key].ext)
    assert.equal(target.binary, UPSTREAM.assets[key].binary)
  }
  assert.ok(platform.resolveTarget({ platform: 'darwin', arch: 'x64' }).unsupported, 'Intel macOS has no release asset')
})

test('UPSTREAM.skills count, names and on-disk directories agree', () => {
  assert.equal(UPSTREAM.skills.count, 10)
  assert.equal(NAMES.length, UPSTREAM.skills.count)
  assert.equal(new Set(NAMES).size, NAMES.length)
  const dirs = readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(dirs, [...NAMES].sort())
  assert.deepEqual(Object.keys(RECORD.skills).sort(), [...NAMES].sort())
})

test('every skill ships SKILL.md and index.md with valid frontmatter', () => {
  for (const skill of NAMES) {
    for (const file of FILES) {
      assert.ok(statSync(join(SKILLS, skill, file)).isFile(), 'missing skills/' + skill + '/' + file)
    }
    const { top, metadata } = readFrontmatter(read(join(SKILLS, skill, 'SKILL.md')))
    assert.equal(top.get('name'), skill)
    assert.ok((top.get('description') ?? '').length > 0, skill + ': empty description')
    assert.equal(top.get('license'), 'MIT')
    assert.ok((metadata.get('author') ?? '').length > 0, skill + ': missing metadata.author')
    assert.equal(metadata.get('repository'), 'https://github.com/' + UPSTREAM.repository)
  }
})

test('no vendored skill still references the Claude plugin launcher root', () => {
  for (const { path, text } of corpus()) {
    assert.ok(!text.includes(CLAUDE_ROOT), path + ' still references ' + CLAUDE_ROOT)
    assert.ok(!text.includes('mcp-launch.sh'), path + ' still references mcp-launch.sh')
  }
})

test('UPSTREAM.json records hashes and adaptations that match disk', () => {
  for (const { path, text } of corpus()) {
    const [, skill, file] = path.split('/')
    const recorded = RECORD.skills[skill]?.files?.[file]
    assert.ok(recorded, path + ' is not recorded in UPSTREAM.json')
    assert.equal(recorded.sourcePath, path)
    assert.equal(recorded.outputSha256, sha256(text), path + ' outputSha256 is stale')
    assert.match(recorded.sourceSha256, /^[0-9a-f]{64}$/)
    assert.match(recorded.outputSha256, /^[0-9a-f]{64}$/)
    assert.ok(Array.isArray(recorded.adaptations))
  }
  for (const skill of NAMES) {
    assert.equal(RECORD.skills[skill].outputSha256, sha256(read(join(SKILLS, skill, 'SKILL.md'))))
    assert.equal(RECORD.skills[skill].sourcePath, 'skills/' + skill + '/SKILL.md')
  }
})

test('UPSTREAM.json tag, version and commit correspond to lib/upstream.js', () => {
  assert.equal(RECORD.upstream.repository, UPSTREAM.repository)
  assert.equal(RECORD.upstream.tag, UPSTREAM.tag)
  assert.equal(RECORD.upstream.commit, UPSTREAM.commit)
  assert.equal(RECORD.upstream.license, 'MIT')
  assert.equal(RECORD.version, UPSTREAM.version)
  assert.equal(RECORD.upstream.tag, 'v' + RECORD.version)
  assert.match(RECORD.syncedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(RECORD.adaptRulesSha256, /^[0-9a-f]{64}$/)
})

test('the upstream Content-Hash lines are preserved verbatim', () => {
  for (const { path, text } of corpus()) {
    const [, skill, file] = path.split('/')
    const recorded = RECORD.skills[skill].files[file].contentHash
    assert.match(recorded, /^Content-Hash: blake3:[0-9a-f]{64}$/, path + ' has no recorded Content-Hash')
    assert.ok(text.includes(recorded), path + ' lost its upstream Content-Hash line')
  }
})

test('the declarative adaptations are valid and fully recorded', () => {
  const raw = read(join(SKILLS, '.dsh-adapt.json'))
  assert.deepEqual(validateAdaptations(JSON.parse(raw)), [])
  const document = parseAdaptationRules(raw)
  for (const rule of document.rules) {
    const recorded = RECORD.skills[rule.skill].files[rule.file].adaptations
    assert.ok(recorded.includes(rule.id), rule.id + ' on ' + rule.skill + '/' + rule.file + ' is not recorded')
  }
  for (const entry of document.checked) {
    const recorded = RECORD.skills[entry.skill].files[entry.file].adaptations
    assert.ok(recorded.includes(entry.id), 'checked ' + entry.id + ' on ' + entry.skill + '/' + entry.file + ' is not recorded')
  }
  const ruleCounts = new Map()
  for (const rule of document.rules) ruleCounts.set(rule.id, (ruleCounts.get(rule.id) ?? 0) + 1)
  assert.equal(ruleCounts.get('R1'), 4, 'R1 must cover all four CLI launcher references')
  assert.equal(ruleCounts.get('R5'), 2, 'R5 must cover the stats and doctor slash commands')
  assert.equal(ruleCounts.get('R7'), 1, 'R7 must cover the multi-agent-room identity sentence')
  assert.equal(ruleCounts.get('R8'), 3, 'R8 must cover the scan description, its run block and the CLI claim')
  for (const id of ['R2', 'R3', 'R4']) assert.equal(ruleCounts.get(id), 1)
})

test('the vendored license is the verbatim upstream MIT text', () => {
  const license = read(join(SKILLS, 'LICENSE-basemind.txt'))
  assert.equal(sha256(license), RECORD.licenseFile.outputSha256)
  assert.equal(RECORD.licenseFile.sourceSha256, RECORD.licenseFile.outputSha256)
  assert.ok(license.startsWith('MIT License\n'))
  assert.ok(license.includes(RECORD.upstream.copyright))
  assert.ok(license.includes('Permission is hereby granted'))
})

test('the corpus names a real BaseMind tool from the 0.34.0 fixture', () => {
  const fixturePath = join(ROOT, 'fixtures', 'basemind-' + UPSTREAM.version + '-tools.json')
  assert.ok(existsSync(fixturePath), 'missing ' + fixturePath)
  const tools = JSON.parse(read(fixturePath))
  const names = new Set(tools.map((tool) => tool.name))
  assert.ok(names.size >= 15)
  const text = corpus().map((entry) => entry.text).join('\n')
  const found = [...names].filter((name) => text.includes(name))
  assert.ok(found.length > 0, 'no fixture tool name appears anywhere in the vendored skills')
  assert.ok(found.includes('code_outline'), 'the basemind skill should name code_outline')
})

test('the sync CLI parses its documented arguments', () => {
  assert.deepEqual(parseArgs(['--tag', 'v0.34.0', '--check']), { tag: 'v0.34.0', source: undefined, check: true, help: false })
  assert.deepEqual(parseArgs(['--source', 'some/dir']).source, 'some/dir')
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  assert.throws(() => parseArgs(['--tag']), /needs a value/)
})

test('an adaptation rule fails the sync when the upstream wording changes', () => {
  assert.throws(
    () => applyAdaptations('official text', [{ id: 'R1', find: 'missing text', replace: 'x', expectOccurrences: 1 }], 'demo/SKILL.md'),
    /R1 demo\/SKILL.md: expected 1 match\(es\)/,
  )
  const applied = applyAdaptations('a a', [{ id: 'R5', find: 'a', replace: 'b', expectOccurrences: 2 }], 'demo/SKILL.md')
  assert.equal(applied.text, 'b b')
  assert.deepEqual(applied.applied, [{ id: 'R5', count: 2 }])
})

test('--check passes on the vendored tree and detects a local edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-basemind-skills-'))
  try {
    cpSync(SKILLS, root, { recursive: true })
    const clean = await checkSkills({ tag: UPSTREAM.tag, skillsRoot: root })
    assert.equal(clean.ok, true, JSON.stringify(clean.drift))
    appendFileSync(join(root, 'basemind', 'SKILL.md'), '\nhand edit\n')
    const drifted = await checkSkills({ tag: UPSTREAM.tag, skillsRoot: root })
    assert.equal(drifted.ok, false)
    assert.ok(drifted.drift.some((item) => item.path === 'skills/basemind/SKILL.md'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
