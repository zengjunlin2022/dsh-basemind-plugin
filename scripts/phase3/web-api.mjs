// Phase 3 Web API driver: token exchange + unary /api RPC against a running dsh web app.
//
// Contract (from app.asar sources): a unary call POSTs /api/<namespace>/<method> with
// { type: 'client-request', rpcId, method, payload: { args } } and expects
// { rpcId, result: { ok: true, value } | { ok: false, error } }. The Peer is supplied by
// the authenticated connection, not by the payload.
import { randomUUID } from 'node:crypto'

/** Exchange the printed ?token= for the session cookie. */
export async function exchangeToken(base, token) {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = res.headers.getSetCookie?.() ?? []
  if (res.status !== 303 || cookies.length === 0) {
    throw new Error(`token exchange failed: HTTP ${res.status}, cookies=${cookies.length}`)
  }
  return cookies.map((line) => line.split(';')[0]).join('; ')
}

export function createClient({ base, cookie }) {
  async function call(endpoint, args = {}) {
    const rpcId = randomUUID()
    const res = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}: ${text.slice(0, 300)}`)
    const body = JSON.parse(text)
    if (body.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${endpoint}`)
    if (body.result?.ok !== true) throw new Error(`remote error for ${endpoint}: ${JSON.stringify(body.result?.error ?? body).slice(0, 300)}`)
    return body.result.value
  }
  return {
    call,
    // The generated descriptor names its single parameter "request": args = { request }.
    createSession: (request) => call('session/create', { request }),
    prompt: (request) => call('session/prompt', { request }),
    page: (request) => call('session/page', { request }),
    list: (request = {}) => call('session/list', { request }),
    cancel: (request) => call('session/cancel', { request }),
  }
}

export function cookieFromLog(line) {
  const token = /token=([A-Za-z0-9_-]+)/.exec(line)?.[1]
  const base = /http:\/\/127\.0\.0\.1:(\d+)/.exec(line)?.[0]
  if (!token || !base) throw new Error('could not parse the web URL from the log')
  return { base, token }
}
