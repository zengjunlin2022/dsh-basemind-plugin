import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Creates the synthetic B5 repository: three staged defects in src/plan.js, one
// staged non-defect (a comment), one unstaged distraction and one untracked file.
// Only the staged plan.js change is in scope for the task.
const root = path.join(os.tmpdir(), 'bm-staged')
rmSync(root, { recursive: true, force: true })
mkdirSync(path.join(root, 'src'), { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
git('init', '-q')
git('config', 'user.name', 'bench')
git('config', 'user.email', 'bench@example.invalid')

const BASE = `export function summarize(users) {
  const names = []
  for (let i = 0; i < users.length; i++) {
    names.push(users[i].name)
  }
  return names.join(', ')
}

export function displayName(user) {
  return user.name.trim()
}

export function startPolling(fetchCount) {
  return () => fetchCount()
}
`

const STAGED = `// Naming: "users" is the roster passed by the caller.
export function summarize(users) {
  const names = []
  for (let i = 0; i <= users.length; i++) {
    names.push(users[i].name)
  }
  return names.join(', ')
}

export function displayName(user) {
  return user.profile.name.trim()
}

export function startPolling(fetchCount) {
  setInterval(fetchCount, 1000)
}
`

writeFileSync(path.join(root, 'src/plan.js'), BASE)
writeFileSync(path.join(root, 'src/unstaged-note.js'), 'export const note = 1\n')
git('add', '-A')
git('commit', '-qm', 'seed')
writeFileSync(path.join(root, 'src/plan.js'), STAGED)
writeFileSync(path.join(root, 'src/unstaged-note.js'), 'export const note = 2 // unstaged distraction\n')
writeFileSync(path.join(root, 'src/untracked.js'), 'export const extra = true // untracked, out of scope\n')
git('add', 'src/plan.js')
console.log(JSON.stringify({ root, staged: git('diff', '--cached', '--name-only').toString().trim() }))
