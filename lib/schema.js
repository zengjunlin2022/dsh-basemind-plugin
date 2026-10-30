/**
 * JSON Schema normalization for DSH tool parameters.
 *
 * BaseMind (MCP) publishes draft 2020-12 schemas that use keywords DSH's
 * restricted `JsonSchemaNode` does not understand (`format`, numeric bounds,
 * `pattern`, type arrays, `anyOf`, `allOf`, `$ref`, ...). Everything here
 * reduces such a schema to the strict DSH vocabulary:
 *
 *   type, oneOf, properties, required, additionalProperties, items,
 *   enum, const, description, title, default, examples
 *
 * The normalizer is defensive: it never throws, never emits `undefined` or
 * non-JSON values, and always produces a root `{ type: 'object', ... }` node.
 *
 * @module dsh-basemind-plugin/lib/schema
 */

import { createHash } from 'node:crypto';

const ALLOWED_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ALLOWED_TYPE_SET = new Set(ALLOWED_TYPES);
const SCALAR_TYPE_SET = new Set(['string', 'number', 'integer', 'boolean', 'null']);

const UNCONSTRAINED_DESCRIPTION = 'unconstrained JSON value';
const MAX_DEPTH = 32;
const MAX_JSON_DEPTH = 64;

const ALLOWED_NODE_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);
const ALLOWED_KEY_LIST = [...ALLOWED_NODE_KEYS].join(', ');

const HASH_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 8;

/**
 * @param {unknown} value
 * @returns {boolean} true for `{}`-like objects only (no arrays, no class instances).
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Defines an own enumerable property without triggering setters such as
 * `Object.prototype.__proto__`, so hostile property names stay inert data.
 *
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 */
function setKey(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * @param {object} target
 * @param {string} key
 * @returns {boolean}
 */
function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * @param {ArrayLike<unknown>} list
 * @param {unknown} value
 * @returns {boolean}
 */
function includesValue(list, value) {
  return Array.prototype.indexOf.call(list, value) !== -1;
}

/**
 * @param {unknown} value
 * @returns {boolean} true for values allowed by JSON Schema `enum` / `const`.
 */
function isScalar(value) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  return false;
}

/**
 * @param {unknown} value
 * @param {Set<object>} [seen]
 * @param {number} [depth]
 * @returns {boolean} true when `value` is a JSON-serializable value.
 */
function isJsonValue(value, seen = new Set(), depth = 0) {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let ok = true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item, seen, depth + 1)) {
        ok = false;
        break;
      }
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (!isJsonValue(value[key], seen, depth + 1)) {
        ok = false;
        break;
      }
    }
  } else {
    ok = false;
  }
  seen.delete(value);
  return ok;
}

/**
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>} fresh object with the same own entries.
 */
function copyEntries(source) {
  const out = {};
  for (const key of Object.keys(source)) setKey(out, key, source[key]);
  return out;
}

/**
 * @param {ArrayLike<unknown>} values
 * @returns {unknown[]} scalar-only, order-preserving enum values.
 */
function filterScalars(values) {
  const out = [];
  for (const value of values) {
    if (isScalar(value)) out.push(value);
  }
  return out;
}

/**
 * Copies description / title / default / examples from `source` into `target`
 * without overwriting keys the target already has.
 *
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function fillGenericKeys(target, source) {
  for (const key of Object.keys(source)) {
    if (!hasOwn(target, key)) setKey(target, key, source[key]);
  }
}

/**
 * Normalizes a single schema node.
 *
 * @param {unknown} node
 * @param {number} depth
 * @param {Record<string, unknown>} [generics]
 * @returns {Record<string, unknown>}
 */
