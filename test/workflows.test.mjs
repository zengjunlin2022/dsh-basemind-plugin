/**
 * Static regression checks for the CI workflows.
 *
 * These are cheap, offline guards for two classes of mistake that a YAML review does not
 * catch and that GitHub only reports at run time:
 *
 * 1. `jobs.<id>.if` cannot see the `matrix` context, so a per-entry opt-in written there
 *    is silently true for every entry. The managed workflow therefore builds its matrix in
 *    a `plan` job and consumes it with `fromJSON`.
 * 2. `matrix` architecture values are compared verbatim with `uname -m`; normalising one
 *    side (for example macOS `arm64` to `aarch64`) makes the assertion fail on every run.
 *
 * The workflows are parsed as text on purpose: this package has no dependencies, and a
 * YAML parser would be one. The patterns below are narrow enough to be maintained.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { UPSTREAM } from '../lib/upstream.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = Object.freeze(['ci.yml', 'compat.yml', 'managed-binary.yml', 'release.yml']);

/** @param {string} name */
function workflow(name) {
  return readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
}

/** The verbatim `uname -m` value each supported runner reports, and its Node arch. */
const RUNNER_ARCHES = Object.freeze({
  'linux/x86_64': { expectedNodeArch: 'x64' },
  'win32/x86_64': { expectedNodeArch: 'x64' },
  'darwin/arm64': { expectedNodeArch: 'arm64' },
  'linux/aarch64': { expectedNodeArch: 'arm64' },
});

/** Every `{ os, expectedPlatform, expectedArch, expectedNodeArch }` entry in the plan job. */
function matrixEntries(text) {
  const pattern = /\{\s*os:\s*'([^']+)',\s*expectedPlatform:\s*'([^']+)',\s*expectedArch:\s*'([^']+)',\s*expectedNodeArch:\s*'([^']+)'\s*\}/g;
  const entries = [];
  for (const match of text.matchAll(pattern)) {
    entries.push({ os: match[1], platform: match[2], arch: match[3], nodeArch: match[4] });
  }
  return entries;
}

test('the managed workflow never puts a matrix condition on a job', () => {
  const text = workflow('managed-binary.yml');
  // Four spaces is the job level; a step or a script line is deeper or inside a block.
  const jobConditions = text.split('\n').filter((line) => /^ {4}if:/.test(line));
  for (const line of jobConditions) {
    assert.doesNotMatch(
      line,
      /\bmatrix\b/,
      `jobs.<id>.if cannot read the matrix context, so this condition is always true: ${line.trim()}`,
    );
  }
});

test('the managed workflow builds the matrix from the arm64 input instead', () => {
  const text = workflow('managed-binary.yml');
  assert.match(text, /^ {2}plan:/m, 'a plan job builds the matrix');
  assert.match(text, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/, 'the managed job consumes the planned matrix');
  assert.match(text, /if \(process\.env\.INCLUDE_ARM64 === 'true'\)/, 'arm64 is appended only when the input asks for it');

  const guard = text.indexOf("INCLUDE_ARM64 === 'true'");
  const arm = text.indexOf("os: 'ubuntu-24.04-arm'");
  const emit = text.indexOf("console.log('matrix='");
  assert.ok(guard !== -1 && arm !== -1 && emit !== -1, 'the plan job contains the guard, the arm64 entry and the output');
  assert.ok(guard < arm && arm < emit, 'the arm64 entry is added under the guard, before the matrix is emitted');
});

test('the managed workflow declares the arm64 opt-in on both manual triggers', () => {
  const text = workflow('managed-binary.yml');
  assert.match(text, /^ {2}workflow_dispatch:/m);
  assert.match(text, /^ {2}workflow_call:/m);
  assert.equal(
    (text.match(/include_linux_arm64/g) ?? []).length >= 2,
    true,
    'the input is declared for workflow_dispatch and for workflow_call, so a caller can opt in explicitly',
  );
  assert.equal(
    (text.match(/default: false/g) ?? []).length >= 2,
    true,
    'both declarations default to false, so a release gate never depends on the arm64 runner',
  );
});

