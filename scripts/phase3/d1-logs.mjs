// Download one Actions job log zip with the token kept in memory. Writes bytes only.
import { writeFileSync } from 'node:fs'
import { resolveToken } from './lib/token.mjs'

const OWNER = 'zengjunlin2022'
const REPO = 'dsh-basemind-plugin'
const [jobId, out] = process.argv.slice(2)
if (!jobId || !out) {
  console.error('usage: node scripts/phase3/d1-logs.mjs <job-id> <output.zip>')
  process.exit(2)
}
const { token } = resolveToken()
const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/jobs/${jobId}/logs`, {
  headers: {
    authorization: 'Bearer ' + token,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-basemind-plugin-phase3',
  },
  redirect: 'follow',
})
if (res.status !== 200) {
  console.log('logs download failed:', res.status)
  process.exit(3)
}
const bytes = Buffer.from(await res.arrayBuffer())
writeFileSync(out, bytes)
console.log('wrote', out, bytes.length, 'bytes')
