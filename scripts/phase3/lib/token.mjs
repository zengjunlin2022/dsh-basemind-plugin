// Phase 3 Gate 0 token resolution. Never prints the token value.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function readUserEnv (name) {
  const script = `[Environment]::GetEnvironmentVariable('${name}','User')`
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000
    })
    return out.trim()
  } catch {
    return ''
  }
}

// Returns { token, source }. source is 'process-env' | 'user-env' | 'token-file' | 'none'.
// The token is only ever held in memory.
export function resolveToken () {
  const fromEnv = (process.env.GH_TOKEN || '').trim()
  if (fromEnv) return { token: fromEnv, source: 'process-env' }
  const fromUser = readUserEnv('GH_TOKEN')
  if (fromUser) return { token: fromUser, source: 'user-env' }
  const file = join(homedir(), '.dsh', 'phase3-gh-token')
  if (existsSync(file)) {
    const fromFile = readFileSync(file, 'utf8').trim()
    if (fromFile) return { token: fromFile, source: 'token-file' }
  }
  return { token: '', source: 'none' }
}

export function redact (text, token) {
  if (!token) return text
  return String(text).split(token).join('[REDACTED]')
}

export async function gh (token, path, init = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-basemind-plugin-phase3',
      ...(init.headers || {})
    }
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}
