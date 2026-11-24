// D1a post-push verification: no invalid workflow, and whether a dispatch is even possible.
import { resolveToken, gh } from './lib/token.mjs'

const OWNER = 'zengjunlin2022'
const REPO = 'dsh-basemind-plugin'
const BRANCH = 'phase3/d1-managed-workflow-fix'
const { token, source } = resolveToken()
console.log('token source:', source)

const runs = await gh(token, `/repos/${OWNER}/${REPO}/actions/runs?branch=${encodeURIComponent(BRANCH)}&per_page=10`)
console.log('GET runs(' + BRANCH + '):', runs.status, 'total=' + (runs.json?.total_count ?? 'n/a'))
for (const run of runs.json?.workflow_runs ?? []) {
  console.log('  run', run.id, run.name, '| event=' + run.event, '| status=' + run.status, '| conclusion=' + run.conclusion, '|', run.created_at)
}

const allRuns = await gh(token, `/repos/${OWNER}/${REPO}/actions/runs?per_page=5`)
console.log('GET runs(main, latest 5):', allRuns.status)
for (const run of allRuns.json?.workflow_runs ?? []) {
  console.log('  run', run.id, run.name, '| branch=' + (run.head_branch ?? ''), '| event=' + run.event, '| conclusion=' + run.conclusion)
}

const dispatch = await gh(token, `/repos/${OWNER}/${REPO}/actions/workflows/managed-binary.yml/dispatches`, {
  method: 'POST',
  body: JSON.stringify({ ref: BRANCH }),
})
console.log('POST dispatch(ref=' + BRANCH + '):', dispatch.status, dispatch.status === 204 ? 'accepted' : (dispatch.json?.message ?? ''))
const mainDispatch = await gh(token, `/repos/${OWNER}/${REPO}/actions/workflows/managed-binary.yml/dispatches`, {
  method: 'POST',
  body: JSON.stringify({ ref: 'main' }),
})
console.log('POST dispatch(ref=main):', mainDispatch.status, mainDispatch.status === 204 ? 'accepted' : (mainDispatch.json?.message ?? ''))
