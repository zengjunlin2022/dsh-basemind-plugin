import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { createStdioClient } from '../lib/stdio-client.js';

const ARGV = ['basemind', 'serve', '--root', '.'];
const CWD = 'D:\\repo';

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll until `predicate()` is truthy.
 * @param {() => boolean} predicate
 * @param {{ timeout?: number, label?: string }} [options]
 */
async function waitFor(predicate, { timeout = 2000, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await delay(2);
  }
}

/**
 * Await work whose only scheduled callback is an unref'd timer.
 *
 * The client deliberately unrefs its request-timeout timer so a pending call
 * never keeps the host process alive. With no other handle open, Node's test
 * runner sees an empty event loop while the test's promise is still pending and
 * fails it ("Promise resolution is still pending but the event loop has already
 * resolved"). Holding a ref'd timer for the duration keeps the loop alive
 * without changing what the test asserts.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
async function awaitingUnrefTimer(promise, ms = 200) {
  const keepAlive = setTimeout(() => {}, ms);
  try {
    return await promise;
  } finally {
    clearTimeout(keepAlive);
  }
}

/** Collect logger warnings. */
function createLogger() {
  /** @type {string[]} */
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
}

/**
 * Answer the MCP initialize request the way BaseMind does.
 * @returns {boolean} true when the message was an initialize request
 */
function respondInitialize(
  server,
  message,
  { serverInfo = { name: 'basemind', version: '0.29.3' }, capabilities = { tools: { listChanged: true } }, instructions } = {},
) {
  if (message.method !== 'initialize') return false;
  /** @type {any} */
  const result = {
    protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
    serverInfo,
    capabilities,
  };
  if (instructions !== undefined) result.instructions = instructions;
  server.send({ jsonrpc: '2.0', id: message.id, result });
  return true;
}

/**
 * A scripted fake relay: `stdin` parses newline-delimited JSON, `stdout`/`stderr`
 * are push streams, and the handle mimics DSH's SubprocessHandle.
 * @param {(message: any, server: any) => void} [onMessage]
 */
function createFakeServer(onMessage) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  /** @type {string} */
  let inputBuffer = '';
  /** @type {(info: any) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  /** @type {any} */
  const server = {
    stdout,
    stderr,
    done,
    spec: null,
    received: [],
    parseErrors: [],
    terminated: 0,
    waitForExitCalls: 0,
    exitInfo: { exitCode: null, signal: null },
    stdin: null,
    terminate() {
      server.terminated += 1;
      resolveDone(server.exitInfo);
    },
    async waitForExit() {
      server.waitForExitCalls += 1;
      return true;
    },
    /** Send one JSON-RPC message (object) or raw text (string) on stdout. */
    send(message) {
      stdout.write(typeof message === 'string' ? message : `${JSON.stringify(message)}\n`);
    },
    sendRaw(text) {
      stdout.write(text);
    },
    endStdout() {
      stdout.end();
    },
    exit(info) {
      server.exitInfo = info;
      resolveDone(info);
    },
    lastByMethod(method) {
      return [...server.received].reverse().find((message) => message.method === method);
    },
    allByMethod(method) {
      return server.received.filter((message) => message.method === method);
    },
  };

  server.stdin = new Writable({
    write(chunk, _encoding, callback) {
      inputBuffer += chunk.toString('utf8');
      let newlineAt;
      while ((newlineAt = inputBuffer.indexOf('\n')) >= 0) {
        const line = inputBuffer.slice(0, newlineAt);
        inputBuffer = inputBuffer.slice(newlineAt + 1);
        if (line.trim() === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          server.parseErrors.push(line);
          continue;
        }
        server.received.push(message);
        onMessage?.(message, server);
      }
      callback();
    },
  });

  return server;
}

/**
 * Build a client whose spawn returns scripted fake relays.
 * @param {{ onMessage?: (message: any, server: any, index: number) => void, options?: Record<string, any> }} [params]
 */
function createHarness({ onMessage, options = {} } = {}) {
  /** @type {any[]} */
  const servers = [];
  /** @type {any[]} */
  const specs = [];
  const spawn = (spec) => {
    const index = servers.length;
    const server = createFakeServer((message, current) => onMessage?.(message, current, index));
    server.spec = spec;
    servers.push(server);
    specs.push(spec);
    return server;
  };
  const client = createStdioClient({ argv: ARGV, cwd: CWD, spawn, ...options });
  return {
    client,
    servers,
    specs,
    latest: () => servers[servers.length - 1],
  };
}

// ------------------------------------------------------------------- handshake ---

