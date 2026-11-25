import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createScanHistory, workspaceKey } from '../lib/dashboard/history.js'

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bm-dashboard-' + label + '-'))
}

function entry(index) {
  return {
    taskId: 'task-' + String(index),
    workspaceId: 'ws-1',
    workspacePath: 'C:/repo',
    scanType: index % 2 === 0 ? 'full' : 'incremental',
    scope: [],
    startedAt: '2026-11-25T00:00:0' + String(index % 10) + '.000Z',
    finishedAt: '2026-11-25T00:00:0' + String(index % 10) + '.500Z',
    durationMs: 500,
    status: 'completed',
    summary: { scanned: index },
    baseMindVersion: '0.34.0',
    error: null,
  }
}

test('history keeps the newest ten entries per workspace', async () => {
  const root = tempRoot('retain')
  try {
    const history = createScanHistory({ root })
    for (let index = 0; index < 12; index += 1) await history.record('C:/repo', entry(index))
    const entries = await history.read('C:/repo')
    assert.equal(entries.length, 10)
    assert.equal(entries[0].taskId, 'task-11')
    assert.equal(entries[9].taskId, 'task-2')
    const stored = JSON.parse(fs.readFileSync(history.file, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.workspaces[workspaceKey('C:/repo')].length, 10)
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.tmp-')), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a disabled history writes nothing and reads as empty', async () => {
  const root = tempRoot('disabled')
  try {
    const history = createScanHistory({ root, enabled: false })
    assert.deepEqual(await history.record('C:/repo', entry(1)), [])
    assert.deepEqual(await history.read('C:/repo'), [])
    assert.equal(fs.existsSync(history.file), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a malformed entry is refused instead of stored', async () => {
  const root = tempRoot('malformed')
  try {
    const history = createScanHistory({ root })
    await assert.rejects(() => history.record('C:/repo', { taskId: 'x' }), /malformed/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable file degrades to an empty history', async () => {
  const root = tempRoot('corrupt')
  try {
    const history = createScanHistory({ root })
    fs.writeFileSync(history.file, '{ not json')
    assert.deepEqual(await history.read('C:/repo'), [])
    await history.record('C:/repo', entry(1))
    assert.equal((await history.read('C:/repo')).length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('workspaceKey is case-insensitive only on Windows', () => {
  if (process.platform === 'win32') assert.equal(workspaceKey('C:/Repo'), workspaceKey('c:/repo'))
  else assert.notEqual(workspaceKey('C:/Repo'), workspaceKey('c:/repo'))
})
