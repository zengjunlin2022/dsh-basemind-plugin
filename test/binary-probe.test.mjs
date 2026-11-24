import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  parseBasemindVersion,
  isCompatible,
  probeExecutable,
  probeCacheKey,
  createProbeCache,
  PROBE_REASONS,
} from '../lib/binary/probe.js';
import { UPSTREAM } from '../lib/upstream.js';

// --------------------------------------------------------------- fake spawn ---

/**
 * A fake subprocess provider. `script` receives the spawn options and the call index
 * and must return a handle (or throw to simulate a spawn failure).
 */
function fakeSubprocess(script) {
  const calls = [];
  const provider = {
    spawn(options) {
      calls.push(options);
      return script(options, calls.length);
    },
  };
  return { calls, provider };
}

/** A handle that prints `output` and exits with `exitCode` on the next tick. */
function printingHandle(output, exitCode = 0) {
  const stdout = new PassThrough();
  const state = { terminated: 0, waited: 0 };
  const done = new Promise((resolve) => {
    setTimeout(() => {
      stdout.write(output);
      stdout.end();
      resolve(exitCode);
    }, 0);
  });
  return {
    stdout,
    done,
    terminate() {
      state.terminated += 1;
      stdout.end();
    },
    waitForExit() {
      state.waited += 1;
      return Promise.resolve();
    },
    state,
  };
}

/** A handle for a process that never prints and never exits. */
function hangingHandle() {
  const stdout = new PassThrough();
  const state = { terminated: 0, waited: 0 };
  return {
    stdout,
    done: new Promise(() => {}),
    terminate() {
      state.terminated += 1;
      stdout.destroy();
    },
    waitForExit() {
      state.waited += 1;
      return Promise.resolve();
    },
    state,
  };
}

/** A spawn that throws the given errno code. */
function throwingSpawn(code) {
  return () => {
    const error = new Error('spawn ' + code);
    error.code = code;
    throw error;
  };
}

const STABLE_STAT = () => ({ mtimeMs: 1700000000000, size: 42 });
const EXE = '/opt/basemind/bin/basemind';

// ------------------------------------------------------------ version parse ---

test('parses the plain first line "basemind 0.34.0"', () => {
  assert.deepEqual(parseBasemindVersion('basemind 0.34.0'), {
    raw: '0.34.0',
    major: 0,
    minor: 34,
    patch: 0,
  });
});

test('tolerates CRLF, a leading blank line, a BOM and trailing output', () => {
  const parsed = parseBasemindVersion('\uFEFF\r\n\r\nbasemind 0.34.0\r\nmore text\r\n');
  assert.equal(parsed.raw, '0.34.0');
  assert.equal(parsed.major, 0);
  assert.equal(parsed.minor, 34);
  assert.equal(parsed.patch, 0);
});

test('keeps a prerelease tag and a build tag apart', () => {
  const pre = parseBasemindVersion('basemind 0.34.1-rc.1');
  assert.equal(pre.raw, '0.34.1-rc.1');
  assert.equal(pre.prerelease, 'rc.1');
  assert.equal(pre.build, undefined);

  const build = parseBasemindVersion('basemind 0.34.0+8e7b149');
  assert.equal(build.build, '8e7b149');
  assert.equal(build.prerelease, undefined);
});

test('accepts trailing parenthesis metadata on the version line', () => {
  const parsed = parseBasemindVersion('basemind 0.34.0 (x86_64-pc-windows-msvc)');
  assert.equal(parsed.raw, '0.34.0');
  assert.equal(parsed.patch, 0);
});

test('rejects garbage, empty output, a bare name and non-semver versions', () => {
  for (const text of [
    '',
    '   \n\n',
    'hello world',
    'basemind',
    'basemind ',
    'basemind 0.34',
    'basemind v0.34.0',
    'Basemind 0.34.0',
    'basemind 0.34.0\u0000corrupted',
    '\u0007basemind 0.34.0',
    undefined,
    null,
    42,
  ]) {
    assert.equal(parseBasemindVersion(text), undefined, JSON.stringify(String(text)));
  }
});

// ------------------------------------------------------------- compatibility ---