function normalizeNode(node, depth, generics) {
  if (depth > MAX_DEPTH || !isPlainObject(node)) {
    return { description: UNCONSTRAINED_DESCRIPTION };
  }

  const inherited = generics ?? {};
  const collected = {};
  if (typeof node.description === 'string') collected.description = node.description;
  if (typeof node.title === 'string') collected.title = node.title;
  if (hasOwn(node, 'default') && isJsonValue(node.default)) collected.default = node.default;
  if (hasOwn(node, 'examples') && isJsonValue(node.examples)) collected.examples = node.examples;
  for (const key of Object.keys(collected)) {
    if (!hasOwn(inherited, key)) inherited[key] = collected[key];
  }

  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    return normalizeAnyOf(node, depth, inherited);
  }
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    return normalizeAllOf(node, depth);
  }

  let types = null;
  if (typeof node.type === 'string') {
    if (ALLOWED_TYPE_SET.has(node.type)) types = [node.type];
  } else if (Array.isArray(node.type)) {
    types = [];
    for (const entry of node.type) {
      if (
        typeof entry === 'string' &&
        entry !== 'null' &&
        ALLOWED_TYPE_SET.has(entry) &&
        !includesValue(types, entry)
      ) {
        types.push(entry);
      }
    }
  }

  if (types === null) return normalizeUntyped(node, depth, inherited);
  if (types.length === 0) {
    return {
      description:
        typeof node.description === 'string' ? node.description : UNCONSTRAINED_DESCRIPTION,
    };
  }
  if (types.length > 1) {
    const out = copyEntries(inherited);
    out.oneOf = types.map((type) => normalizeTypedNode(node, type, depth + 1));
    return out;
  }
  return normalizeTypedNode(node, types[0], depth + 1, inherited);
}

/**
 * Normalizes a node whose `type` is known to be exactly `type`.
 *
 * @param {Record<string, unknown>} node
 * @param {string} type
 * @param {number} depth
 * @param {Record<string, unknown>} [generics]
 * @returns {Record<string, unknown>}
 */
function normalizeTypedNode(node, type, depth, generics) {
  const out = generics ? copyEntries(generics) : {};
  out.type = type;

  if (type === 'object') {
    const properties = {};
    if (isPlainObject(node.properties)) {
      for (const key of Object.keys(node.properties)) {
        setKey(properties, key, normalizeNode(node.properties[key], depth));
      }
    }
    out.properties = properties;

    if (Array.isArray(node.required)) {
      const required = [];
      for (const entry of node.required) {
        if (typeof entry === 'string' && hasOwn(properties, entry) && !includesValue(required, entry)) {
          required.push(entry);
        }
      }
      if (required.length > 0) out.required = required;
    }

    if (typeof node.additionalProperties === 'boolean') {
      out.additionalProperties = node.additionalProperties;
    }
    return out;
  }

  if (type === 'array') {
    if (isPlainObject(node.items)) {
      out.items = normalizeNode(node.items, depth);
    }
    return out;
  }

  if (SCALAR_TYPE_SET.has(type)) {
    if (Array.isArray(node.enum)) {
      const enumValues = filterScalars(node.enum);
      if (enumValues.length > 0) out.enum = enumValues;
    }
    if (hasOwn(node, 'const') && isScalar(node.const)) out.const = node.const;
  }
  return out;
}

/**
 * Normalizes a node that has no usable `type` keyword by inferring the closest
 * representable shape from its remaining vocabulary.
 *
 * @param {Record<string, unknown>} node
 * @param {number} depth
 * @param {Record<string, unknown>} generics
 * @returns {Record<string, unknown>}
 */
function normalizeUntyped(node, depth, generics) {
  const looksLikeObject =
    isPlainObject(node.properties) ||
    Array.isArray(node.required) ||
    typeof node.additionalProperties === 'boolean';
  if (looksLikeObject) return normalizeTypedNode(node, 'object', depth, generics);

  if (isPlainObject(node.items)) return normalizeTypedNode(node, 'array', depth, generics);

  const out = copyEntries(generics);

  if (Array.isArray(node.enum)) {
    const enumValues = filterScalars(node.enum);
    if (enumValues.length > 0) out.enum = enumValues;
  }
  if (hasOwn(node, 'const') && isScalar(node.const)) out.const = node.const;

  if (out.enum === undefined && out.const === undefined) {
    return {
      description:
        typeof node.description === 'string' ? node.description : UNCONSTRAINED_DESCRIPTION,
    };
  }
  return out;
}

/**
 * @param {Record<string, unknown>} node
 * @param {number} depth
 * @param {Record<string, unknown>} generics
 * @returns {Record<string, unknown>}
 */
function normalizeAnyOf(node, depth, generics) {
  const branches = node.anyOf;
  if (branches.length === 1) {
    const result = normalizeNode(branches[0], depth + 1);
    fillGenericKeys(result, generics);
    return result;
  }
  const out = copyEntries(generics);
  out.oneOf = branches.map((branch) => normalizeNode(branch, depth + 1));
  return out;
}

/**
 * @param {Record<string, unknown>} node
 * @param {number} depth
 * @returns {Record<string, unknown>}
 */
