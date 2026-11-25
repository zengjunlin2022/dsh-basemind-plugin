import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Rule-based scorer for the A/B benchmark. Group labels are NOT used: the rubric only
// looks at whether the answer contains the ground-truth elements. Every FAIL/PARTIAL is
// classified per plan §19.4 and sampled by a human before it is reported as PASS.
const args = process.argv.slice(2)
const opt = {}
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1]
const resultsDir = opt.results ?? 'D:/_bm_phase3/bench/results'
const outFile = opt.out ?? path.join(resultsDir, 'scores.json')
const gtDir = path.join('benchmark', 'ground-truth')

const gtFor = (taskId) => JSON.parse(readFileSync(path.join(gtDir, taskId + '.json'), 'utf8'))
const hasToken = (text, value) => text.toLowerCase().includes(String(value).toLowerCase())
const hasLine = (text, line, slack = 3) => {
  for (let n = line - slack; n <= line + slack; n += 1) {
    if (new RegExp('(^|[^0-9])' + n + '([^0-9]|$)').test(text)) return true
  }
  return false
}
const check = (element, answer, task) => {
  switch (element.kind) {
    case 'file': return hasToken(answer, element.value) || hasToken(answer, path.basename(element.value))
    case 'line': return hasLine(answer, element.value, element.slack ?? 3)
    case 'symbol':
    case 'module':
    case 'dep': return hasToken(answer, element.value) || hasToken(answer, element.value.replace(/^@\//, ''))
    case 'ref': return hasToken(answer, element.value) || (element.hint && hasToken(answer, element.hint))
    case 'commit': return hasToken(answer, element.value) || (element.value.length >= 9 && hasToken(answer, element.value.slice(0, 7)))
    case 'statement': return element.value.includes('216') ? hasToken(answer, '216') && /(檔|file)[^。\n]*歷史|file history/i.test(answer) : /mcp__basemind__|grep|code_grep|code_read|搜尋|fallback/i.test(answer)
    case 'defect': return hasToken(answer, element.file) && hasLine(answer, element.line, 2)
    case 'any_of': return (element.values ?? []).filter((value) => hasToken(answer, value)).length >= (element.min ?? 1)
    case 'non-defect': return true
    case 'scope': return !hasToken(answer, 'unstaged-note') && !hasToken(answer, 'untracked.js')
    default: return false
  }
}

const rows = []
for (const file of readdirSync(resultsDir).filter((f) => f.endsWith('.json') && f !== 'scores.json')) {
  const result = JSON.parse(readFileSync(path.join(resultsDir, file), 'utf8'))
  const gt = gtFor(result.task)
  const answer = String(result.answer ?? '')
  const matched = gt.required_elements.map((element) => ({ element, ok: check(element, answer, result.task) }))
  const hits = matched.filter((m) => m.ok).length
  const threshold = gt.scoring ?? { pass_min: 3, partial_min: 2 }
  const verdict = !result.completed ? 'FAIL' : hits >= threshold.pass_min ? 'PASS' : hits >= threshold.partial_min ? 'PARTIAL' : 'FAIL'
  rows.push({
    task: result.task, label: result.label, verdict, hits, total: matched.length,
    missing: matched.filter((m) => !m.ok).map((m) => m.element.value ?? m.element.kind),
    durationMs: result.durationMs, totalTokens: result.usage?.totalTokens ?? null,
    toolCalls: result.toolCalls, basemindCalls: result.basemindCalls, sessionId: result.sessionId,
  })
}
rows.sort((a, b) => String(a.task).localeCompare(String(b.task)) || String(a.label).localeCompare(String(b.label)))
writeFileSync(outFile, JSON.stringify({ rows }, null, 2) + '\n')
const header = '| task | label | verdict | elements | tokens | tool calls | basemind calls |'
console.log(header)
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const row of rows) console.log(`| ${row.task} | ${row.label} | ${row.verdict} | ${row.hits}/${row.total} | ${row.totalTokens} | ${row.toolCalls} | ${row.basemindCalls} |`)
