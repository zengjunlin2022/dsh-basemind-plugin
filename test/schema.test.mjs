import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  normalizeInputSchema,
  normalizeToolName,
  publicToolName,
  validateJsonSchemaNode,
} from '../lib/schema.js';

const fixtureUrl = new URL('../fixtures/basemind-0.29.3-tools.json', import.meta.url);
const tools = JSON.parse(readFileSync(fixtureUrl, 'utf8'));

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_NODE_KEYS = [
  '$schema',
  '$id',
  '$ref',
  'format',
  'minimum',
  'maximum',
  'pattern',
  'multipleOf',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'uniqueItems',
  'additionalItems',
  'definitions',
  '$defs',
  'anyOf',
  'allOf',
];

/**
 * Collects the keys of every schema *node* (property names inside `properties`
 * are data, not keywords, so they are traversed but not counted).
 *
 * @param {unknown} node
 * @param {Set<string>} [keys]
 * @returns {Set<string>}
 */
function schemaNodeKeys(node, keys = new Set()) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return keys;
  for (const key of Object.keys(node)) keys.add(key);
  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    for (const value of Object.values(node.properties)) schemaNodeKeys(value, keys);
  }
  if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
    schemaNodeKeys(node.items, keys);
  }
  if (Array.isArray(node.oneOf)) {
    for (const child of node.oneOf) schemaNodeKeys(child, keys);
  }
  return keys;
}

function hash8(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

test('unsupported JSON Schema keywords never reach the serialized output', () => {
  const normalized = normalizeInputSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: '#/root',
    $ref: '#/root',
    type: 'object',
    definitions: {},
    $defs: {},
    properties: {
      value: {
        type: 'string',
        format: 'uri',
        minimum: 0,
        maximum: 10,
        pattern: '^x$',
        multipleOf: 2,
        minLength: 1,
        maxLength: 5,
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
        items: { type: 'string' },
        anyOf: [{ type: 'string' }, { type: 'number' }],
      },
    },
  });

  const serialized = JSON.stringify(normalized);
  for (const token of [
    '$schema',
    '$id',
    '$ref',
    '"format"',
    '"minimum"',
    '"maximum"',
    '"pattern"',
    '"multipleOf"',
    '"minLength"',
    '"maxLength"',
    '"minItems"',
    '"maxItems"',
    '"uniqueItems"',
    '"definitions"',
    '"$defs"',
    '"anyOf"',
  ]) {
    assert.ok(!serialized.includes(token), `serialized output must not contain ${token}`);
  }
  assert.equal(normalized.properties.value.type, undefined);
  assert.deepEqual(normalized.properties.value.oneOf, [{ type: 'string' }, { type: 'number' }]);
});

test('normalizes every BaseMind 0.29.3 input schema to a valid DSH node', () => {
  assert.equal(tools.length, 9);
  for (const tool of tools) {
    const normalized = normalizeInputSchema(tool.inputSchema);

    assert.equal(normalized.type, 'object', `${tool.name} root must be an object`);
    assert.deepEqual(
      validateJsonSchemaNode(normalized),
      { ok: true },
      `${tool.name} must validate: ${JSON.stringify(validateJsonSchemaNode(normalized))}`,
    );

    const keys = schemaNodeKeys(normalized);
    for (const keyword of FORBIDDEN_NODE_KEYS) {
      assert.ok(!keys.has(keyword), `${tool.name} must not retain the ${keyword} keyword`);
    }

    const serialized = JSON.stringify(normalized);
    // `format` and `pattern` also name legitimate BaseMind parameters, and
    // `maximum` is an enum value, so those three are asserted at keyword level
    // above instead of with a raw substring search.
    for (const token of ['$schema', '"minimum"', '"anyOf"', '"allOf"', '"$ref"', '"$id"']) {
      assert.ok(!serialized.includes(token), `${tool.name} must not serialize ${token}`);
    }
  }
});

