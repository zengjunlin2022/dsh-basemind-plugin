import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createWorkspacePool } from '../lib/workspace-pool.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Fake `createSession(root, signal)` whose promises the test resolves manually.
 */
function createFakeFactory() {
  /** @type {any[]} */
  const records = [];

  /** @param {string} root @param {AbortSignal} signal */
  const createSession = (root, signal) => {
    const { promise, resolve, reject } = deferred();
    const session = {
      root,
      closed: 0,
      terminated: 0,
      async initialize() {
        return {};
      },
      async close() {
        session.closed += 1;
      },
      terminateSync() {
        session.terminated += 1;
      },
    };
    /** @type {any} */
    const record = {
      root,
      signal,
      session,
      promise,
      resolve(value = session) {
        resolve(value);
      },
      reject(error) {
        reject(error);
      },
    };
    records.push(record);
    return promise;
  };

  return { createSession, records };
}

function makePool({ maxClients = 8, platform = 'linux' } = {}) {
  /** @type {string[]} */
  const warnings = [];
  const factory = createFakeFactory();
  const pool = createWorkspacePool({
    config: { maxClients },
    logger: { warn: (message) => warnings.push(message) },
    createSession: factory.createSession,
    platform,
  });
  return { pool, records: factory.records, warnings };
}

test('clientFor reuses one session for the same root', async () => {
  const { pool, records } = makePool();
  const root = path.resolve('ws-a');

  const first = pool.clientFor(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].root, root);
  records[0].resolve();
  const session = await first;
  assert.equal(session, records[0].session);

  const second = await pool.clientFor(root);
  assert.equal(second, session);
  assert.equal(records.length, 1);
  assert.equal(pool.has(root), true);
  assert.equal(pool.size, 1);
  assert.deepEqual(pool.roots, [root]);
});

test('concurrent clientFor calls for the same root create exactly one session', async () => {
  const { pool, records } = makePool();
  const root = path.resolve('ws-a');

  const first = pool.clientFor(root);
  const second = pool.clientFor(root);
  assert.equal(records.length, 1, 'the entry must be stored before awaiting');

  records[0].resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(records.length, 1);
});

test('win32 keys are case-insensitive and createSession gets the original root', async () => {
  const { pool, records } = makePool({ platform: 'win32' });
  const upper = 'C:\\Repo';
  const lower = 'c:\\repo';

  const first = pool.clientFor(upper);
  records[0].resolve();
  const session = await first;
  assert.equal(records[0].root, upper);

  const second = await pool.clientFor(lower);
  assert.equal(second, session);
  assert.equal(records.length, 1);
  assert.equal(pool.size, 1);
  assert.deepEqual(pool.roots, [upper]);
  assert.equal(pool.has(lower), true);
  assert.equal(pool.has(upper), true);
  assert.equal(pool.has('D:\\Repo'), false);
});

test('different roots create separate sessions and are reported by size/roots', async () => {
  const { pool, records } = makePool();
  const rootA = path.resolve('ws-a');
  const rootB = path.resolve('ws-b');

  const first = pool.clientFor(rootA);
  const second = pool.clientFor(rootB);
  assert.equal(records.length, 2);

  records[0].resolve();
  records[1].resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a, b);
  assert.equal(pool.size, 2);
  assert.deepEqual(pool.roots, [rootA, rootB]);
  assert.equal(pool.has(rootA), true);
  assert.equal(pool.has(rootB), true);
});

test('a failed createSession removes the entry so the next call retries', async () => {
  const { pool, records } = makePool();
  const root = path.resolve('ws-a');

  const first = pool.clientFor(root);
  records[0].reject(new Error('spawn failed'));
  await assert.rejects(first, /spawn failed/);
  assert.equal(pool.has(root), false);
  assert.equal(pool.size, 0);

  const retry = pool.clientFor(root);
  assert.equal(records.length, 2);
  records[1].resolve();
  const session = await retry;
  assert.equal(session, records[1].session);
  assert.equal(pool.size, 1);
});

test('maxClients is enforced without evicting anything', async () => {
  const { pool, records } = makePool({ maxClients: 1 });
  const rootA = path.resolve('ws-a');
  const rootB = path.resolve('ws-b');

  const first = pool.clientFor(rootA);
  records[0].resolve();
  await first;

  await assert.rejects(pool.clientFor(rootB), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /BASEMIND_TOO_MANY_WORKSPACES/);
    assert.ok(error.message.includes(rootA), 'message must list the current roots');
    assert.match(error.message, /maxClients/);
    return true;
  });

  assert.equal(records.length, 1, 'no session may be created past the cap');
  assert.equal(pool.size, 1);
  assert.deepEqual(pool.roots, [rootA]);
});

