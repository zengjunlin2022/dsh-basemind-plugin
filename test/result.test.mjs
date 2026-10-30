import test from 'node:test';
import assert from 'node:assert/strict';

import { projectContent, projectMcpContent, resultText } from '../lib/result.js';

const BASE64_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Asserts the DSH output contract: a non-empty array of text-only blocks whose
 * only own keys are `type` and `text`.
 *
 * @param {unknown} blocks
 */
function assertTextBlocks(blocks) {
  assert.ok(Array.isArray(blocks), 'blocks must be an array');
  assert.ok(blocks.length > 0, 'blocks must not be empty');
  for (const block of blocks) {
    assert.deepEqual(Object.keys(block).sort(), ['text', 'type']);
    assert.equal(block.type, 'text');
    assert.equal(typeof block.text, 'string');
  }
}

test('text blocks keep their original order and win over value.text', () => {
  const blocks = projectContent({
    text: 'fallback',
    content: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  });
  assert.deepEqual(blocks, [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ]);
  assertTextBlocks(blocks);
});

test('resource_link projects to a readable text block', () => {
  assert.deepEqual(
    projectMcpContent([
      { type: 'resource_link', name: 'basemind status', uri: 'basemind://status' },
    ]),
    [{ type: 'text', text: 'Resource link: basemind status (basemind://status)' }],
  );

  const unavailable = '[resource link unavailable: the MCP block is missing its name or URI]';
  assert.deepEqual(projectMcpContent([{ type: 'resource_link', uri: 'basemind://status' }]), [
    { type: 'text', text: unavailable },
  ]);
  assert.deepEqual(projectMcpContent([{ type: 'resource_link', name: 'status' }]), [
    { type: 'text', text: unavailable },
  ]);
  assert.deepEqual(projectMcpContent([{ type: 'resource_link' }]), [
    { type: 'text', text: unavailable },
  ]);
  assert.deepEqual(projectMcpContent([{ type: 'resource_link', name: '', uri: '' }]), [
    { type: 'text', text: unavailable },
  ]);
});

test('image blocks never leak the base64 payload', () => {
  const blocks = projectContent({
    content: [{ type: 'image', data: BASE64_PNG, mimeType: 'image/png' }],
  });
  assert.deepEqual(blocks, [
    { type: 'text', text: '[image result: image/png; not projected into model context]' },
  ]);
  assert.ok(!JSON.stringify(blocks).includes(BASE64_PNG));
  assert.ok(!JSON.stringify(blocks).includes('iVBORw0KGgo'));
  assert.ok(!blocks.some((block) => block.type === 'image'));
  assertTextBlocks(blocks);

  const unknownMime = projectMcpContent([{ type: 'image', data: BASE64_PNG }]);
  assert.deepEqual(unknownMime, [
    {
      type: 'text',
      text: '[image result: unknown media type; not projected into model context]',
    },
  ]);
  assert.ok(!JSON.stringify(unknownMime).includes(BASE64_PNG));
});

test('audio blocks become an explicit unsupported diagnostic', () => {
  const blocks = projectContent({
    content: [{ type: 'audio', data: BASE64_PNG, mimeType: 'audio/wav' }],
  });
  assert.equal(blocks.length, 1);
  const [block] = blocks;
  assert.ok(block.text.startsWith('[audio result unsupported:'));
  assert.ok(block.text.includes('audio/wav'));
  assert.ok(!block.text.includes(BASE64_PNG));
  assertTextBlocks(blocks);
});

test('embedded resources become an explicit unsupported diagnostic', () => {
  const blocks = projectContent({
    content: [
      {
        type: 'resource',
        resource: { uri: 'file:///secret.txt', blob: 'SECRETBLOB', text: 'SECRETTEXT' },
        mimeType: 'text/plain',
      },
    ],
  });
  assert.equal(blocks.length, 1);
  const [block] = blocks;
  assert.ok(block.text.startsWith('[embedded resource unsupported;'));
  assert.ok(!block.text.includes('SECRETBLOB'));
  assert.ok(!block.text.includes('SECRETTEXT'));
  assertTextBlocks(blocks);
});

