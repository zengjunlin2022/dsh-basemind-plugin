// Gate 0: token visibility + GitHub API reachability. Prints no secrets.
import { resolveToken, gh } from './lib/token.mjs'

const OWNER = 'zengjunlin2022'
const REPO = 'dsh-basemind-plugin'

const { token, source } = resolveToken()
console.log('token source:', source)
console.log('token state:', token ? 'set' : 'unset')
if (!token) {
  console.log('GATE0: FAIL (no token)')
  process.exit(2)
}

const repo = await gh(token, `/repos/${OWNER}/${REPO}`)
console.log('GET /repos:', repo.status, repo.json?.full_name ?? '', 'default_branch=', repo.json?.default_branch ?? '')
const workflows = await gh(token, `/repos/${OWNER}/${REPO}/actions/workflows`)
console.log('GET /actions/workflows:', workflows.status, 'total=' + (workflows.json?.total_count ?? 'n/a'))
const ref = await gh(token, `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
console.log('GET /git/ref/heads/main:', ref.status, 'sha=' + (ref.json?.object?.sha ?? 'n/a'))
if (repo.status !== 200) {
  console.log('GATE0: FAIL (' + repo.status + ')')
  process.exit(3)
}
console.log('GATE0: PASS')