test('every managed matrix entry uses the verbatim uname architecture and a known platform pair', () => {
  const entries = matrixEntries(workflow('managed-binary.yml'));
  assert.equal(entries.length, 4, 'three required platforms plus the opt-in arm64 entry');
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.platform}/${entry.arch}`;
    assert.ok(
      Object.hasOwn(RUNNER_ARCHES, key),
      `${entry.os}: ${key} is not a supported runner platform/arch pair`,
    );
    assert.equal(entry.nodeArch, RUNNER_ARCHES[key].expectedNodeArch, `${entry.os}: node arch matches the CPU`);
    seen.add(key);
  }
  assert.deepEqual(
    [...seen].sort(),
    ['darwin/arm64', 'linux/aarch64', 'linux/x86_64', 'win32/x86_64'],
    'the required platforms are covered and arm64 is the only extra',
  );

  // The exact regression this guard exists for: macOS reports `arm64`, and the workflow
  // compares it verbatim. No normalising layer may rewrite it to `aarch64`.
  const darwin = entries.find((entry) => entry.platform === 'darwin');
  assert.equal(darwin.arch, 'arm64', 'macOS is asserted against the value uname -m prints');
  for (const entry of entries) {
    assert.doesNotMatch(entry.arch, /^x64$/, 'Node naming (x64) never reaches the CPU assertion');
  }
  const text = workflow('managed-binary.yml');
  assert.doesNotMatch(
    text,
    /arm64\|aarch64\)/,
    'no case block rewrites uname -m before it is compared with the matrix',
  );
});

test('the managed workflow has no path that turns a failure into a pass', () => {
  const text = workflow('managed-binary.yml');
  assert.doesNotMatch(text, /continue-on-error/, 'no step may be allowed to fail silently');
  assert.doesNotMatch(text, /\|\| true/, 'no shell fallback may swallow a failure');
  assert.match(text, /BASEMIND_REQUIRE_MANAGED_INTEGRATION: '1'/, 'the gate is forced on in CI');
  assert.doesNotMatch(text, /BASEMIND_BIN:/, 'the workflow never points the plugin at a pre-installed binary');
  assert.doesNotMatch(text, /uses: actions\/cache/, 'the cache is genuine: no actions/cache step');
});

test('no workflow hardcodes the BaseMind version or tag', () => {
  for (const name of WORKFLOWS) {
    const text = workflow(name);
  assert.equal(text.includes(UPSTREAM.version), false, `${name} must read the version from lib/upstream.js instead of hardcoding it`);
  assert.equal(text.includes(UPSTREAM.tag), false, `${name} must not hardcode the release tag`);
  }
});

test('the ordinary CI keeps the single source of truth for running the suite', () => {
  const text = workflow('ci.yml');
  assert.match(text, /npm test --/, 'ci.yml runs npm test with extra reporters instead of duplicating its arguments');
  assert.doesNotMatch(text, /BASEMIND_REQUIRE_MANAGED_INTEGRATION/, 'a commit must not download the release');
  assert.doesNotMatch(text, /BASEMIND_REQUIRE_INTEGRATION/, 'the external-binary gate stays out of the ordinary CI');
});

test('the release gate calls the managed workflow on the same commit', () => {
  const text = workflow('release.yml');
  assert.match(text, /^ {2}managed-gate:$/m, 'the gate is its own reusable-workflow job');
  assert.match(text, /uses: \.\/\.github\/workflows\/managed-binary\.yml/, 'a local uses: checks out the caller commit');
  assert.match(text, /needs: \[managed-gate\]/, 'publishing cannot start before the gate passes');
});

test('the compatibility workflow does not claim to prove the managed install', () => {
  const text = workflow('compat.yml');
  assert.match(text, /structurally cannot detect/, 'its scope is documented');
  assert.doesNotMatch(text, /os: ubuntu-24\.04-arm/, 'an unconfirmed runner label is not queued unconditionally');
});