test('unknown and malformed blocks become diagnostics instead of throwing', () => {
  assert.deepEqual(projectMcpContent([{ type: 'mystery', data: 'x' }]), [
    { type: 'text', text: '[unsupported MCP content type: mystery]' },
  ]);
  assert.deepEqual(projectMcpContent([{}]), [
    { type: 'text', text: '[unsupported MCP content type: unknown]' },
  ]);
  assert.deepEqual(projectMcpContent([{ type: 42 }]), [
    { type: 'text', text: '[unsupported MCP content type: unknown]' },
  ]);

  for (const block of [null, 'text', 42, true, [1, 2]]) {
    const blocks = projectMcpContent([block]);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].text.startsWith('[unsupported MCP content block:'));
    assertTextBlocks(blocks);
  }
  assert.ok(projectMcpContent([null])[0].text.includes('null'));
  assert.ok(projectMcpContent([[1, 2]])[0].text.includes('array'));
  assert.ok(projectMcpContent(['text'])[0].text.includes('string'));
});

test('empty or non-array content falls back to value.text', () => {
  assert.deepEqual(projectContent({ text: 'hello', content: [] }), [
    { type: 'text', text: 'hello' },
  ]);
  assert.deepEqual(projectContent({ text: 'hello', content: 'not-an-array' }), [
    { type: 'text', text: 'hello' },
  ]);
  assert.deepEqual(projectContent({ text: 'hello', content: {} }), [
    { type: 'text', text: 'hello' },
  ]);
  assert.deepEqual(projectContent({ text: 'hello' }), [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(projectContent({ text: '' }), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectContent({}), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectContent({ content: [] }), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectContent({ content: null }), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectContent(undefined), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectContent(null), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectContent('bare string'), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectContent({ text: 42 }), [{ type: 'text', text: '' }]);
});

test('projectMcpContent always returns at least one text block', () => {
  assert.deepEqual(projectMcpContent([]), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectMcpContent(undefined), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectMcpContent(null), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectMcpContent({}), [{ type: 'text', text: '' }]);
  assert.deepEqual(projectMcpContent('nope'), [{ type: 'text', text: '' }]);
  assertTextBlocks(projectMcpContent([]));
});

test('resultText joins projected text and is empty-safe', () => {
  assert.equal(
    resultText({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    }),
    'a\nb',
  );
  assert.equal(
    resultText({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: BASE64_PNG, mimeType: 'image/png' },
      ],
    }),
    'a\n[image result: image/png; not projected into model context]',
  );
  assert.equal(resultText({ text: 'solo' }), 'solo');
  assert.equal(resultText({ content: [] }), '');
  assert.equal(resultText({ text: '' }), '');
  assert.equal(resultText(null), '');
  assert.equal(resultText(undefined), '');
  assert.equal(resultText(42), '');
  assert.equal(resultText('string'), '');
  assert.equal(resultText({ text: 123 }), '');
  assert.equal(resultText({ content: [{ type: 'text' }] }), '');
  assert.equal(resultText({ isError: true, content: [{ type: 'text', text: 'boom' }] }), 'boom');

  const cyclic = { text: 'loop' };
  cyclic.content = [cyclic];
  assert.doesNotThrow(() => resultText(cyclic));
  assert.equal(typeof resultText(cyclic), 'string');
});

test('every projected block is a text block with only type and text', () => {
  const samples = [
    projectContent({ text: 'x' }),
    projectContent({ content: [{ type: 'image', data: BASE64_PNG, mimeType: 'image/png' }] }),
    projectContent({
      content: [
        { type: 'resource_link', name: 'n', uri: 'u' },
        { type: 'text', text: 't' },
        { type: 'audio', data: BASE64_PNG, mimeType: 'audio/wav' },
        { type: 'resource', resource: { blob: BASE64_PNG } },
        { type: 'future-block' },
        null,
      ],
    }),
    projectMcpContent([]),
  ];
  for (const blocks of samples) assertTextBlocks(blocks);
});
