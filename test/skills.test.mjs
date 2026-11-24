import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBasemindSkillProvider, parseSkillFrontmatter } from '../lib/skills/provider.js'
import { UPSTREAM } from '../lib/upstream.js'

const BODY = '# Guide\n\nUse it.\n'

/** One vendored-looking SKILL.md. */
function skillText(name, extra) {
  return (
    '---\n' +
    'name: ' + name + '\n' +
    'description: Description for ' + name + '\n' +
    'license: MIT\n' +
    'metadata:\n' +
    '  upstream: basemind\n' +
    (extra ?? '') +
    '---\n' +
    BODY
  )
}

/** Create <root>/skills/<name>/SKILL.md for the requested names. */
async function makeTree(options) {
  const opts = options ?? {}
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-basemind-skills-'))
  const skillsRoot = path.join(root, 'skills')
  await mkdir(skillsRoot, { recursive: true })
  await writeFile(path.join(skillsRoot, 'index.md'), '# index\n')
  const names = opts.names ?? UPSTREAM.skills.names
  for (const name of names) {
    const dir = path.join(skillsRoot, name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), skillText(name))
  }
  if (opts.unknown === true) {
    const dir = path.join(skillsRoot, 'unknown-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), skillText('unknown-skill'))
  }
  return root
}

/** Create a tree that is removed after the test. */
async function withTree(t, options) {
  const root = await makeTree(options)
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A readiness double with a toggle. */
function fakeReadiness(initial) {
  const state = { ready: initial === true }
  return {
    state,
    ok: () => state.ready,
    onChange: () => () => {},
  }
}

test('the catalog is empty until readiness is ready', async (t) => {
  const root = await withTree(t)
  const readiness = fakeReadiness(false)
  const provider = createBasemindSkillProvider({ readiness, root })
  assert.deepEqual(await provider.list(), [])
  assert.equal(await provider.get('basemind'), undefined)

  readiness.state.ready = true
  const entries = await provider.list()
  assert.equal(entries.length, UPSTREAM.skills.count)
})

test('entries carry the full skill-catalog shape and skip unknown dirs', async (t) => {
  const root = await withTree(t, { unknown: true })
  const readiness = fakeReadiness(true)
  const provider = createBasemindSkillProvider({ readiness, root })
  const entries = await provider.list()

  assert.deepEqual(entries.map((entry) => entry.name), [...UPSTREAM.skills.names])
  for (const entry of entries) {
    assert.equal(entry.provider, 'basemind')
    assert.equal(entry.source, 'bundled')
    assert.equal(entry.rank, 1000)
    assert.equal(entry.locator, entry.name)
    assert.deepEqual(entry.invocation, { modelInvocable: true, userInvocable: true })
    assert.deepEqual(entry.resourceBase, { kind: 'directory', path: path.join(root, 'skills') })
    assert.equal(entry.path, path.join(root, 'skills', entry.name, 'SKILL.md'))
    assert.equal(entry.description, 'Description for ' + entry.name)
  }
  assert.equal(entries.some((entry) => entry.name === 'unknown-skill'), false)
})

/** Assert one loaded definition carries what DSH's skill registry validates. */
function assertCompleteDefinition(definition) {
  assert.equal(typeof definition.name, 'string')
  assert.equal(typeof definition.description, 'string')
  assert.equal(typeof definition.content, 'string')
  assert.equal(typeof definition.source, 'string')
  assert.equal(definition.source, 'bundled')
  assert.equal(typeof definition.provider, 'string')
  assert.equal(definition.provider, 'basemind')
  assert.equal(typeof definition.invocation, 'object')
  assert.notEqual(definition.invocation, null)
  assert.equal(typeof definition.invocation.modelInvocable, 'boolean')
  assert.equal(typeof definition.invocation.userInvocable, 'boolean')
  assert.equal(definition.invocation.modelInvocable, true)
  assert.equal(definition.invocation.userInvocable, true)
  assert.equal(definition.rank, 1000)
  assert.equal(typeof definition.locator, 'string')
  assert.equal(definition.locator, definition.name)
  assert.equal(definition.resourceBase.kind, 'directory')
}

test('get() returns the complete definition the DSH registry validates', async (t) => {
  const root = await withTree(t)
  const provider = createBasemindSkillProvider({ readiness: fakeReadiness(true), root })

  // A bare string candidate must still come back as a complete definition.
  const byString = await provider.get('basemind')
  assertCompleteDefinition(byString)
  assert.equal(byString.content, BODY)
  assert.equal(byString.path, path.join(root, 'skills', 'basemind', 'SKILL.md'))

  // An object candidate keeps its extra fields without losing the registry identity.
  const byCandidate = await provider.get({ name: 'basemind-code-search', origin: 'registry' })
  assertCompleteDefinition(byCandidate)
  assert.equal(byCandidate.content, BODY)
  assert.equal(byCandidate.origin, 'registry')
})

test('get() returns the body without frontmatter, and undefined for unknown names', async (t) => {
  const root = await withTree(t)
  const readiness = fakeReadiness(true)
  const provider = createBasemindSkillProvider({ readiness, root })

  const byString = await provider.get('basemind')
  assert.equal(byString.name, 'basemind')
  assert.equal(byString.description, 'Description for basemind')
  assert.equal(byString.content, BODY)
  assert.equal(byString.path, path.join(root, 'skills', 'basemind', 'SKILL.md'))

  const byCandidate = await provider.get({ name: 'basemind-code-search' })
  assert.equal(byCandidate.name, 'basemind-code-search')
  assert.equal(byCandidate.content, BODY)

  assert.equal(await provider.get('unknown-skill'), undefined)
  assert.equal(await provider.get({ name: 'unknown-skill' }), undefined)
  assert.equal(await provider.get({}), undefined)
  assert.equal(await provider.get(undefined), undefined)
})

test('missing SKILL.md files are skipped instead of failing the catalog', async (t) => {
  const names = UPSTREAM.skills.names.slice(0, 9)
  const root = await withTree(t, { names })
  const provider = createBasemindSkillProvider({ readiness: fakeReadiness(true), root })
  const entries = await provider.list()
  assert.equal(entries.length, 9)
  assert.equal(await provider.get(UPSTREAM.skills.names[9]), undefined)
})

test('a root without a skills directory yields an empty catalog, not an error', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-basemind-noskills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const provider = createBasemindSkillProvider({ readiness: fakeReadiness(true), root })
  assert.deepEqual(await provider.list(), [])
  assert.equal(await provider.get('basemind'), undefined)
})

