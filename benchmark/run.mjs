import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { exchangeToken, createClient, cookieFromLog } from '../scripts/phase3/web-api.mjs'
import { decodeFrames } from '../scripts/phase3/session-usage.mjs'

// Runs one benchmark task against an already-running profile instance.
//   node benchmark/run.mjs --task B1-java-symbol --log <web log> --out <result.json> [--cwd <dir>] [--label A-deepseek]
// It creates a fresh session in the task's repository, sends the frozen prompt, waits
// for the turn to end, then stores the metrics a later scoring pass needs.
const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1]
if (!opt.task || !opt.log || !opt.out) {
  console.error('usage: run.mjs --task <id> --log <web-log> --out <result.json> [--cwd <dir>] [--label <label>] [--timeout-ms N]')
  process.exit(2)
}
const taskFile = path.join('benchmark', 'tasks', opt.task + '.json')
const task = JSON.parse(readFileSync(taskFile, 'utf8'))
const cwd = opt.cwd ?? (String(task.cwd).startsWith('SETUP:') ? path.join(os.tmpdir(), String(task.cwd).slice(6)) : task.cwd)
const timeoutMs = Number(opt['timeout-ms'] ?? 1_800_000)
const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const projectDir = '--' + String(cwd).replace(/[\\/:]+/g, '-') + '--'
const sessionLog = (sessionId) => path.join(home, 'sessions', projectDir, sessionId, 'session.v4.jsonl.zstd')

const { base, token } = cookieFromLog(readFileSync(opt.log, 'utf8'))
const cookie = await exchangeToken(base, token)
const api = createClient({ base, cookie })

const nodesOf = (file) => {
  try {
    const { text } = decodeFrames(readFileSync(file))
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
const textOf = (payload) => (Array.isArray(payload?.content) ? payload.content.filter((p) => p?.type === 'text').map((p) => p?.text ?? '').join('') : (payload?.text ?? ''))

const started = Date.now()
const created = await api.createSession({ cwd })
const createMs = Date.now() - started
await api.prompt({ requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: task.prompt }] })

const log = sessionLog(created.sessionId)
let turnEnds = 0
let answer = ''
for (;;) {
  const nodes = nodesOf(log)
  turnEnds = nodes.filter((n) => n.type === 'turn/end').length
  if (turnEnds > 0) {
    const last = nodes.filter((n) => n.type === 'assistant/message').slice(-1)[0]
    answer = textOf(last?.data?.message).trim()
    break
  }
  if (Date.now() - started > timeoutMs) break
  await new Promise((r) => setTimeout(r, 1500))
}
const durationMs = Date.now() - started
const nodes = nodesOf(log)
const usageTotals = nodes.filter((n) => n.type === 'assistant/message' && n.data?.usage).reduce((acc, n) => {
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) acc[key] = (acc[key] ?? 0) + (n.data.usage[key] ?? 0)
  return acc
}, {})
const calls = nodes.filter((n) => n.type === 'tool/call').map((n) => n.data?.name)
const results = nodes.filter((n) => n.type === 'tool/result')
const errors = results.filter((n) => n.data?.message?.isError === true || /\berror\b/i.test(textOf(n.data?.message).slice(0, 200))).length
const systemBytes = nodes.filter((n) => n.type === 'system/message').map((n) => Buffer.byteLength(textOf(n.data?.message), 'utf8'))
const catalogBytes = nodes.filter((n) => n.type === 'user/message' && String(n.data?.message?.source?.kind ?? '') === 'skill-catalog').map((n) => Buffer.byteLength(textOf(n.data.message), 'utf8'))
const header = nodes.find((n) => n.type === 'request/header')
const schemaBytes = header ? Buffer.byteLength(JSON.stringify(header.data?.header?.tools ?? []), 'utf8') : 0
const byName = {}
for (const name of calls) byName[name] = (byName[name] ?? 0) + 1

const result = {
  task: task.id,
  label: opt.label ?? null,
  model: nodes.find((n) => n.type === 'assistant/message')?.data?.message?.source?.model ?? null,
  provider: nodes.find((n) => n.type === 'assistant/message')?.data?.message?.source?.provider ?? null,
  cwd,
  sessionId: created.sessionId,
  startedAt: new Date(started).toISOString(),
  createMs,
  durationMs,
  turnEnds,
  completed: turnEnds > 0,
  usage: usageTotals,
  toolCalls: calls.length,
  toolCallsByName: byName,
  toolResults: results.length,
  toolErrors: errors,
  basemindCalls: calls.filter((n) => String(n).startsWith('mcp__basemind__') && n !== 'mcp__basemind__cli').length,
  basemindCliCalls: calls.filter((n) => n === 'mcp__basemind__cli').length,
  nativeCalls: calls.filter((n) => !String(n).startsWith('mcp__basemind__')).length,
  skillLoads: nodes.filter((n) => n.type === 'tool/call' && n.data?.name === 'skill').length,
  systemBytes,
  catalogBytes,
  schemaBytes,
  sessionLog: log,
  answer,
}
mkdirSync(path.dirname(opt.out), { recursive: true })
writeFileSync(opt.out, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ task: result.task, label: result.label, sessionId: result.sessionId, completed: result.completed, durationMs, totalTokens: usageTotals.totalTokens, toolCalls: calls.length, basemindCalls: result.basemindCalls }))
