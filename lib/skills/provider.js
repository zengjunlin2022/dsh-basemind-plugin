/**
 * Skill provider for the vendored BaseMind skill set.
 *
 * DSH's skill registry already owns progressive disclosure (name + description
 * in the catalog, body loaded on demand) and rank-based conflict resolution, so
 * this module only supplies candidates and gated content. Files are read lazily
 * and cached in memory; the catalog is empty until the binary manager reports a
 * verified, compatible binary, which keeps the catalog honest when BaseMind is
 * unavailable.
 *
 * Vendored text is never edited here: the sync script owns `skills/**`.
 *
 * @module dsh-basemind-plugin/lib/skills/provider
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { skillsNames } from '../upstream.js'

/** Registry identity of this provider. */
const PROVIDER_NAME = 'basemind'

/** Lower than every filesystem layer (bundled 600 down to project 100) and runtime 250. */
const SKILL_RANK = 1000

/** Catalog source DSH assigns to first-party bundled content. */
const SOURCE_BUNDLED = 'bundled'

/** File read inside each skill directory. */
const SKILL_FILE = 'SKILL.md'

/** The only frontmatter keys this plugin reads. */
const KNOWN_KEYS = new Set(['name', 'description', 'license', 'metadata'])

/** A top-level frontmatter entry; indented lines are continuations. */
const KEY_LINE = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/

/** @param {unknown} value @returns {boolean} true for object literals only. */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Strip one pair of matching single or double quotes.
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Tolerant parser for the four frontmatter keys the plugin knows.
 *
 * Anything else is ignored, malformed lines are skipped, CRLF and a BOM are
 * accepted, folded (`>`) and literal (`|`) blocks are joined, and a file
 * without frontmatter keeps its whole text as the body.
 *
 * @param {unknown} text
 * @returns {{ attributes: Record<string, string>, body: string }}
 */
export function parseSkillFrontmatter(text) {
  const source =
    typeof text === 'string' ? text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') : ''
  const result = { attributes: {}, body: source }
  if (!source.startsWith('---\n')) return result

  const lines = source.split('\n')
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      close = index
      break
    }
  }
  if (close === -1) return result

  const attributes = {}
  let activeKey
  let blockMode = null

  for (let index = 1; index < close; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue

    const indented = line[0] === ' ' || line[0] === '\t'
    const match = indented ? null : KEY_LINE.exec(line)
    if (match !== null) {
      const key = match[1]
      const value = match[2].trim()
      activeKey = KNOWN_KEYS.has(key) ? key : undefined
      blockMode = value === '>' || value === '|' ? value : null
      if (activeKey === undefined) continue
      attributes[activeKey] = blockMode === null ? unquote(value) : ''
      continue
    }

    if (activeKey === undefined) continue
    const continuation = line.trim()
    if (continuation === '') continue
    const separator = blockMode === '|' ? '\n' : ' '
    attributes[activeKey] =
      attributes[activeKey] === '' ? continuation : attributes[activeKey] + separator + continuation
  }

  result.attributes = attributes
  result.body = lines.slice(close + 1).join('\n').replace(/^\n+/, '')
  return result
}

/**
 * Create the BaseMind skill provider.
 *
 * @param {{ control?: { invalidate?: () => void }, readiness?: { ok?: () => boolean, ready?: boolean },
 *           root?: string, logger?: any }} [options]
 * @returns {{ name: string, list: () => Promise<object[]>, get: (candidate: unknown) => Promise<object|undefined>, invalidate: () => void }}
 */
export function createBasemindSkillProvider(options) {
  const input = isPlainObject(options) ? options : {}
  const baseRoot = typeof input.root === 'string' && input.root !== '' ? input.root : '.'
  const skillsRoot = path.join(baseRoot, 'skills')
  const names = skillsNames()
  const nameSet = new Set(names)
  const control = input.control
  const readiness = input.readiness
  const logger = input.logger

  /** @type {Map<string, { name: string, description: string, content: string, path: string }|null>} */
  const cache = new Map()
  /** @type {Promise<void>|undefined} */
  let catalogPromise

  /** @returns {boolean} true only when the binary manager reports READY. */
  function isReady() {
    try {
      if (typeof readiness?.ok === 'function') return readiness.ok() === true
      if (typeof readiness?.ready === 'boolean') return readiness.ready
    } catch {
      return false
    }
    return false
  }

  /** @param {string} name */
  function skillPath(name) {
    return path.join(skillsRoot, name, SKILL_FILE)
  }

  /**
   * The registry definition for one loaded entry.
   *
   * DSH's skill registry validates every loaded definition and requires string
   * `source` and `provider` values plus an `invocation` object, so the catalog
   * fields and identity live in one place shared by `list()` and `get()`.
   *
   * @param {{ name: string, description: string, path: string }} entry
   * @returns {object}
   */
  function definitionEntry(entry) {
    return {
      name: entry.name,
      description: entry.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: SOURCE_BUNDLED,
      resourceBase: { kind: 'directory', path: skillsRoot },
      path: entry.path,
      rank: SKILL_RANK,
      locator: entry.name,
    }
  }

  /**
   * Load and cache one skill; a missing or unreadable file is cached as absent.
   * @param {string} name
   */
  async function loadEntry(name) {
    if (cache.has(name)) return cache.get(name)
    const filePath = skillPath(name)
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      const code = isPlainObject(error) || error instanceof Error ? error.code : undefined
      logger?.debug?.(
        '[dsh-basemind-plugin] skill ' +
          name +
          ' is unavailable (' +
          (typeof code === 'string' ? code : 'read failed') +
          '); skipped',
      )
      cache.set(name, null)
      return null
    }
    const parsed = parseSkillFrontmatter(text)
    const entry = {
      name,
      description:
        typeof parsed.attributes.description === 'string' ? parsed.attributes.description : '',
      content: parsed.body,
      path: filePath,
    }
    cache.set(name, entry)
    return entry
  }

  /** Load every known skill once; the promise is shared by concurrent callers. */
  async function loadCatalog() {
    if (catalogPromise === undefined) {
      catalogPromise = Promise.all(names.map((name) => loadEntry(name))).then(() => undefined)
    }
    return catalogPromise
  }

  return {
    name: PROVIDER_NAME,

    async list() {
      if (!isReady()) return []
      await loadCatalog()
      const entries = []
      for (const name of names) {
        const entry = cache.get(name)
        if (entry === undefined || entry === null) continue
        entries.push(definitionEntry(entry))
      }
      return entries
    },

    async get(candidate) {
      if (!isReady()) return undefined
      const name = typeof candidate === 'string'
        ? candidate
        : isPlainObject(candidate) && typeof candidate.name === 'string'
          ? candidate.name
          : undefined
      if (name === undefined || !nameSet.has(name)) return undefined
      const entry = await loadEntry(name)
      if (entry === undefined || entry === null) return undefined
      const candidateEntry = isPlainObject(candidate) ? candidate : {}
      return { ...candidateEntry, ...definitionEntry(entry), content: entry.content }
    },

    invalidate() {
      try {
        const result = control?.invalidate?.()
        if (result !== undefined && typeof result.catch === 'function') result.catch(() => {})
      } catch (error) {
        logger?.debug?.(
          '[dsh-basemind-plugin] skill catalog invalidate failed: ' +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    },
  }
}