test('the in-memory cache serves repeat list() calls after the file disappears', async (t) => {
  const root = await withTree(t)
  const provider = createBasemindSkillProvider({ readiness: fakeReadiness(true), root })
  const first = await provider.list()
  assert.equal(first.length, 10)

  await rm(path.join(root, 'skills', 'basemind', 'SKILL.md'))
  const second = await provider.list()
  assert.equal(second.length, 10)
  assert.equal((await provider.get('basemind')).content, BODY)
})

test('invalidate() delegates to the registry control exactly once per call', async (t) => {
  const root = await withTree(t)
  const calls = []
  const provider = createBasemindSkillProvider({
    readiness: fakeReadiness(true),
    root,
    control: { invalidate: () => calls.push('invalidate') },
  })
  provider.invalidate()
  provider.invalidate()
  assert.deepEqual(calls, ['invalidate', 'invalidate'])

  const throwing = createBasemindSkillProvider({
    readiness: fakeReadiness(true),
    root,
    control: { invalidate: () => { throw new Error('registry gone') } },
  })
  assert.doesNotThrow(() => throwing.invalidate())

  const bare = createBasemindSkillProvider({ readiness: fakeReadiness(true), root })
  assert.doesNotThrow(() => bare.invalidate())
})

test('a control object filled in after creation is honored', async (t) => {
  const root = await withTree(t)
  const control = {}
  const provider = createBasemindSkillProvider({ control, readiness: fakeReadiness(true), root })
  let calls = 0
  control.invalidate = () => {
    calls += 1
  }
  provider.invalidate()
  assert.equal(calls, 1)
})

test('a readiness object exposing a boolean ready flag is accepted', async (t) => {
  const root = await withTree(t)
  const provider = createBasemindSkillProvider({ readiness: { ready: true }, root })
  assert.equal((await provider.list()).length, 10)
  const closed = createBasemindSkillProvider({ readiness: { ready: false }, root })
  assert.deepEqual(await closed.list(), [])
})

test('the frontmatter parser tolerates BOM, CRLF, quotes, folded and literal blocks', () => {
  const crlf = '\uFEFF---\r\nname: one\r\ndescription: "Quoted text"\r\nlicense: MIT\r\n---\r\n# Body\r\ntext'
  const parsedCrlf = parseSkillFrontmatter(crlf)
  assert.equal(parsedCrlf.attributes.name, 'one')
  assert.equal(parsedCrlf.attributes.description, 'Quoted text')
  assert.equal(parsedCrlf.attributes.license, 'MIT')
  assert.equal(parsedCrlf.body, '# Body\ntext')

  const folded = parseSkillFrontmatter('---\ndescription: >\n  hello\n  world\n---\nbody')
  assert.equal(folded.attributes.description, 'hello world')

  const literal = parseSkillFrontmatter('---\ndescription: |\n  line one\n  line two\n---\nbody')
  assert.equal(literal.attributes.description, 'line one\nline two')

  const unknownKeys = parseSkillFrontmatter('---\nname: x\nunknown: value\nmetadata:\n  nested: y\ndescription: real\n---\nbody')
  assert.equal(unknownKeys.attributes.name, 'x')
  assert.equal(unknownKeys.attributes.description, 'real')
  assert.equal(unknownKeys.attributes.unknown, undefined)

  const bare = parseSkillFrontmatter('# Just markdown\nno frontmatter')
  assert.deepEqual(bare.attributes, {})
  assert.equal(bare.body, '# Just markdown\nno frontmatter')

  const unclosed = parseSkillFrontmatter('---\nname: x\ndescription: y')
  assert.deepEqual(unclosed.attributes, {})
  assert.equal(unclosed.body, '---\nname: x\ndescription: y')
})