test('start() negotiates the handshake, sends notifications/initialized and returns server info', async () => {
  const harness = createHarness({
    onMessage: (message, server) => {
      respondInitialize(server, message, {
        serverInfo: { name: 'basemind', version: '0.29.3' },
        capabilities: { tools: { listChanged: true } },
        instructions: 'Use BaseMind for code intelligence.',
      });
    },
  });

  const info = await harness.client.start();

  assert.equal(info.protocolVersion, '2025-06-18');
  assert.deepEqual(info.serverInfo, { name: 'basemind', version: '0.29.3' });
  assert.deepEqual(info.capabilities, { tools: { listChanged: true } });
  assert.equal(info.instructions, 'Use BaseMind for code intelligence.');

  const server = harness.latest();
  assert.deepEqual(server.spec, {
    argv: ARGV,
    cwd: CWD,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3000,
  });
  assert.equal(Object.hasOwn(server.spec, 'env'), false);

  const initialize = server.allByMethod('initialize');
  assert.equal(initialize.length, 1);
  assert.equal(initialize[0].params.clientInfo.name, 'dsh-basemind-plugin');
  assert.equal(initialize[0].params.protocolVersion, '2025-06-18');
  assert.deepEqual(initialize[0].params.capabilities, {});

  const initialized = server.lastByMethod('notifications/initialized');
  assert.ok(initialized, 'notifications/initialized must be sent after initialize');
  assert.equal(initialized.id, undefined);
  assert.deepEqual(server.parseErrors, []);
  assert.equal(harness.client.closed, false);
});

test('spawn spec carries env only when provided', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
    options: { env: { PATH: '/usr/bin' } },
  });
  await harness.client.start();

  assert.deepEqual(harness.specs[0].env, { PATH: '/usr/bin' });
});

test('start() reports a handshake error without retrying a non-version failure', async () => {
  const harness = createHarness({
    onMessage: (message, server) => {
      if (message.method !== 'initialize') return;
      server.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'internal boom' } });
    },
  });

  await assert.rejects(harness.client.start(), /internal boom/);
  assert.equal(harness.specs.length, 1);
  assert.equal(harness.latest().terminated, 1);
});

// ------------------------------------------------------------- request/response ---

test('request() correlates out-of-order responses by id', async () => {
  const harness = createHarness({
    onMessage: (message, server) => {
      respondInitialize(server, message);
    },
  });
  const client = harness.client;
  await client.start();

  const first = client.request('tools/list');
  const second = client.request('resources/list');
  const server = harness.latest();
  await waitFor(
    () => server.allByMethod('tools/list').length === 1 && server.allByMethod('resources/list').length === 1,
    { label: 'both requests' },
  );

  const listRequest = server.allByMethod('tools/list')[0];
  const resourcesRequest = server.allByMethod('resources/list')[0];
  assert.notEqual(listRequest.id, resourcesRequest.id);

  // Answer the second request first.
  server.send({ jsonrpc: '2.0', id: resourcesRequest.id, result: { which: 'resources' } });
  server.send({ jsonrpc: '2.0', id: listRequest.id, result: { which: 'tools' } });

  assert.deepEqual(await first, { which: 'tools' });
  assert.deepEqual(await second, { which: 'resources' });
});

test('request() rejects with the JSON-RPC message and code', async () => {
  const harness = createHarness({
    onMessage: (message, server) => {
      if (respondInitialize(server, message)) return;
      server.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown tool' } });
    },
  });
  const client = harness.client;
  await client.start();

  await assert.rejects(client.request('tools/call', { name: 'nope' }), (error) => {
    assert.match(error.message, /unknown tool/);
    assert.equal(error.code, -32601);
    return true;
  });
});

test('notifications are delivered to onNotification', async () => {
  /** @type {any[]} */
  const notifications = [];
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
    options: {
      onNotification: (message) => notifications.push(message),
    },
  });
  await harness.client.start();

  harness.latest().send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  await waitFor(() => notifications.length === 1, { label: 'notification' });

  assert.equal(notifications[0].method, 'notifications/tools/list_changed');
  // A notification must never be treated as a response.
  assert.equal(harness.client.closed, false);
});

test('notifications are ignored when no onNotification handler is supplied', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
  });
  await harness.client.start();
  harness.latest().send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
  await delay(10);
  assert.equal(harness.client.closed, false);
});

// ------------------------------------------------------------ server requests ---

