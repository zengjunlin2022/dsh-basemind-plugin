// Phase 3 D1a: commit the F3 workflow fix through the GitHub REST API and open a PR.
//
// Authorization (plan §30.1 / §30.9): the ONLY remote file this script may change is
// .github/workflows/managed-binary.yml, on refs/heads/phase3/d1-managed-workflow-fix,
// through a pull request whose base is main. It never merges, never pushes to main and
// never force-updates anything. The token is read from memory and never printed.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveToken, gh, redact } from './lib/token.mjs'

const OWNER = 'zengjunlin2022'
const REPO = 'dsh-basemind-plugin'
const BRANCH = 'phase3/d1-managed-workflow-fix'
const FILE = '.github/workflows/managed-binary.yml'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const TITLE = 'fix(ci): 將 MANAGED_DIAGNOSTICS_DIR 由 job env 移到 step env（F3）'
const MESSAGE = TITLE
const BODY = [
  '## 問題',
  '',
  '`managed-binary.yml` 的 job 層 `env:` 讀取 `${{ runner.temp }}`，GitHub 在排程前就拒絕整份檔案：',
  '',
  '```',
  "Invalid workflow file: .github/workflows/managed-binary.yml#L1 (Line: 88, Col: 32): Unrecognized named-value: 'runner'",
  '```',
  '',
  'run `45373407690`（commit `bba170c`）的 `jobs.total_count=0`，managed gate 從未真正執行。',
  '',
  '## 最小修復',
  '',
  '- 移除 job 層 `env:`（GitHub 不允許 job env 使用 `runner` context）。',
  '- `MANAGED_DIAGNOSTICS_DIR` 改掛在真正讀取它的 step：managed gate、Step Summary、失敗 artifact。',
  '- 行為不變：仍是 `${{ runner.temp }}/managed-diagnostics`；測試仍由此變數決定診斷輸出路徑。',
  '',
  '## 驗證',
  '',
  '- 本機 `node --test test/workflows.test.mjs`：11/11 綠（含新增的 job env 靜態守衛）。',
  '- 本機 YAML 解析（PyYAML）通過；`jobs.managed` 已無 `env` 鍵。',
  '- push 後 `GET /actions/runs?branch=` 不應出現 invalid workflow file。',
  '',
  '本 PR 由 Agent 透過 API 建立，**不由 Agent merge**；merge 後才對 `main` dispatch（D1b）。',
].join('\n')

const { token, source } = resolveToken()
if (!token) {
  console.log('D1a: FAIL (no token)')
  process.exit(2)
}
console.log('token source:', source)

function show (label, result) {
  console.log(label + ':', result.status, redact(result.json?.message ?? '', token))
  return result
}

const repo = show('GET repo', await gh(token, `/repos/${OWNER}/${REPO}`))
if (repo.status !== 200) process.exit(3)

const baseRef = show('GET main ref', await gh(token, `/repos/${OWNER}/${REPO}/git/ref/heads/main`))
const baseSha = baseRef.json?.object?.sha
console.log('base sha:', baseSha)

// 1. Branch (idempotent: reuse an existing branch only if it already points at a commit).
const existingRef = await gh(token, `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
if (existingRef.status === 200) {
  console.log('branch exists:', existingRef.json?.object?.sha)
} else if (existingRef.status === 404) {
  const created = show('POST branch', await gh(token, `/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: baseSha }),
  }))
  if (created.status !== 201) process.exit(4)
} else {
  process.exit(4)
}

// 2. Current blob on the branch.
const current = show('GET contents', await gh(token, `/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${encodeURIComponent(BRANCH)}`))
if (current.status !== 200) process.exit(5)
const local = readFileSync(join(ROOT, FILE))
const localB64 = local.toString('base64')

if (localB64.replace(/\s/g, '') === String(current.json?.content ?? '').replace(/\s/g, '')) {
  console.log('file already matches on the branch; nothing to commit')
} else {
  const put = show('PUT contents', await gh(token, `/repos/${OWNER}/${REPO}/contents/${FILE}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: MESSAGE,
      content: localB64,
      branch: BRANCH,
      sha: current.json?.sha,
    }),
  }))
  if (put.status !== 200 && put.status !== 201) process.exit(6)
  console.log('commit sha:', put.json?.commit?.sha)
  console.log('commit verified:', Boolean(put.json?.commit?.verification));
  console.log('commit url:', put.json?.commit?.html_url)
}

// 3. Pull request (idempotent).
const open = await gh(token, `/repos/${OWNER}/${REPO}/pulls?state=open&head=${OWNER}:${BRANCH}`)
let pr = Array.isArray(open.json) ? open.json[0] : undefined
if (!pr) {
  const created = show('POST pull', await gh(token, `/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: TITLE, head: BRANCH, base: 'main', body: BODY }),
  }))
  if (created.status !== 201) process.exit(7)
  pr = created.json
}
console.log('PR:', pr?.html_url, 'number:', pr?.number, 'state:', pr?.state, 'mergeable_state:', pr?.mergeable_state)
console.log('changed files:', pr?.changed_files)