test('exact policy accepts only the identical major.minor.patch', () => {
  assert.deepEqual(isCompatible(parseBasemindVersion('basemind ' + UPSTREAM.version)), {
    compatible: true,
    reason: 'match',
  });
  assert.deepEqual(isCompatible('0.34.1'), { compatible: false, reason: 'patch-mismatch' });
  assert.deepEqual(isCompatible('0.33.0'), { compatible: false, reason: 'minor-mismatch' });
  assert.deepEqual(isCompatible('0.35.0'), { compatible: false, reason: 'minor-mismatch' });
  assert.deepEqual(isCompatible('1.34.0'), { compatible: false, reason: 'minor-mismatch' });
});

test('exact policy ignores build metadata but rejects prereleases', () => {
  assert.equal(isCompatible('0.34.0+8e7b149').compatible, true);
  assert.deepEqual(isCompatible('0.34.0-rc.1'), { compatible: false, reason: 'prerelease' });
  assert.deepEqual(isCompatible('0.34.1-alpha'), { compatible: false, reason: 'prerelease' });
});

test('minor policy accepts another patch but still rejects other minors and prereleases', () => {
  const options = { policy: 'minor' };
  assert.equal(isCompatible('0.34.0', options).compatible, true);
  assert.equal(isCompatible('0.34.7', options).compatible, true);
  assert.equal(isCompatible('0.34.7', options).reason, 'match');
  assert.equal(isCompatible('0.33.9', options).compatible, false);
  assert.equal(isCompatible('0.33.9', options).reason, 'minor-mismatch');
  assert.equal(isCompatible('0.34.1-beta', options).reason, 'prerelease');
});

test('any policy accepts a parsed version of any line, including a prerelease', () => {
  for (const version of ['0.34.0', '0.33.0', '0.35.0', '0.34.0-rc.1', '1.0.0']) {
    assert.deepEqual(isCompatible(version, { policy: 'any' }), { compatible: true, reason: 'match' });
  }
});

test('unparsable input and unknown policies report distinct reasons', () => {
  assert.deepEqual(isCompatible(undefined), { compatible: false, reason: 'unparsable' });
  assert.deepEqual(isCompatible('garbage'), { compatible: false, reason: 'unparsable' });
  assert.deepEqual(isCompatible(null, { policy: 'any' }), { compatible: false, reason: 'unparsable' });
  assert.deepEqual(isCompatible('0.34.0', { policy: 'loose' }), { compatible: false, reason: 'unknown' });
  assert.deepEqual(isCompatible('0.34.0', { expected: 'not-a-version' }), { compatible: false, reason: 'unknown' });
});

test('isCompatible accepts a probe result and an explicit expected version', () => {
  const probe = { ok: true, raw: 'basemind 0.34.0', parsed: parseBasemindVersion('basemind 0.34.0'), version: '0.34.0' };
  assert.equal(isCompatible(probe).compatible, true);
  assert.equal(isCompatible('0.34.0', { expected: '0.34.0' }).compatible, true);
  assert.equal(isCompatible('0.34.0', { expected: '0.34.2' }).reason, 'patch-mismatch');
});

// ------------------------------------------------------------------- probing ---

test('a successful probe returns the raw line, parsed version and spawn shape', async () => {
  const handle = printingHandle('basemind 0.34.0\n');
  const { calls, provider } = fakeSubprocess(() => handle);

  const result = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, platform: 'linux', stat: STABLE_STAT });

  assert.equal(result.ok, true);
  assert.equal(result.raw, 'basemind 0.34.0');
  assert.equal(result.version, '0.34.0');
  assert.equal(result.parsed.minor, 34);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, [EXE, '--version']);
  assert.equal(calls[0].argv[0], EXE);
  assert.deepEqual(calls[0].stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  assert.equal(calls[0].graceMs, 1000);
  assert.equal(calls[0].cwd, process.cwd());
  assert.equal(handle.state.terminated, 1, 'the probe process is terminated');
  assert.equal(handle.state.waited, 1, 'the probe waits for exit');
});

test('garbage on stdout with exit code 0 is unparsable and never throws', async () => {
  const { provider } = fakeSubprocess(() => printingHandle('segmentation fault\n', 0));
  const result = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, stat: STABLE_STAT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unparsable');
  assert.equal(result.raw, 'segmentation fault');
});

