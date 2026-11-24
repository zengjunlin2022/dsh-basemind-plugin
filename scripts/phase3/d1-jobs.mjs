// Inspect one Actions run: job names, conclusions and failed steps (no secrets).
import { resolveToken, gh } from './lib/token.mjs'

const OWNER = 'zengjunlin2022'
const REPO = 'dsh-basemind-plugin'
const runId = process.argv[2]
if (!runId) {
  console.error('usage: node scripts/phase3/d1-jobs.mjs <run-id>')
  process.exit(2)
}
const { token } = resolveToken()
const run = await gh(token, `/repos/${OWNER}/${REPO}/actions/runs/${runId}`)
console.log('run', run.json?.id, run.json?.name, '| branch=' + run.json?.head_branch, '| event=' + run.json?.event, '| status=' + run.json?.status, '| conclusion=' + run.json?.conclusion)
console.log('url:', run.json?.html_url)
const jobs = await gh(token, `/repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs?per_page=20`)
for (const job of jobs.json?.jobs ?? []) {
  console.log(`job ${String(job.id)} ${job.name}: ${String(job.status)} / ${String(job.conclusion)}`)
  for (const step of job.steps ?? []) {
    const mark = step.conclusion === 'success' ? 'ok  ' : step.conclusion === 'skipped' ? 'skip' : String(step.conclusion)
    console.log(`   [${mark}] ${step.number}. ${step.name}`)
  }
}
