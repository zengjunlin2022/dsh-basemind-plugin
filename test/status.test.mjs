import assert from 'node:assert/strict'
import test from 'node:test'

import { statusReport, renderStatus } from '../lib/status.js'
import { UPSTREAM } from '../lib/upstream.js'

const PLATFORM = { key: 'windows-x64', triple: 'x86_64-pc-windows-msvc' }
const CONFIG = { binaryDownload: true, binaryPolicy: 'exact' }

/** A manager whose snapshot is fixed. */
function manager(status) {
  return { status: () => status }
}

test('without a binary the report says present: no and gives install guidance', async () => {
  const report = await statusReport({ config: CONFIG, platform: PLATFORM })
  assert.equal(report.present, false)
  assert.equal(report.expected, UPSTREAM.version)
  assert.equal(report.compatible, false)
  assert.equal(report.policy, 'exact')
  assert.equal(report.platform, 'windows-x64 (x86_64-pc-windows-msvc)')
  assert.ok(report.reasons.length > 0)

  const text = renderStatus(report)
  assert.equal(text, report.lines.join('\n'))
  assert.match(text, /present\s+: no/)
  assert.match(text, /expected upstream: 0\.34\.0 \(exact\)/)
  assert.match(text, /compatible\s+: NO/)
  assert.ok(text.includes('Install BaseMind 0.34.0'))
  assert.ok(text.includes('https://github.com/Goldziher/basemind/releases'))
  assert.ok(text.includes('Tools are not registered until a compatible binary is available.'))
})

test('a compatible selection renders found/compatible/source/path', async () => {
  const report = await statusReport({
    manager: manager({
      pluginVersion: '0.2.0',
      selection: {
        source: 'path',
        path: 'C:/Tools/basemind/basemind.exe',
        version: '0.34.0',
        compatible: true,
      },
    }),
    config: CONFIG,
    platform: PLATFORM,
  })
  assert.equal(report.present, true)
  assert.equal(report.found, '0.34.0')
  assert.equal(report.compatible, true)
  assert.equal(report.source, 'path')

  const text = renderStatus(report)
  assert.match(text, /present\s+: yes/)
  assert.match(text, /found\s+: 0\.34\.0/)
  assert.match(text, /compatible\s+: yes/)
  assert.match(text, /source\s+: path/)
  assert.ok(text.includes('C:/Tools/basemind/basemind.exe'))
  assert.ok(text.includes('No action needed'))
  assert.equal(text.includes('Tools are not registered'), false)
})

test('a 0.33.0 binary explains the minor mismatch and two actionable options', async () => {
  const report = await statusReport({
    manager: manager({
      selection: {
        source: 'path',
        path: '/usr/local/bin/basemind',
        version: '0.33.0',
        compatible: false,
        reason: 'minor mismatch (0.33 vs 0.34)',
      },
    }),
    config: CONFIG,
    platform: PLATFORM,
  })
  assert.equal(report.compatible, false)
  const text = renderStatus(report)
  assert.match(text, /compatible\s+: NO - minor mismatch/)
  assert.ok(text.includes('binaryPolicy: "minor"'))
  assert.ok(text.includes('binaryFallback: false'))
  assert.ok(text.includes('Install BaseMind 0.34.0'))
})

test('an unparsable version renders found: unknown and a sanitized sample', async () => {
  const report = await statusReport({
    manager: manager({
      selection: {
        source: 'path',
        path: '/usr/local/bin/basemind',
        compatible: false,
        reason: 'unparsable',
        sample: '\u0001garbage \u0000 output --version',
      },
    }),
    config: CONFIG,
    platform: PLATFORM,
  })
  assert.equal(report.found, undefined)
  const text = renderStatus(report)
  assert.match(text, /found\s+: unknown/)
  assert.match(text, /compatible\s+: NO/)
  assert.match(text, /unparsable/)
  assert.ok(text.includes('garbage'))
  assert.equal(/[\u0000-\u0008]/.test(text), false)
  assert.equal(text.includes('\u0000'), false)
})

test('an unsupported platform is rendered without probing the manager', async () => {
  let probed = false
  const report = await statusReport({
    manager: {
      ensureStatus: async () => {
        probed = true
        return {}
      },
    },
    config: CONFIG,
    platform: {
      platform: 'darwin',
      arch: 'x64',
      unsupported: true,
      reason: 'BaseMind publishes no binary for darwin-x64',
    },
  })
  assert.equal(probed, false)
  assert.equal(report.platformUnsupported, true)
  assert.equal(report.platform, 'unsupported (darwin-x64)')
  const text = renderStatus(report)
  assert.ok(text.includes('unsupported (darwin-x64)'))
  assert.ok(text.includes('publishes no prebuilt binary'))
  assert.ok(text.includes('Build one from source'))
})