test('code tool keeps its 13-entry mode enum and required mode', () => {
  const code = tools.find((tool) => tool.name === 'code');
  assert.ok(code, 'code fixture must exist');

  const normalized = normalizeInputSchema(code.inputSchema);
  assert.equal(normalized.properties.mode.type, 'string');
  assert.deepEqual(normalized.properties.mode.enum, [
    'outline',
    'symbols',
    'grep',
    'files',
    'find',
    'definition',
    'references',
    'callers',
    'implementations',
    'dependents',
    'expand',
    'semantic',
    'chunk',
  ]);
  assert.equal(normalized.properties.mode.enum.length, 13);
  assert.ok(normalized.required.includes('mode'));
  assert.deepEqual(normalized.required, ['mode']);

  // Unsupported keywords are gone but legitimate parameters named `format`
  // and `pattern` survive as properties.
  assert.equal('format' in normalized.properties.format, false);
  assert.equal(normalized.properties.format.enum.length, 2);
  assert.equal(normalized.properties.pattern.type, 'string');
});

test('type arrays with null collapse to the single remaining type', () => {
  const code = normalizeInputSchema(tools.find((tool) => tool.name === 'code').inputSchema);
  assert.equal(code.properties.path.type, 'string');
  assert.equal(code.properties.path.default, null);
  assert.equal('oneOf' in code.properties.path, false);

  const admin = normalizeInputSchema(tools.find((tool) => tool.name === 'admin').inputSchema);
  assert.equal(admin.properties.paths.type, 'array');
  assert.deepEqual(admin.properties.paths.items, { type: 'string' });
  assert.equal(admin.properties.paths.default, null);
  assert.equal(admin.properties.full.type, 'boolean');
  assert.equal(admin.properties.target_tokens.type, 'integer');
});

test('non-object roots and unrepresentable roots become empty object schemas', () => {
  const empty = { type: 'object', properties: {} };
  const roots = [
    { type: 'string', description: 'text' },
    { type: 'array', items: { type: 'string' } },
    { type: ['string', 'null'] },
    { type: ['null'] },
    { type: ['string', 'integer'] },
    null,
    undefined,
    [],
    'not a schema',
    42,
    true,
    () => 'schema',
  ];
  for (const root of roots) {
    assert.deepEqual(normalizeInputSchema(root), empty, `root ${String(root)}`);
  }

  const objectRoot = { type: 'object', properties: { a: { type: 'string' } } };
  assert.deepEqual(normalizeInputSchema(objectRoot), objectRoot);
});

test('nested multi-type schemas become oneOf and keep sibling metadata', () => {
  const normalized = normalizeInputSchema({
    type: 'object',
    properties: {
      value: {
        description: 'either a string or an integer',
        type: ['string', 'integer'],
        default: null,
      },
    },
  });
  const value = normalized.properties.value;
  assert.equal(value.description, 'either a string or an integer');
  assert.equal(value.default, null);
  assert.equal(value.type, undefined);
  assert.deepEqual(value.oneOf, [{ type: 'string' }, { type: 'integer' }]);
});

test('anyOf collapses a single branch and maps multiple branches to oneOf', () => {
  const single = normalizeInputSchema({
    type: 'object',
    properties: { value: { anyOf: [{ type: 'string' }], description: 'single' } },
  });
  assert.deepEqual(single.properties.value, { type: 'string', description: 'single' });

  const multi = normalizeInputSchema({
    type: 'object',
    properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
  });
  assert.equal(multi.properties.value.type, undefined);
  assert.deepEqual(multi.properties.value.oneOf, [{ type: 'string' }, { type: 'number' }]);
});

test('allOf keeps a single branch and degrades multiple branches to description only', () => {
  const single = normalizeInputSchema({
    type: 'object',
    properties: { value: { allOf: [{ type: 'integer', minimum: 0, maximum: 10 }] } },
  });
  assert.deepEqual(single.properties.value, { type: 'integer' });

  const multi = normalizeInputSchema({
    type: 'object',
    properties: {
      value: { allOf: [{ type: 'string' }, { type: 'number' }], description: 'either' },
    },
  });
  assert.deepEqual(multi.properties.value, { description: 'either' });

  const multiNoDescription = normalizeInputSchema({
    type: 'object',
    properties: {
      value: { allOf: [{ type: 'string' }, { type: 'number' }], title: 'Either' },
    },
  });
  assert.deepEqual(multiNoDescription.properties.value, {
    title: 'Either',
    description: 'unconstrained JSON value',
  });
});