test('server requests are answered: ping, roots/list, unsupported methods', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
    options: { logger: createLogger() },
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  server.send({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' });
  server.send({ jsonrpc: '2.0', id: 'srv-roots', method: 'roots/list' });
  server.send({ jsonrpc: '2.0', id: 'srv-sampling', method: 'sampling/createMessage', params: {} });
  server.send({ jsonrpc: '2.0', id: 'srv-unknown', method: 'basemind/custom' });

  await waitFor(() => server.received.filter((message) => typeof message.id === 'string').length === 4, {
    label: 'four server-request replies',
  });

  const reply = (id) => server.received.find((message) => message.id === id);
  assert.deepEqual(reply('srv-ping'), { jsonrpc: '2.0', id: 'srv-ping', result: {} });
  assert.deepEqual(reply('srv-roots'), { jsonrpc: '2.0', id: 'srv-roots', result: { roots: [] } });
  assert.equal(reply('srv-sampling').error.code, -32601);
  assert.match(reply('srv-sampling').error.message, /sampling\/createMessage/);
  assert.equal(reply('srv-unknown').error.code, -32601);
  assert.match(reply('srv-unknown').error.message, /basemind\/custom/);
});

// ------------------------------------------------------------------ cancellation ---

test('a timed-out request rejects and sends notifications/cancelled', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  const pending = client.request('tools/call', { name: 'slow' }, { timeoutMs: 25 });
  await awaitingUnrefTimer(assert.rejects(pending, /basemind request 'tools\/call' timed out after 25 ms/));

  await waitFor(() => server.lastByMethod('notifications/cancelled') !== undefined, { label: 'cancelled notification' });
  const cancelled = server.lastByMethod('notifications/cancelled');
  const sent = server.allByMethod('tools/call')[0];
  assert.equal(cancelled.params.requestId, sent.id);
  assert.equal(cancelled.params.reason, 'timeout');
  assert.equal(client.closed, false);
});

test('an aborted request rejects with AbortError and sends notifications/cancelled', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  const controller = new AbortController();
  const pending = client.request('tools/call', { name: 'slow' }, { signal: controller.signal });
  await waitFor(() => server.allByMethod('tools/call').length === 1, { label: 'tools/call request' });

  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.match(error.message, /tools\/call/);
    return true;
  });

  const cancelled = server.lastByMethod('notifications/cancelled');
  await waitFor(() => cancelled !== undefined, { label: 'cancelled notification' });
  assert.equal(cancelled.params.reason, 'aborted');
  assert.equal(cancelled.params.requestId, server.allByMethod('tools/call')[0].id);

  // An abort must never kill the relay.
  assert.equal(server.terminated, 0);
  assert.equal(client.closed, false);
});

test('an already-aborted signal rejects without writing the request', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request('tools/call', {}, { signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(server.allByMethod('tools/call').length, 0);
});

// --------------------------------------------------------------- stdout parsing ---

test('a response line split across chunks is reassembled', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  const pending = client.request('tools/list');
  await waitFor(() => server.allByMethod('tools/list').length === 1, { label: 'tools/list request' });
  const requestId = server.allByMethod('tools/list')[0].id;

  const payload = JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { tools: [] } });
  server.sendRaw(payload.slice(0, 12));
  await delay(10);
  assert.equal(client.closed, false);
  server.sendRaw(`${payload.slice(12)}\r\n`);

  assert.deepEqual(await pending, { tools: [] });
});

test('a malformed JSON line is logged and skipped without breaking the connection', async () => {
  const logger = createLogger();
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
    options: { logger },
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  server.sendRaw('this is not json\n');
  await waitFor(() => logger.warnings.some((warning) => /malformed JSON/.test(warning)), {
    label: 'malformed JSON warning',
  });

  const pending = client.request('tools/list');
  await waitFor(() => server.allByMethod('tools/list').length === 1, { label: 'tools/list request' });
  server.send({ jsonrpc: '2.0', id: server.allByMethod('tools/list')[0].id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(client.closed, false);
});

test('an oversized stdout line closes the client and rejects pending requests', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
    options: { maxLineBytes: 200 },
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  const pending = client.request('tools/list', undefined, { timeoutMs: 0 });
  await waitFor(() => server.allByMethod('tools/list').length === 1, { label: 'tools/list request' });

  server.sendRaw('x'.repeat(500));
  await assert.rejects(pending, /larger than 200 bytes/);
  assert.equal(client.closed, true);
  await waitFor(() => server.terminated === 1, { label: 'relay terminated' });
});

test('stderr is kept as a bounded tail', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
    options: { stderrTailBytes: 16 },
  });
  const client = harness.client;
  await client.start();

  const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
  harness.latest().stderr.write(text);
  await delay(10);

  assert.equal(client.stderrTail, text.slice(-16));
  assert.ok(client.stderrTail.length <= 16);
});

// ------------------------------------------------------------------- process end ---