test('a caller abort cancels only that caller and leaves the session usable', async () => {
  const { pool, records } = makePool();
  const root = path.resolve('ws-a');
  const caller = new AbortController();

  const waiting = pool.clientFor(root, caller.signal);
  caller.abort();

  await assert.rejects(waiting, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AbortError');
    return true;
  });

  assert.equal(records.length, 1);
  assert.notEqual(records[0].signal, caller.signal, 'caller signal must not be forwarded');
  assert.equal(records[0].signal.aborted, false, 'pool signal must stay live');
  assert.equal(pool.has(root), true, 'the entry must be left untouched');

  records[0].resolve();
  const session = await pool.clientFor(root);
  assert.equal(session, records[0].session);
  assert.equal(records.length, 1);
});

test('a caller already aborted does not start a session', async () => {
  const { pool, records } = makePool();
  const root = path.resolve('ws-a');

  await assert.rejects(pool.clientFor(root, AbortSignal.abort()), (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(records.length, 0);
  assert.equal(pool.size, 0);
});

test('drop terminates, closes and forgets a session', async () => {
  const { pool, records } = makePool();
  const root = path.resolve('ws-a');

  const pending = pool.clientFor(root);
  records[0].resolve();
  const session = await pending;

  await pool.drop(root);
  assert.equal(session.terminated, 1);
  assert.equal(session.closed, 1);
  assert.equal(pool.has(root), false);
  assert.equal(pool.size, 0);

  await pool.drop(path.resolve('ws-unknown'));
});

test('drop logs and still resolves when close rejects', async () => {
  const { pool, records, warnings } = makePool();
  const root = path.resolve('ws-a');

  const pending = pool.clientFor(root);
  records[0].session.close = async () => {
    throw new Error('close boom');
  };
  records[0].resolve();
  await pending;

  await pool.drop(root);
  assert.equal(pool.size, 0);
  assert.equal(records[0].session.terminated, 1);
  assert.ok(warnings.some((message) => message.includes('close boom')));
});

test('terminateSyncAll terminates established sessions synchronously', async () => {
  const { pool, records } = makePool();
  const rootA = path.resolve('ws-a');
  const rootB = path.resolve('ws-b');

  const first = pool.clientFor(rootA);
  const second = pool.clientFor(rootB);
  records[0].resolve();
  records[1].resolve();
  const [a, b] = await Promise.all([first, second]);

  pool.terminateSyncAll();
  assert.equal(a.terminated, 1);
  assert.equal(b.terminated, 1);
  assert.equal(a.closed, 0, 'terminateSyncAll must not wait for a close');
  assert.equal(pool.size, 2);
});

test('terminateSyncAll ignores entries whose session is not established yet', async () => {
  const { pool, records } = makePool();
  const root = path.resolve('ws-a');

  const pending = pool.clientFor(root);
  assert.doesNotThrow(() => pool.terminateSyncAll());

  records[0].resolve();
  await pending;
  assert.equal(records[0].session.terminated, 0);
});

test('disposeAll aborts the pool, terminates and closes everything, then clears the map', async () => {
  const { pool, records } = makePool();
  const rootA = path.resolve('ws-a');
  const rootB = path.resolve('ws-b');

  const first = pool.clientFor(rootA);
  const second = pool.clientFor(rootB);
  records[0].resolve();
  records[1].resolve();
  const [a, b] = await Promise.all([first, second]);

  await pool.disposeAll();

  assert.equal(a.terminated, 1);
  assert.equal(a.closed, 1);
  assert.equal(b.terminated, 1);
  assert.equal(b.closed, 1);
  assert.equal(records[0].signal.aborted, true);
  assert.equal(records[1].signal.aborted, true);
  assert.equal(pool.size, 0);
  assert.deepEqual(pool.roots, []);
  assert.equal(pool.has(rootA), false);
});

test('disposeAll resolves and warns when a close rejects', async () => {
  const { pool, records, warnings } = makePool();
  const rootA = path.resolve('ws-a');
  const rootB = path.resolve('ws-b');

  const first = pool.clientFor(rootA);
  const second = pool.clientFor(rootB);
  records[0].session.close = async () => {
    throw new Error('close boom');
  };
  records[0].resolve();
  records[1].resolve();
  await Promise.all([first, second]);

  await pool.disposeAll();

  assert.equal(pool.size, 0);
  assert.equal(records[0].session.terminated, 1);
  assert.equal(records[1].session.closed, 1);
  assert.ok(warnings.some((message) => message.includes('close boom')));
});

test('disposeAll resolves when a pending session creation rejects', async () => {
  const { pool, records } = makePool();
  const root = path.resolve('ws-a');

  const pending = pool.clientFor(root);
  const guarded = pending.catch((error) => error);

  const disposal = pool.disposeAll();
  records[0].reject(new Error('spawn failed'));
  await disposal;

  const error = await guarded;
  assert.match(error.message, /spawn failed/);
  assert.equal(pool.size, 0);
});