test('hostile schemas never throw and stay inside the DSH vocabulary', () => {
  let deeplyNested = { type: 'string' };
  for (let index = 0; index < 200; index += 1) {
    deeplyNested = { type: 'object', properties: { child: deeplyNested } };
  }
  const nestedResult = normalizeInputSchema(deeplyNested);
  assert.equal(nestedResult.type, 'object');
  assert.ok(validateJsonSchemaNode(nestedResult).ok);

  const required = normalizeInputSchema({
    type: 'object',
    properties: { keep: { type: 'string' } },
    required: ['keep', 'missing', '0', 0, null],
  });
  assert.deepEqual(required.required, ['keep']);

  const enumResult = normalizeInputSchema({
    type: 'object',
    properties: {
      value: { type: 'string', enum: ['ok', { nested: true }, null, 3, () => 1, NaN] },
    },
  });
  assert.deepEqual(enumResult.properties.value.enum, ['ok', null, 3]);

  const defaults = normalizeInputSchema({
    type: 'object',
    properties: {
      a: { type: 'string', default: undefined },
      b: { type: 'string', default: () => 1 },
      c: { type: 'string', default: Infinity },
      d: { type: 'string', examples: [undefined] },
      e: { type: 'string', examples: [{ ok: true }] },
    },
  });
  assert.equal('default' in defaults.properties.a, false);
  assert.equal('default' in defaults.properties.b, false);
  assert.equal('default' in defaults.properties.c, false);
  assert.equal('examples' in defaults.properties.d, false);
  assert.deepEqual(defaults.properties.e.examples, [{ ok: true }]);

  const unrecognized = normalizeInputSchema({
    type: 'object',
    properties: { value: { minimum: 0, pattern: '^x$', format: 'uri' } },
  });
  assert.deepEqual(unrecognized.properties.value, {
    description: 'unconstrained JSON value',
  });

  const cyclic = { type: 'object', properties: {} };
  cyclic.properties.self = cyclic;
  const cyclicResult = normalizeInputSchema(cyclic);
  assert.equal(cyclicResult.type, 'object');
  assert.ok(validateJsonSchemaNode(cyclicResult).ok);

  const hostileKeys = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}}}',
  );
  const hostileResult = normalizeInputSchema(hostileKeys);
  assert.equal(Object.getPrototypeOf(hostileResult.properties), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(hostileResult.properties, '__proto__'));
  assert.equal(hostileResult.properties.__proto__.type, 'string');
  assert.equal(hostileResult.properties.constructor.type, 'number');
  assert.ok(validateJsonSchemaNode(hostileResult).ok);
});

test('normalizeToolName preserves valid names and sanitizes invalid ones', () => {
  assert.equal(normalizeToolName('code'), 'code');
  assert.equal(normalizeToolName('mcp__basemind__admin'), 'mcp__basemind__admin');
  assert.equal(normalizeToolName('foo bar/baz'), 'foo_bar_baz');
  assert.equal(normalizeToolName('a.b:c$d'), 'a_b_c_d');

  const unicode = normalizeToolName('naïve-工具');
  assert.match(unicode, SAFE_NAME);
  assert.ok(unicode.length <= 64);

  assert.equal(normalizeToolName('.'.repeat(64)), '_'.repeat(64));

  const empty = normalizeToolName('');
  assert.match(empty, SAFE_NAME);
  assert.equal(empty, `_${hash8('')}`);

  const long = 'x'.repeat(100);
  const longNormalized = normalizeToolName(long);
  assert.equal(longNormalized.length, 64);
  assert.equal(longNormalized, `${'x'.repeat(55)}_${hash8(long)}`);
  assert.match(longNormalized, SAFE_NAME);

  assert.equal(normalizeToolName('b'.repeat(65)).length, 64);

  const exact = 'a'.repeat(64);
  assert.equal(normalizeToolName(exact), exact);
});