test('process exit rejects pending requests and reports onClose exactly once', async () => {
  /** @type {any[]} */
  const closes = [];
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
    options: {
      onClose: (error) => closes.push(error),
    },
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  const pending = client.request('tools/call', { name: 'slow' }, { timeoutMs: 0 });
  await waitFor(() => server.allByMethod('tools/call').length === 1, { label: 'tools/call request' });

  server.stderr.write('fatal: basemind daemon died\n');
  await delay(10);
  server.exit({ exitCode: 3, signal: null });

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /exit code 3/);
    assert.match(error.message, /fatal: basemind daemon died/);
    return true;
  });
  await waitFor(() => closes.length === 1, { label: 'onClose' });
  assert.equal(client.closed, true);
  assert.equal(closes.length, 1);
  assert.match(closes[0].message, /basemind relay ended/);

  // Closed clients reject new work immediately.
  await assert.rejects(client.request('tools/list'), /relay is closed/);
  // Later events must not report a second close.
  server.exit({ exitCode: 3, signal: null });
  await delay(10);
  assert.equal(closes.length, 1);
});

test('closing stdout ends the client', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  const pending = client.request('tools/list', undefined, { timeoutMs: 0 });
  await waitFor(() => server.allByMethod('tools/list').length === 1, { label: 'tools/list request' });

  server.endStdout();
  await assert.rejects(pending, /basemind relay ended/);
  assert.equal(client.closed, true);
});

// --------------------------------------------------------------------- lifecycle ---

test('close() is idempotent, terminates once and waits for exit', async () => {
  /** @type {any[]} */
  const closes = [];
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
    options: { onClose: (error) => closes.push(error) },
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  const first = client.close();
  const second = client.close();
  await Promise.all([first, second]);
  await client.close();

  assert.equal(server.terminated, 1);
  assert.equal(server.waitForExitCalls, 1);
  assert.equal(client.closed, true);
  // An owner-initiated close is not reported as a crash.
  assert.equal(closes.length, 0);
  await assert.rejects(client.request('tools/list'), /relay is closed/);
});

test('close() works before start() and never throws', async () => {
  const harness = createHarness({});
  await harness.client.close();
  assert.equal(harness.client.closed, true);
  assert.equal(harness.client.stderrTail, '');
  await harness.client.close();
});

test('terminateSync() terminates the child synchronously', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
  });
  const client = harness.client;
  await client.start();
  const server = harness.latest();

  client.terminateSync();
  // No await: the terminate call must already have happened.
  assert.equal(server.terminated, 1);
});

// ---------------------------------------------------------- protocol negotiation ---

test('start() retries with the next protocol version when the first is rejected', async () => {
  const logger = createLogger();
  const harness = createHarness({
    onMessage: (message, server, index) => {
      if (message.method !== 'initialize') return;
      if (index === 0) {
        server.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: 'Unsupported protocol version: 2025-06-18' },
        });
        return;
      }
      respondInitialize(server, message);
    },
    options: { logger },
  });

  const info = await harness.client.start();

  assert.equal(harness.specs.length, 2, 'one spawn per protocol version');
  assert.equal(info.protocolVersion, '2025-03-26');
  assert.equal(harness.servers[0].terminated, 1, 'the rejected relay must be terminated');
  assert.equal(harness.servers[1].terminated, 0);
  assert.deepEqual(
    harness.servers.map((server) => server.allByMethod('initialize')[0]?.params.protocolVersion),
    ['2025-06-18', '2025-03-26'],
  );
  assert.ok(logger.warnings.some((warning) => /protocol version/.test(warning)));
});

test('start() also retries when the server mentions the protocol version in a plain rejection', async () => {
  const harness = createHarness({
    onMessage: (message, server, index) => {
      if (message.method !== 'initialize') return;
      if (index === 0) {
        server.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'bad protocol version header' } });
        return;
      }
      respondInitialize(server, message);
    },
  });

  const info = await harness.client.start();
  assert.equal(info.protocolVersion, '2025-03-26');
  assert.equal(harness.specs.length, 2);
});

test('start() gives up after the last protocol version and closes the relay', async () => {
  const harness = createHarness({
    onMessage: (message, server) => {
      if (message.method !== 'initialize') return;
      server.send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unsupported protocol version' } });
    },
  });

  await assert.rejects(harness.client.start(), /Unsupported protocol version/);
  assert.equal(harness.specs.length, 3);
  assert.deepEqual(
    harness.servers.map((server) => server.terminated),
    [1, 1, 1],
  );
});

test('start() may only be called once per client', async () => {
  const harness = createHarness({
    onMessage: (message, server) => respondInitialize(server, message),
  });
  await harness.client.start();
  await assert.rejects(harness.client.start(), /may only be called once/);
});

test('createStdioClient requires a spawn function', () => {
  assert.throws(() => createStdioClient({ argv: ARGV, cwd: CWD }), /requires a spawn function/);
});