test('a failed probe renders compatible: NO with a probe-failed reason', async () => {
  const report = await statusReport({
    manager: {
      ensureStatus: async () => {
        throw new Error('--version timed out after 5000 ms')
      },
    },
    config: CONFIG,
    platform: PLATFORM,
  })
  assert.equal(report.present, false)
  const text = renderStatus(report)
  assert.match(text, /compatible\s+: NO/)
  assert.ok(text.includes('probe failed'))
  assert.ok(text.includes('--version'))
})

test('a hung ensureStatus is bounded to five seconds', async () => {
  const started = Date.now()
  const report = await statusReport({
    manager: { ensureStatus: () => new Promise(() => {}) },
    config: CONFIG,
    platform: PLATFORM,
  })
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 4900, 'returned too early: ' + elapsed)
  assert.ok(elapsed < 7000, 'exceeded the 5 s bound: ' + elapsed)
  assert.match(renderStatus(report), /probe failed/)
})

test('an existing ensureStatus snapshot is awaited once and used', async () => {
  let calls = 0
  const report = await statusReport({
    manager: {
      status: () => ({}),
      ensureStatus: async () => {
        calls += 1
        return {
          selection: { source: 'managed', path: 'C:/cache/basemind.exe', version: '0.34.0', compatible: true },
          cache: { root: 'C:/cache/managed-binaries', present: true, valid: true },
        }
      },
    },
    config: CONFIG,
    platform: PLATFORM,
  })
  assert.equal(calls, 1)
  assert.equal(report.source, 'managed')
  assert.equal(report.cache.present, true)
  const text = renderStatus(report)
  assert.ok(text.includes('present (C:/cache/managed-binaries)'))
  assert.match(text, /download\s+: enabled \(binaryDownload=true\)/)
})

test('a failed download is rendered with state and error but no relative time', async () => {
  const report = await statusReport({
    manager: manager({
      selection: { source: 'path', path: '/usr/bin/basemind', version: '0.34.0', compatible: true },
      download: { state: 'failed', attempts: 2, lastError: 'HTTP 403' },
    }),
    config: CONFIG,
    platform: PLATFORM,
  })
  const text = renderStatus(report)
  assert.ok(text.includes('last attempt failed (HTTP 403)'))
  assert.equal(/\bag(o|ne)\b/.test(text), false)
})

test('disabled download is visible and the guidance offers to enable it', async () => {
  const report = await statusReport({
    config: { binaryDownload: false, binaryPolicy: 'exact' },
    platform: PLATFORM,
  })
  const text = renderStatus(report)
  assert.match(text, /download\s+: disabled \(binaryDownload=false\)/)
  assert.ok(text.includes('binaryDownload: true'))
})

test('the manager platform key and triple shape the platform line', async () => {
  const report = await statusReport({
    manager: manager({
      platform: 'windows-x64',
      selection: { source: 'path', path: 'C:/Tools/basemind.exe', version: '0.34.0', compatible: true, reason: 'match' },
    }),
    config: CONFIG,
    platform: process.platform,
  })
  assert.equal(report.platform, 'windows-x64 (x86_64-pc-windows-msvc)')
  assert.deepEqual(report.reasons, [])
  const text = renderStatus(report)
  assert.match(text, /platform\s+: windows-x64/)
  assert.equal(report.reasons.includes('match'), false)
})

test('a manager-reported unsupported platform skips the probe and explains the build', async () => {
  let probed = false
  const report = await statusReport({
    manager: {
      status: () => ({
        platform: undefined,
        unsupported: 'no prebuilt BaseMind binary for darwin-x64',
        selection: undefined,
      }),
      ensureStatus: async () => {
        probed = true
        return {}
      },
    },
    config: CONFIG,
    platform: 'darwin',
  })
  assert.equal(probed, false)
  assert.equal(report.platformUnsupported, true)
  assert.ok(report.platform.startsWith('unsupported'))
  const text = renderStatus(report)
  assert.ok(text.includes('publishes no prebuilt binary'))
  assert.ok(text.includes('no prebuilt BaseMind binary for darwin-x64'))
})