function normalizeAllOf(node, depth) {
  const branches = node.allOf;
  if (branches.length === 1) {
    const result = normalizeNode(branches[0], depth + 1);
    if (typeof node.description === 'string' && typeof result.description !== 'string') {
      result.description = node.description;
    }
    if (typeof node.title === 'string' && typeof result.title !== 'string') {
      result.title = node.title;
    }
    return result;
  }

  const out = {};
  if (typeof node.title === 'string') out.title = node.title;
  out.description =
    typeof node.description === 'string' ? node.description : UNCONSTRAINED_DESCRIPTION;
  return out;
}

/**
 * Normalizes an MCP `inputSchema` into a DSH-safe `JsonSchemaNode`.
 *
 * Never throws for any JSON input; the root is always `type: 'object'`.
 *
 * @param {unknown} schema
 * @returns {{ type: 'object', properties: Record<string, unknown> } | Record<string, unknown>}
 */
export function normalizeInputSchema(schema) {
  try {
    if (!isPlainObject(schema)) return { type: 'object', properties: {} };
    const normalized = normalizeNode(schema, 0);
    if (!isPlainObject(normalized) || normalized.type !== 'object') {
      return { type: 'object', properties: {} };
    }
    if (!isPlainObject(normalized.properties)) normalized.properties = {};
    return normalized;
  } catch {
    return { type: 'object', properties: {} };
  }
}

/**
 * @param {string} rawName
 * @returns {string} first 8 hex characters of the SHA-256 digest of `rawName`.
 */
function shortHash(rawName) {
  return createHash('sha256').update(rawName).digest('hex').slice(0, HASH_SUFFIX_LENGTH);
}

/**
 * Normalizes a BaseMind tool name to the DSH-safe `[A-Za-z0-9_-]{1,64}` form.
 *
 * Long or empty sanitized names are truncated to 55 characters plus `_` and an
 * 8-hex SHA-256 suffix of the raw name, keeping them unique and 64 chars long.
 *
 * @param {unknown} rawName
 * @returns {string}
 */
export function normalizeToolName(rawName) {
  const raw = typeof rawName === 'string' ? rawName : String(rawName ?? '');
  if (HASH_PATTERN.test(raw)) return raw;

  let sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (sanitized.length === 0 || sanitized.length > MAX_TOOL_NAME_LENGTH) {
    sanitized = `${sanitized.slice(0, 55)}_${shortHash(raw)}`;
  }
  return sanitized;
}

/**
 * Builds the public DSH tool name `mcp__${serverName}__${normalizedRawName}`.
 *
 * When the composition exceeds 64 characters the normalized raw part is
 * truncated and suffixed with an 8-hex SHA-256 hash of the raw name so the
 * result stays <= 64 characters and unique per raw name.
 *
 * @param {string} serverName
 * @param {string} rawName
 * @returns {string}
 */
