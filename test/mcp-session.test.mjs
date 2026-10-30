import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpSession } from '../lib/mcp-session.js';

const HANDSHAKE = {
  protocolVersion: '2025-06-18',
  serverInfo: { name: 'basemind', version: '0.29.3' },
  capabilities: { tools: { listChanged: true }, resources: {} },
  instructions: 'Prefer code/graph over full-text search.',
};

/**
 * Hand-written fake of the stdio client owned by `lib/stdio-client.js`.
 *
 * @param {{ handshake?: object, respond?: (method: string, params: object) => any }} [options]
 */
function fakeClient({ handshake = HANDSHAKE, respond = () => ({}) } = {}) {
  const calls = { start: [], request: [], notify: [], close: 0, terminateSync: 0 };
  const client = {
    closed: false,
    stderrTail: '',
    async start(signal) {
      calls.start.push({ signal });
      return handshake;
    },
    async request(method, params, options) {
      calls.request.push({ method, params, options });
      return respond(method, params);
    },
    notify(method, params) {
      calls.notify.push({ method, params });
    },
    async close() {
      calls.close += 1;
      client.closed = true;
    },
    terminateSync() {
      calls.terminateSync += 1;
    },
  };
  return { client, calls };
}

test('initialize stores and caches the handshake', async () => {
  const { client, calls } = fakeClient();
  const session = createMcpSession(client, { serverName: 'basemind' });

  assert.equal(session.instructions, undefined);
  assert.equal(session.capabilities, undefined);
  assert.equal(session.serverInfo, undefined);

  const signal = new AbortController().signal;
  const first = await session.initialize(signal);
  assert.deepEqual(first, HANDSHAKE);
  assert.equal(calls.start.length, 1);
  assert.equal(calls.start[0].signal, signal);

  const second = await session.initialize();
  assert.equal(calls.start.length, 1, 'second initialize must not call start again');
  assert.deepEqual(second, HANDSHAKE);
  assert.equal(calls.start.length, 1);

  assert.equal(session.instructions, HANDSHAKE.instructions);
  assert.deepEqual(session.capabilities, HANDSHAKE.capabilities);
  assert.deepEqual(session.serverInfo, HANDSHAKE.serverInfo);
});

test('concurrent initialize calls start the client once', async () => {
  const { client, calls } = fakeClient();
  const session = createMcpSession(client);

  const [a, b] = await Promise.all([session.initialize(), session.initialize()]);
  assert.equal(calls.start.length, 1);
  assert.equal(a, b);
});