test('publicToolName composes names and truncates over-long ones', () => {
  assert.equal(publicToolName('basemind', 'code'), 'mcp__basemind__code');
  assert.equal(publicToolName('basemind', 'git'), 'mcp__basemind__git');
  assert.equal(publicToolName('basemind', 'a b'), 'mcp__basemind__a_b');

  const raw = 'z'.repeat(120);
  const name = publicToolName('basemind', raw);
  assert.ok(name.length <= 64);
  assert.ok(name.startsWith('mcp__basemind__'));
  assert.ok(name.endsWith(`_${hash8(raw)}`));
  assert.match(name, SAFE_NAME);

  const sibling = publicToolName('basemind', `${'z'.repeat(119)}y`);
  assert.notEqual(name, sibling);
  assert.ok(sibling.length <= 64);

  const rawPart = 'a'.repeat(64 - 'mcp__s__'.length);
  const exact = publicToolName('s', rawPart);
  assert.equal(exact, `mcp__s__${rawPart}`);
  assert.equal(exact.length, 64);
});

test('validateJsonSchemaNode accepts nodes inside the vocabulary', () => {
  assert.deepEqual(validateJsonSchemaNode({}), { ok: true });
  assert.deepEqual(validateJsonSchemaNode({ description: 'unconstrained JSON value' }), {
    ok: true,
  });
  assert.deepEqual(
    validateJsonSchemaNode({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    { ok: true },
  );
  assert.deepEqual(
    validateJsonSchemaNode({
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'either',
    }),
    { ok: true },
  );
});

test('validateJsonSchemaNode reports every category of violation with a path', () => {
  const cases = [
    { node: { type: 'object', properties: { a: { type: 'string' } }, bogus: true }, path: 'bogus' },
    { node: { type: 'object', properties: { a: { type: ['string', 'null'] } } }, path: 'properties.a.type' },
    { node: { type: 'object', properties: { a: { type: 'unknown' } } }, path: 'properties.a.type' },
    { node: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, path: 'required[0]' },
    { node: { type: 'object', properties: {}, required: 'a' }, path: 'required' },
    { node: { type: 'object', properties: { a: { type: 'string' } }, required: [1] }, path: 'required[0]' },
    { node: { type: 'object', properties: { a: { type: 'string', enum: [] } } }, path: 'properties.a.enum' },
    { node: { type: 'object', properties: { a: { type: 'string', enum: [{ x: 1 }] } } }, path: 'properties.a.enum[0]' },
    { node: { oneOf: [{ type: 'string' }, 42] }, path: 'oneOf[1]' },
    { node: { oneOf: 'nope' }, path: 'oneOf' },
    { node: { type: 'object', additionalProperties: 'yes' }, path: 'additionalProperties' },
    { node: { type: 'object', properties: { a: { default: undefined } } }, path: 'properties.a.default' },
    { node: { type: 'object', properties: { a: { examples: [() => 1] } } }, path: 'properties.a.examples' },
    { node: { type: 'object', properties: { a: { items: [{ type: 'string' }] } } }, path: 'properties.a.items' },
    { node: { type: 'object', properties: { a: { description: 5 } } }, path: 'properties.a.description' },
    { node: { type: 'object', properties: { a: { const: { x: 1 } } } }, path: 'properties.a.const' },
    { node: { type: 'object', properties: { a: { enum: [NaN] } } }, path: 'properties.a.enum[0]' },
    { node: null, path: '(root)' },
  ];

  for (const { node, path } of cases) {
    const result = validateJsonSchemaNode(node);
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(node)}`);
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.some((error) => error.includes(path)),
      `expected an error containing ${path} in ${JSON.stringify(result.errors)}`,
    );
  }
});
