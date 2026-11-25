/**
 * The Dashboard's Host route family: @@/api/dsh-basemind-dashboard/*@@.
 *
 * A narrow, fixed operation set (plan §16): the client can list workspaces by id,
 * read four bounded views and submit one scan. There is no arbitrary CLI verb, no
 * arbitrary cwd, no environment and no raw MCP forwarding. Every route is a
 * loopback-only GET (plus the one POST that starts a scan), reads a bounded JSON
 * body, and maps failures to one @@{ error, code }@@ shape.
 *
 * @module dsh-basemind-plugin/lib/dashboard/routes
 */
import { DashboardError } from './service.js'

/** Base path of the route family; the client mirrors it and the parity test pins both. */
export const DASHBOARD_API_BASE = '/api/dsh-basemind-dashboard'

const MAX_BODY_BYTES = 64 * 1024

/** Loopback literal check plus browser same-origin markers (the dsh-ssh fence). */
export function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read a bounded JSON object body; anything else is a 400. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** One declared route: fence, method whitelist, one error mapping. */
function endpoint({ path, methods }, handler) {
  return {
    kind: 'exact',
    path,
    methods: [...methods],
    async handler(req, res) {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only', code: 'loopback-only' })
        return
      }
      const method = (req.method ?? 'GET').toUpperCase()
      if (!methods.includes(method)) {
        res.setHeader('allow', methods.join(', '))
        writeJson(res, 405, { error: 'method not allowed', code: 'method-not-allowed' })
        return
      }
      // A client that goes away cancels a safe read; a submitted scan keeps running.
      const controller = new AbortController()
      req.on('aborted', () => {
        controller.abort()
      })
      res.on('close', () => {
        if (res.writableEnded !== true) controller.abort()
      })
      try {
        await handler({ req, res, method, url: new URL(req.url ?? path, 'http://127.0.0.1'), signal: controller.signal })
      } catch (error) {
        if (error instanceof DashboardError) {
          writeJson(res, error.status, { error: error.message, code: error.code })
          return
        }
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error), code: 'internal' })
      }
    },
  }
}

/**
 * Build the Dashboard route table.
 * @param {{ service: object, logger?: any }} options
 */
export function createDashboardRoutes({ service, logger } = {}) {
  if (service === undefined) throw new TypeError('createDashboardRoutes needs a service')

  const workspaceId = (url) => {
    const value = url.searchParams.get('workspace')
    if (value === null || value === '') throw new DashboardError('The workspace parameter is required.', 400, 'missing-workspace')
    return value
  }

  return [
    endpoint({ path: DASHBOARD_API_BASE + '/workspaces', methods: ['GET'] }, async ({ res }) => {
      writeJson(res, 200, service.listWorkspaces())
    }),

    endpoint({ path: DASHBOARD_API_BASE + '/overview', methods: ['GET'] }, async ({ res, url, signal }) => {
      const refresh = url.searchParams.get('refresh') === '1'
      writeJson(res, 200, await service.overview(workspaceId(url), { refresh, signal }))
    }),

    endpoint({ path: DASHBOARD_API_BASE + '/diagnostics', methods: ['GET'] }, async ({ res, url, signal }) => {
      writeJson(res, 200, await service.diagnostics(workspaceId(url), { signal }))
    }),

    endpoint({ path: DASHBOARD_API_BASE + '/statistics', methods: ['GET'] }, async ({ res, url, signal }) => {
      const window = url.searchParams.get('window') ?? 'today'
      writeJson(res, 200, await service.statistics(workspaceId(url), { window, signal }))
    }),

    // ONE exact route for /scan: the Web server keys exact routes by path alone
    // and throws on a duplicate path, so GET and POST share the registration and
    // the method whitelist.
    endpoint({ path: DASHBOARD_API_BASE + '/scan', methods: ['GET', 'POST'] }, async ({ res, url, req, method }) => {
      if (method === 'GET') {
        writeJson(res, 200, await service.scanState(workspaceId(url)))
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) throw new DashboardError('The request body must be a JSON object under 64 KiB.', 400, 'bad-body')
      const bodyId = typeof body.workspace === 'string' && body.workspace !== '' ? body.workspace : undefined
      const queryId = url.searchParams.get('workspace')
      const id = bodyId === undefined ? (queryId === null ? undefined : queryId) : bodyId
      if (id === undefined || id === '') throw new DashboardError('The workspace parameter is required.', 400, 'missing-workspace')
      const job = await service.startScan({ workspaceId: id, mode: body.mode, paths: body.paths })
      logger?.debug?.('[dsh-basemind-plugin] dashboard: scan started ' + job.taskId)
      writeJson(res, 202, { job })
    }),
  ]
}

/**
 * Register the route table on the host Web server.
 * @param {{ register: (route: object) => () => void }} webServer
 * @param {Array<object>} routes
 * @returns {Array<() => void>} one disposer per route
 */
export function registerDashboardRoutes(webServer, routes) {
  const disposers = []
  try {
    for (const route of routes) disposers.push(webServer.register(route))
    return disposers
  } catch (error) {
    // All or nothing: a partially registered family would leave routes pointing
    // at a service the caller is about to dispose.
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // the server may already have dropped the route
      }
    }
    throw error
  }
}