test('listTools paginates, merges, de-duplicates, skips malformed entries and caches', async () => {
  /** @type {string[]} */
  const warnings = [];
  const { client, calls } = fakeClient({
    respond(method, params) {
      assert.equal(method, 'tools/list');
      if (!params.cursor) {
        return {
          tools: [
            { name: 'code', description: 'first wins' },
            { name: 'graph' },
          ],
          nextCursor: 'page-2',
        };
      }
      return {
        tools: [
          { name: 'code', description: 'duplicate' },
          null,
          [],
          'admin',
          { name: '' },
          { name: 42 },
          {},
          { name: 'admin', inputSchema: { type: 'object' } },
        ],
      };
    },
  });
  const session = createMcpSession(client, { logger: { warn: (message) => warnings.push(message) } });

  assert.deepEqual(session.tools, []);
  assert.equal(session.hasTool('code'), false, 'no tools before listTools resolves');

  const signal = new AbortController().signal;
  const tools = await session.listTools(signal);

  assert.deepEqual(tools.map((tool) => tool.name), ['code', 'graph', 'admin']);
  assert.equal(tools[0].description, 'first wins');
  assert.deepEqual(tools[2].inputSchema, { type: 'object' });
  assert.deepEqual(
    calls.request.map((call) => call.params),
    [{}, { cursor: 'page-2' }],
  );
  assert.equal(calls.request[0].method, 'tools/list');
  assert.equal(calls.request[0].options.signal, signal);

  assert.ok(
    warnings.some((message) => message.includes('duplicate') && message.includes('"code"')),
    `expected a duplicate warning, got ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    warnings.some((message) => message.includes('non-empty string name')),
    'expected malformed-name warnings',
  );
  assert.ok(
    warnings.some((message) => message.includes('non-object')),
    'expected non-object warnings',
  );

  assert.equal(session.hasTool('code'), true);
  assert.equal(session.hasTool('admin'), true);
  assert.equal(session.hasTool('mcp__basemind__code'), false);
  assert.equal(session.hasTool('missing'), false);

  const again = await session.listTools();
  assert.equal(again, tools, 'cached list is returned as-is');
  assert.equal(calls.request.length, 2, 'a cached list must not issue new requests');
});

test('listTools ends the walk on an empty page even when a nextCursor is present', async () => {
  const { client, calls } = fakeClient({
    respond: () => ({ tools: [], nextCursor: 'more' }),
  });
  const session = createMcpSession(client);

  assert.deepEqual(await session.listTools(), []);
  assert.equal(calls.request.length, 1);
});

test('listTools stops after 100 pages when the server keeps returning nextCursor', async () => {
  /** @type {string[]} */
  const warnings = [];
  const { client, calls } = fakeClient({
    respond: () => ({ tools: [{ name: 'loop' }], nextCursor: 'again' }),
  });
  const session = createMcpSession(client, { logger: { warn: (message) => warnings.push(message) } });

  const tools = await session.listTools();
  assert.equal(calls.request.length, 100);
  assert.deepEqual(tools.map((tool) => tool.name), ['loop']);
  assert.ok(
    warnings.some((message) => message.includes('100 pages')),
    `expected a pagination-cap warning, got ${JSON.stringify(warnings.slice(0, 2))}`,
  );
});

test('listTools({ refresh: true }) re-fetches and replaces the cache', async () => {
  let generation = 1;
  const { client, calls } = fakeClient({
    respond() {
      if (generation === 1) return { tools: [{ name: 'code' }, { name: 'stale' }] };
      return { tools: [{ name: 'code' }, { name: 'fresh' }] };
    },
  });
  const session = createMcpSession(client);

  assert.deepEqual((await session.listTools()).map((tool) => tool.name), ['code', 'stale']);
  assert.equal(calls.request.length, 1);

  generation = 2;
  const refreshed = await session.listTools(undefined, { refresh: true });
  assert.deepEqual(refreshed.map((tool) => tool.name), ['code', 'fresh']);
  assert.equal(calls.request.length, 2, 'refresh must issue new tools/list requests');
  assert.deepEqual(session.tools.map((tool) => tool.name), ['code', 'fresh']);
  assert.equal(session.hasTool('stale'), false);
  assert.equal(session.hasTool('fresh'), true);

  const cached = await session.listTools();
  assert.equal(cached, refreshed);
  assert.equal(calls.request.length, 2);
});

test('callTool sends the raw name and arguments and forwards signal/timeoutMs', async () => {
  const { client, calls } = fakeClient({
    respond: () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 1 },
      isError: false,
    }),
  });
  const session = createMcpSession(client);
  const controller = new AbortController();

  const result = await session.callTool(
    'code',
    { mode: 'outline' },
    { signal: controller.signal, timeoutMs: 1234 },
  );

  assert.equal(calls.request.length, 1);
  assert.equal(calls.request[0].method, 'tools/call');
  assert.deepEqual(calls.request[0].params, { name: 'code', arguments: { mode: 'outline' } });
  assert.equal(calls.request[0].params.name, 'code', 'wire name must be the raw BaseMind name');
  assert.deepEqual(calls.request[0].options, { signal: controller.signal, timeoutMs: 1234 });
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { value: 1 },
    isError: false,
  });
});

test('callTool normalizes missing content and passes isError through without throwing', async () => {
  const { client, calls } = fakeClient({ respond: () => ({ isError: true }) });
  const session = createMcpSession(client);

  const result = await session.callTool('admin', {});
  assert.deepEqual(result.content, []);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.ok('structuredContent' in result);
  assert.equal(calls.request.length, 1, 'a tool error must not be retried');
});

test('callTool defaults isError to false and ignores a non-array content payload', async () => {
  const { client } = fakeClient({ respond: () => ({ content: { type: 'text' }, structuredContent: null }) });
  const session = createMcpSession(client);

  const result = await session.callTool('graph', { mode: 'callers' });
  assert.deepEqual(result.content, []);
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent, null);
});

test('callTool rejects non-object arguments before issuing a request', async () => {
  const { client, calls } = fakeClient();
  const session = createMcpSession(client);

  for (const bad of [null, undefined, [], 'args', 42, true]) {
    await assert.rejects(
      () => session.callTool('code', bad),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /plain object/);
        assert.match(error.message, /code/);
        return true;
      },
      `expected ${String(bad)} to be rejected`,
    );
  }

  assert.equal(calls.request.length, 0);
});

test('resource methods forward their documented params and the signal', async () => {
  const { client, calls } = fakeClient({
    respond(method) {
      if (method === 'resources/list') return { resources: [{ uri: 'basemind://status' }] };
      if (method === 'resources/templates/list') return { resourceTemplates: [] };
      if (method === 'resources/read') return { contents: [{ uri: 'basemind://status', text: '{}' }] };
      throw new Error(`unexpected method ${method}`);
    },
  });
  const session = createMcpSession(client);
  const signal = new AbortController().signal;

  assert.deepEqual(await session.listResources(undefined, signal), {
    resources: [{ uri: 'basemind://status' }],
  });
  assert.deepEqual(await session.listResources('next-page', signal), {
    resources: [{ uri: 'basemind://status' }],
  });
  assert.deepEqual(await session.listResourceTemplates(undefined, signal), { resourceTemplates: [] });
  assert.deepEqual(await session.listResourceTemplates('tpl-page', signal), { resourceTemplates: [] });
  assert.deepEqual(await session.readResource('basemind://status', signal), {
    contents: [{ uri: 'basemind://status', text: '{}' }],
  });

  assert.deepEqual(
    calls.request.map((call) => [call.method, call.params]),
    [
      ['resources/list', {}],
      ['resources/list', { cursor: 'next-page' }],
      ['resources/templates/list', {}],
      ['resources/templates/list', { cursor: 'tpl-page' }],
      ['resources/read', { uri: 'basemind://status' }],
    ],
  );
  for (const call of calls.request) assert.equal(call.options.signal, signal);
});

test('close and terminateSync delegate to the client', async () => {
  const { client, calls } = fakeClient();
  const session = createMcpSession(client);

  await session.close();
  session.terminateSync();

  assert.equal(calls.close, 1);
  assert.equal(calls.terminateSync, 1);
});