test('a non-zero exit without a version line is unexecutable', async () => {
  const { provider } = fakeSubprocess(() => printingHandle('not a PE file\n', 1));
  const result = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, stat: STABLE_STAT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASONS.unexecutable);
});

test('a non-zero exit that still prints a version line succeeds', async () => {
  const { provider } = fakeSubprocess(() => printingHandle('basemind 0.34.0\n', 3));
  const result = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, stat: STABLE_STAT });
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.34.0');
});

test('EACCES and ENOENT map to unexecutable and missing', async () => {
  const denied = await probeExecutable({
    ctx: { subprocess: { spawn: throwingSpawn('EACCES') } },
    exe: EXE,
    stat: STABLE_STAT,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, PROBE_REASONS.unexecutable);

  const gone = await probeExecutable({
    ctx: { subprocess: { spawn: throwingSpawn('ENOENT') } },
    exe: EXE,
    stat: STABLE_STAT,
  });
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, PROBE_REASONS.missing);
});

test('a spawn failure with no code is reported, not thrown', async () => {
  const result = await probeExecutable({
    ctx: {
      subprocess: {
        spawn() {
          throw 'boom';
        },
      },
    },
    exe: EXE,
    stat: STABLE_STAT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASONS.spawnFailed);
});

test('no subprocess provider is a failure, not a throw', async () => {
  const result = await probeExecutable({ ctx: {}, exe: EXE, stat: STABLE_STAT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASONS.spawnFailed);
});

test('a probe that never ends times out, terminates the process and waits for exit', async () => {
  const handle = hangingHandle();
  const { provider } = fakeSubprocess(() => handle);

  const started = Date.now();
  const result = await probeExecutable({
    ctx: { subprocess: provider },
    exe: EXE,
    timeoutMs: 60,
    stat: STABLE_STAT,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASONS.timeout);
  assert.equal(handle.state.terminated, 1);
  assert.equal(handle.state.waited, 1);
  assert.ok(Date.now() - started < 2000, 'the timeout is honored');
});

test('an already-aborted signal short-circuits without spawning', async () => {
  const { calls, provider } = fakeSubprocess(() => printingHandle('basemind 0.34.0\n'));
  const result = await probeExecutable({
    ctx: { subprocess: provider },
    exe: EXE,
    signal: AbortSignal.abort(),
    stat: STABLE_STAT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASONS.aborted);
  assert.equal(calls.length, 0);
});

test('aborting during a probe terminates it and reports aborted', async () => {
  const handle = hangingHandle();
  const { provider } = fakeSubprocess(() => handle);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  const result = await probeExecutable({
    ctx: { subprocess: provider },
    exe: EXE,
    timeoutMs: 5000,
    signal: controller.signal,
    stat: STABLE_STAT,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASONS.aborted);
  assert.equal(handle.state.terminated, 1);
});

test('an empty exe path is missing without spawning', async () => {
  const { calls, provider } = fakeSubprocess(() => printingHandle('basemind 0.34.0\n'));
  for (const exe of ['', '   ', undefined, null, 7]) {
    const result = await probeExecutable({ ctx: { subprocess: provider }, exe, stat: STABLE_STAT });
    assert.equal(result.ok, false);
    assert.equal(result.reason, PROBE_REASONS.missing);
  }
  assert.equal(calls.length, 0);
});

test('a .cmd launcher path that the wrapper cannot express fails without spawning', async () => {
  const { calls, provider } = fakeSubprocess(() => printingHandle('basemind 0.34.0\n'));
  const result = await probeExecutable({
    ctx: { subprocess: provider },
    exe: 'C:/Program Files/Basemind/basemind.cmd',
    platform: 'win32',
    stat: STABLE_STAT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASONS.unexecutable);
  assert.match(result.raw, /cmd\.exe/);
  assert.equal(calls.length, 0);
});

test('stdout capture is bounded to 4096 bytes', async () => {
  const output = 'basemind 0.34.0\n' + 'x'.repeat(20000);
  const { provider } = fakeSubprocess(() => printingHandle(output));
  const result = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, stat: STABLE_STAT });
  assert.equal(result.ok, true);
  assert.ok(result.raw.length <= 4096, 'raw is bounded, got ' + result.raw.length);
});

// --------------------------------------------------------------------- cache ---

test('probeCacheKey changes when mtime or size changes', () => {
  const base = probeCacheKey(EXE, { mtimeMs: 1, size: 2 });
  assert.equal(probeCacheKey(EXE, { mtimeMs: 1, size: 2 }), base);
  assert.notEqual(probeCacheKey(EXE, { mtimeMs: 2, size: 2 }), base);
  assert.notEqual(probeCacheKey(EXE, { mtimeMs: 1, size: 3 }), base);
  assert.notEqual(probeCacheKey(EXE, undefined), base);
  assert.equal(probeCacheKey(EXE, undefined), probeCacheKey(EXE, { mtimeMs: -1, size: -1 }));
});

test('createProbeCache gets, sets and deletes by key or by path', () => {
  const cache = createProbeCache();
  const key = probeCacheKey(EXE, { mtimeMs: 1, size: 2 });

  assert.equal(cache.get(key), undefined);
  cache.set(key, { ok: true, version: '0.34.0' });
  assert.deepEqual(cache.get(key), { ok: true, version: '0.34.0' });
  assert.equal(cache.size, 1);

  assert.equal(cache.delete(EXE), 1);
  assert.equal(cache.get(key), undefined);
  assert.equal(cache.delete(EXE), 0);

  cache.set(key, { ok: false, reason: 'unparsable' });
  assert.equal(cache.delete(key), 1);
  assert.equal(cache.size, 0);

  cache.set(key, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('createProbeCache evicts the oldest entry when it is full', () => {
  const cache = createProbeCache({ maxEntries: 2 });
  const first = probeCacheKey(EXE, { mtimeMs: 1, size: 1 });
  const second = probeCacheKey(EXE, { mtimeMs: 2, size: 1 });
  const third = probeCacheKey(EXE, { mtimeMs: 3, size: 1 });

  cache.set(first, 'a');
  cache.set(second, 'b');
  assert.equal(cache.get(first), 'a'); // touch: first is now the newest
  cache.set(third, 'c');

  assert.equal(cache.get(second), undefined);
  assert.equal(cache.get(first), 'a');
  assert.equal(cache.get(third), 'c');
  assert.equal(cache.size, 2);
});

test('a cached probe result avoids a second spawn', async () => {
  const { calls, provider } = fakeSubprocess(() => printingHandle('basemind 0.34.0\n'));
  const cache = createProbeCache();

  const first = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, stat: STABLE_STAT });
  const second = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, stat: STABLE_STAT });

  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1, 'the second probe is a cache hit');
});

test('a changed mtime or size re-probes instead of reusing the cached version', async () => {
  const { calls, provider } = fakeSubprocess(() => printingHandle('basemind 0.34.0\n'));
  const cache = createProbeCache();
  let stat = { mtimeMs: 1, size: 1 };
  const statFn = () => stat;

  await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, stat: statFn });
  assert.equal(calls.length, 1);

  stat = { mtimeMs: 2, size: 1 };
  await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, stat: statFn });
  assert.equal(calls.length, 2, 'mtime change re-probes');

  stat = { mtimeMs: 2, size: 9 };
  await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, stat: statFn });
  assert.equal(calls.length, 3, 'size change re-probes');
});

test('negative probe results are cached too', async () => {
  const { calls, provider } = fakeSubprocess(() => printingHandle('garbage\n', 0));
  const cache = createProbeCache();

  const first = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, stat: STABLE_STAT });
  const second = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, stat: STABLE_STAT });

  assert.equal(first.reason, 'unparsable');
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
});

test('transient failures (timeout) are not cached', async () => {
  const hanging = hangingHandle();
  const { calls, provider } = fakeSubprocess(() => hanging);
  const cache = createProbeCache();

  await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, timeoutMs: 30, stat: STABLE_STAT });
  await probeExecutable({ ctx: { subprocess: provider }, exe: EXE, cache, timeoutMs: 30, stat: STABLE_STAT });

  assert.equal(calls.length, 2, 'a timeout must be retried, not remembered');
});

test('a real file identity is read when no stat is injected and never throws', async () => {
  const { provider } = fakeSubprocess(() => printingHandle('basemind 0.34.0\n'));
  const result = await probeExecutable({ ctx: { subprocess: provider }, exe: EXE });
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.34.0');
});
