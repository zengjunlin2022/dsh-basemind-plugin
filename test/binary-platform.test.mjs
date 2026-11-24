import test from 'node:test';
import assert from 'node:assert/strict';

import { UPSTREAM } from '../lib/upstream.js';
import { resolveTarget, SUPPORTED_TARGETS } from '../lib/binary/platform.js';

/** Split a target key such as 'linux-arm64' into its platform and arch halves. */
function splitKey(key) {
  const separator = key.lastIndexOf('-');
  return { platform: key.slice(0, separator), arch: key.slice(separator + 1) };
}

test('SUPPORTED_TARGETS matches the published asset table', () => {
  assert.deepEqual([...SUPPORTED_TARGETS].sort(), Object.keys(UPSTREAM.assets).sort());
  assert.ok(SUPPORTED_TARGETS.includes('windows-x64'));
  assert.ok(SUPPORTED_TARGETS.includes('linux-x64'));
  assert.ok(SUPPORTED_TARGETS.includes('linux-arm64'));
  assert.ok(SUPPORTED_TARGETS.includes('darwin-arm64'));
});

test('every published target resolves to its upstream triple, extension and binary', () => {
  for (const [key, asset] of Object.entries(UPSTREAM.assets)) {
    const { platform, arch } = splitKey(key);
    const target = resolveTarget({ platform, arch });

    assert.equal(target.unsupported, undefined, key + ' must be supported');
    assert.equal(target.key, key);
    assert.equal(target.triple, asset.triple);
    assert.equal(target.ext, asset.ext);
    assert.equal(target.binary, asset.binary);
  }
});

test('the Windows target carries basemind.exe; the POSIX targets carry basemind', () => {
  assert.equal(resolveTarget({ platform: 'windows', arch: 'x64' }).binary, 'basemind.exe');
  assert.equal(resolveTarget({ platform: 'linux', arch: 'x64' }).binary, 'basemind');
  assert.equal(resolveTarget({ platform: 'linux', arch: 'arm64' }).binary, 'basemind');
  assert.equal(resolveTarget({ platform: 'darwin', arch: 'arm64' }).binary, 'basemind');

  assert.equal(resolveTarget({ platform: 'windows', arch: 'x64' }).ext, 'zip');
  assert.equal(resolveTarget({ platform: 'linux', arch: 'x64' }).ext, 'tar.gz');
  assert.equal(resolveTarget({ platform: 'darwin', arch: 'arm64' }).ext, 'tar.gz');
});

test('Intel macOS is unsupported with build-from-source guidance', () => {
  const target = resolveTarget({ platform: 'darwin', arch: 'x64' });
  assert.equal(target.unsupported, true);
  assert.equal(Object.hasOwn(target, 'key'), false);
  assert.match(target.reason, /darwin-x64/);
  assert.match(target.reason, /Apple Silicon/);
  assert.match(target.reason, /cargo build --release/);
  assert.match(target.reason, /supported targets are/);
});

test('Windows on ARM64 is unsupported with emulation/source guidance', () => {
  const target = resolveTarget({ platform: 'win32', arch: 'arm64' });
  assert.equal(target.unsupported, true);
  assert.match(target.reason, /win32-arm64/);
  assert.match(target.reason, /ARM64 asset/);
  assert.match(target.reason, /cargo build --release/);
});

test('FreeBSD is unsupported for any arch', () => {
  for (const arch of ['x64', 'arm64']) {
    const target = resolveTarget({ platform: 'freebsd', arch });
    assert.equal(target.unsupported, true);
    assert.match(target.reason, /freebsd-/);
    assert.match(target.reason, /build BaseMind from source/);
  }
});

test('unsupported reasons name the target and list the supported targets', () => {
  const target = resolveTarget({ platform: 'aix', arch: 'ppc64' });
  assert.equal(target.unsupported, true);
  assert.match(target.reason, /aix-ppc64/);
  for (const key of SUPPORTED_TARGETS) assert.ok(target.reason.includes(key), key + ' must be listed');
});

test('blank or non-string platform/arch values are unsupported, never throw', () => {
  for (const params of [
    { platform: '', arch: 'x64' },
    { platform: 'linux', arch: '   ' },
    { platform: null, arch: 'x64' },
    { platform: 42, arch: 'x64' },
  ]) {
    const target = resolveTarget(params);
    assert.equal(target.unsupported, true);
    assert.match(target.reason, /non-empty strings/);
  }

  assert.doesNotThrow(() => resolveTarget(null));
  assert.doesNotThrow(() => resolveTarget(undefined));
});

test('the default arguments describe the current process and stay a plain copy', () => {
  const implicit = resolveTarget();
  const explicit = resolveTarget({ platform: process.platform, arch: process.arch });
  assert.deepEqual(implicit, explicit);

  const target = resolveTarget({ platform: 'linux', arch: 'x64' });
  target.binary = 'tampered';
  assert.equal(UPSTREAM.assets['linux-x64'].binary, 'basemind');
  assert.notEqual(resolveTarget({ platform: 'linux', arch: 'x64' }), UPSTREAM.assets['linux-x64']);
});