export function publicToolName(serverName, rawName) {
  const server = typeof serverName === 'string' ? serverName : String(serverName ?? '');
  const raw = typeof rawName === 'string' ? rawName : String(rawName ?? '');
  const normalized = normalizeToolName(raw);
  const prefix = `mcp__${server}__`;
  const full = `${prefix}${normalized}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;

  const hash = shortHash(raw);
  const budget = MAX_TOOL_NAME_LENGTH - prefix.length - (HASH_SUFFIX_LENGTH + 1);
  if (budget >= 1) {
    return `${prefix}${normalized.slice(0, budget)}_${hash}`;
  }

  // Pathological server names leave no room for the raw part; keep a safe,
  // length-bounded prefix so the emitted name still satisfies the contract.
  const safePrefix = prefix.slice(0, MAX_TOOL_NAME_LENGTH - (HASH_SUFFIX_LENGTH + 1)).replace(
    /[^A-Za-z0-9_-]/g,
    '_',
  );
  return `${safePrefix}_${hash}`;
}

/**
 * @param {string} base
 * @param {string} key
 * @returns {string}
 */
function joinPath(base, key) {
  return base.length === 0 ? key : `${base}.${key}`;
}

/**
 * @param {string} path
 * @returns {string}
 */
function pathLabel(path) {
  return path.length === 0 ? '(root)' : path;
}

/**
 * Recursively validates a node against DSH's strict `JsonSchemaNode` vocabulary.
 *
 * @param {unknown} node
 * @param {string} path
 * @param {string[]} errors
 * @param {number} depth
 * @param {Set<object>} ancestors
 */
function validateNode(node, path, errors, depth, ancestors) {
  if (depth > 100) {
    errors.push(`${pathLabel(path)}: exceeds the maximum supported nesting depth`);
    return;
  }
  if (!isPlainObject(node)) {
    errors.push(`${pathLabel(path)}: must be a JSON Schema object`);
    return;
  }
  if (ancestors.has(node)) {
    errors.push(`${pathLabel(path)}: must not contain circular references`);
    return;
  }
  ancestors.add(node);

  for (const key of Object.keys(node)) {
    if (!ALLOWED_NODE_KEYS.has(key)) {
      errors.push(
        `${joinPath(path, key)}: unknown key; allowed keys are ${ALLOWED_KEY_LIST}`,
      );
    }
  }

  if (hasOwn(node, 'type')) {
    if (typeof node.type !== 'string' || !ALLOWED_TYPE_SET.has(node.type)) {
      errors.push(
        `${joinPath(path, 'type')}: must be a single string, one of ${ALLOWED_TYPES.join(', ')}`,
      );
    }
  }

  if (hasOwn(node, 'description') && typeof node.description !== 'string') {
    errors.push(`${joinPath(path, 'description')}: must be a string`);
  }
  if (hasOwn(node, 'title') && typeof node.title !== 'string') {
    errors.push(`${joinPath(path, 'title')}: must be a string`);
  }

  if (hasOwn(node, 'properties')) {
    const propertiesPath = joinPath(path, 'properties');
    if (!isPlainObject(node.properties)) {
      errors.push(`${propertiesPath}: must be a JSON object`);
    } else {
      for (const key of Object.keys(node.properties)) {
        validateNode(node.properties[key], joinPath(propertiesPath, key), errors, depth + 1, ancestors);
      }
    }
  }

  if (hasOwn(node, 'required')) {
    const requiredPath = joinPath(path, 'required');
    if (!Array.isArray(node.required)) {
      errors.push(`${requiredPath}: must be an array of strings`);
    } else {
      const properties = isPlainObject(node.properties) ? node.properties : null;
      for (let index = 0; index < node.required.length; index += 1) {
        const entry = node.required[index];
        const entryPath = `${requiredPath}[${index}]`;
        if (typeof entry !== 'string') {
          errors.push(`${entryPath}: must be a string`);
        } else if (properties === null || !hasOwn(properties, entry)) {
          errors.push(`${entryPath}: references "${entry}", which is not declared in properties`);
        }
      }
    }
  }

  if (
    hasOwn(node, 'additionalProperties') &&
    typeof node.additionalProperties !== 'boolean'
  ) {
    errors.push(`${joinPath(path, 'additionalProperties')}: must be a boolean`);
  }

  if (hasOwn(node, 'items')) {
    validateNode(node.items, joinPath(path, 'items'), errors, depth + 1, ancestors);
  }

  if (hasOwn(node, 'enum')) {
    const enumPath = joinPath(path, 'enum');
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      errors.push(`${enumPath}: must be a non-empty array of scalars`);
    } else {
      for (let index = 0; index < node.enum.length; index += 1) {
        if (!isScalar(node.enum[index])) {
          errors.push(`${enumPath}[${index}]: must be a string, number, boolean, or null`);
        }
      }
    }
  }

  if (hasOwn(node, 'const') && !isScalar(node.const)) {
    errors.push(`${joinPath(path, 'const')}: must be a string, number, boolean, or null`);
  }

  if (hasOwn(node, 'default') && !isJsonValue(node.default)) {
    errors.push(`${joinPath(path, 'default')}: must be a JSON value`);
  }

  if (hasOwn(node, 'examples') && !isJsonValue(node.examples)) {
    errors.push(`${joinPath(path, 'examples')}: must be a JSON value`);
  }

  if (hasOwn(node, 'oneOf')) {
    const oneOfPath = joinPath(path, 'oneOf');
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) {
      errors.push(`${oneOfPath}: must be a non-empty array of JSON Schema objects`);
    } else {
      for (let index = 0; index < node.oneOf.length; index += 1) {
        validateNode(node.oneOf[index], `${oneOfPath}[${index}]`, errors, depth + 1, ancestors);
      }
    }
  }

  ancestors.delete(node);
}

/**
 * Strictly validates a normalized schema against the DSH `JsonSchemaNode`
 * vocabulary. Returns every violation found, with path-prefixed messages
 * (for example `properties.mode.enum: ...`).
 *
 * @param {unknown} node
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateJsonSchemaNode(node) {
  const errors = [];
  try {
    validateNode(node, '', errors, 0, new Set());
  } catch (error) {
    errors.push(`${pathLabel('')}: validation failed unexpectedly: ${String(error)}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
