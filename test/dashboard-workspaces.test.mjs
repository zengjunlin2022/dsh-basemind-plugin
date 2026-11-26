import assert from 'node:assert/strict'
import path from 'node:path'
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

/** Host-native absolute paths: the registry only ever lists paths from this machine. */
function rootPath() {
  return path.parse(path.resolve(path.sep)).root
}

test('the registry list becomes id/title/path/name rows', () => {
  // `name` comes from path.basename(), so the fixtures must use the host's own
  // separators: a Windows drive root ('C:/') derives 'C:' on POSIX, where it is an
  // ordinary directory name, and only the empty basename may fall back to the path.
  const root = rootPath()
  const project = path.join(root, 'work', 'project')
  const provider = createWorkspaceProvider({
    ctx: ctxWith({
      workspaceRegistry: {
        list: () => [
          { id: 'w1', title: 'Project', path: project },
          { id: 'w2', title: 'Root', path: root },
          { id: 'w3', title: 'Trailing', path: project + path.sep },
        ],
      },
    }),
  })
  const listed = provider.list()
  assert.equal(listed.source, 'workspace-registry')
  assert.deepEqual(listed.items, [
    { id: 'w1', title: 'Project', path: project, name: 'project' },
    // A filesystem root has no basename, so it displays itself.
    { id: 'w2', title: 'Root', path: root, name: root },
    // A trailing separator does not change the derived name.
    { id: 'w3', title: 'Trailing', path: project + path.sep, name: 'project' },
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
  const project = path.join(rootPath(), 'p')
  const provider = createWorkspaceProvider({
    ctx: ctxWith({ workspaceRegistry: { list: () => [{ id: 'w1', title: 'P', path: project }] } }),
  })
  assert.equal(provider.find('w1').name, 'p')
  assert.equal(provider.find(project), undefined)
  assert.equal(provider.find(''), undefined)
  assert.equal(provider.find(undefined), undefined)
})
