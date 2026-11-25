import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkspaceProvider } from '../lib/dashboard/workspaces.js'

function ctxWith(services) {
  return {
    get(name) {
      if (name in services) return services[name]
      throw new Error('unknown service ' + name)
    },
  }
}

test('the registry list becomes id/title/path/name rows', () => {
  const provider = createWorkspaceProvider({
    ctx: ctxWith({
      workspaceRegistry: {
        list: () => [
          { id: 'w1', title: 'Project', path: 'C:/work/project' },
          { id: 'w2', title: 'Root', path: 'C:/' },
        ],
      },
    }),
  })
  const listed = provider.list()
  assert.equal(listed.source, 'workspace-registry')
  assert.deepEqual(listed.items, [
    { id: 'w1', title: 'Project', path: 'C:/work/project', name: 'project' },
    { id: 'w2', title: 'Root', path: 'C:/', name: 'C:/' },
  ])
})

test('a missing registry degrades to unavailable instead of throwing', () => {
  const provider = createWorkspaceProvider({ ctx: { get: () => undefined } })
  const listed = provider.list()
  assert.equal(listed.source, 'unavailable')
  assert.deepEqual(listed.items, [])
  assert.match(listed.message, /Workspace registry/)
})

test('a throwing registry read degrades to error and never invents items', () => {
  const provider = createWorkspaceProvider({
    ctx: ctxWith({
      workspaceRegistry: {
        list: () => {
          throw new Error('registry unavailable')
        },
      },
    }),
  })
  const listed = provider.list()
  assert.equal(listed.source, 'error')
  assert.deepEqual(listed.items, [])
  assert.match(listed.message, /registry unavailable/)
})

test('find only resolves ids that the registry lists', () => {
  const provider = createWorkspaceProvider({
    ctx: ctxWith({ workspaceRegistry: { list: () => [{ id: 'w1', title: 'P', path: 'C:/p' }] } }),
  })
  assert.equal(provider.find('w1').name, 'p')
  assert.equal(provider.find('C:/p'), undefined)
  assert.equal(provider.find(''), undefined)
  assert.equal(provider.find(undefined), undefined)
})