test('a cooldown download shows the backoff and its last error', async () => {
  const report = await statusReport({
    manager: manager({
      selection: { source: 'path', path: '/usr/bin/basemind', version: '0.34.0', compatible: true },
      download: { state: 'cooldown', attempts: 2, lastError: 'HTTP 429' },
    }),
    config: CONFIG,
    platform: PLATFORM,
  })
  const text = renderStatus(report)
  assert.ok(text.includes('backing off after a failed attempt (HTTP 429)'))
})

test('the binary manager snapshot shape renders without triggering a probe', async () => {
  let probed = false
  const snapshot = {
    pluginVersion: '0.2.0',
    expected: '0.34.0',
    policy: 'exact',
    platform: 'windows-x64',
    unsupported: undefined,
    selection: {
      source: 'path',
      path: 'C:/Tools/basemind/basemind.exe',
      version: '0.34.0',
      compatible: true,
      reason: 'match',
    },
    cache: { root: 'C:/cache/managed-binaries', target: 'windows-x64', present: false, valid: false },
    download: { state: 'idle', attempts: 0, lastError: undefined, nextAttemptAt: undefined },
  }
  const report = await statusReport({
    manager: {
      status: () => snapshot,
      ensureStatus: async () => {
        probed = true
        return snapshot
      },
    },
    config: CONFIG,
    platform: process.platform,
  })
  assert.equal(probed, false)
  assert.equal(report.compatible, true)
  assert.equal(report.present, true)
  assert.equal(report.platform, 'windows-x64 (x86_64-pc-windows-msvc)')
  const text = renderStatus(report)
  assert.ok(text.includes('empty (C:/cache/managed-binaries)'))
  assert.equal(text.includes('invalid'), false)
})

test('the top-level manager snapshot shape is accepted as a fallback', async () => {
  const report = await statusReport({
    manager: manager({
      pluginVersion: '9.9.9',
      present: true,
      path: '/opt/basemind',
      found: '0.34.0',
      compatible: true,
      source: 'path',
    }),
    config: CONFIG,
    platform: PLATFORM,
  })
  assert.equal(report.present, true)
  assert.equal(report.pluginVersion, '9.9.9')
  const text = renderStatus(report)
  assert.ok(text.includes('dsh-basemind-plugin 9.9.9'))
  assert.ok(text.includes('/opt/basemind'))
})

test('rendering is deterministic, ANSI-free and at most 100 columns per line', async () => {
  const longPath = 'C:/' + 'very-long-directory-name/'.repeat(8) + 'basemind.exe'
  const report = await statusReport({
    manager: manager({
      selection: {
        source: 'path',
        path: longPath,
        version: '0.33.0',
        compatible: false,
        reason: 'minor mismatch ' + 'x'.repeat(300),
      },
      cache: { root: 'C:/' + 'cache-segment/'.repeat(10) },
      download: { state: 'failed', attempts: 3, lastError: 'HTTP 403 ' + 'y'.repeat(200) },
    }),
    config: CONFIG,
    platform: PLATFORM,
  })
  const first = renderStatus(report)
  const second = renderStatus(report)
  assert.equal(first, second)
  assert.equal(report.lines.join('\n'), first)
  for (const line of report.lines) {
    assert.ok(line.length <= 100, 'line too wide: ' + line)
  }
  assert.equal(/\u001b\[/.test(first), false)
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(first), false)
  assert.ok(first.includes('basemind.exe'))
})

test('credential-looking fragments in dynamic values are redacted', async () => {
  const report = await statusReport({
    manager: manager({
      selection: {
        source: 'path',
        path: '/usr/bin/basemind',
        compatible: false,
        reason: 'probe failed with TOKEN=abc123 and SECRET: hunter2',
      },
      download: { state: 'failed', lastError: 'failed url?api_key=zzz999' },
    }),
    config: CONFIG,
    platform: PLATFORM,
  })
  const text = renderStatus(report)
  assert.equal(text.includes('abc123'), false)
  assert.equal(text.includes('hunter2'), false)
  assert.equal(text.includes('zzz999'), false)
  assert.ok(text.includes('<redacted>'))
})

test('renderStatus can render a field snapshot without precomputed lines', () => {
  const text = renderStatus({ present: false, expected: '0.34.0' })
  assert.ok(text.includes('BaseMind status'))
  assert.match(text, /present\s+: no/)
  assert.match(text, /expected upstream: 0\.34\.0/)
})
