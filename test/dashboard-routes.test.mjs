import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { DASHBOARD_API_BASE, createDashboardRoutes, isLoopbackRequest, registerDashboardRoutes } from '../lib/dashboard/routes.js'
import { DashboardError } from '../lib/dashboard/service.js'

function fakeRequest({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:3000', ...headers }
  stream.socket = { remoteAddress }
  return stream
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    payload: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = { ...this.headers, ...(headers ?? {}) }
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(payload) {
      this.payload = payload ?? ''
      this.writableEnded = true
    },
    on() {
      return this
    },
    json() {
      return JSON.parse(this.payload)
    },
  }
}

/** A Web-server double with the real contract: exact paths are unique. */
function strictWebServer() {
  const table = new Map()
  return {
    register(route) {
      const key = route.kind + ':' + route.path
      if (table.has(key)) throw new Error('webserver: duplicate ' + route.kind + ' route "' + route.path + '"')
      table.set(key, route)
      return () => {
        table.delete(key)
      }
    },
    count() {
      return table.size
    },
  }
}

function routeFor(routes, path, method = 'GET', send = method) {
  const route = routes.find((candidate) => candidate.path === path && candidate.methods.includes(method))
  assert.ok(route, 'missing route ' + method + ' ' + path)
  return {
    route,
    async call(options = {}) {
      const req = fakeRequest({ method: send, url: path, ...options })
      const res = fakeResponse()
      await route.handler(req, res)
      return res
    },
  }
}

const SERVICE = {
  listWorkspaces: () => ({ source: 'workspace-registry', items: [], capabilities: {} }),
  overview: async (id) => ({ workspace: { id }, status: { fileCount: 1 } }),
  diagnostics: async (id) => ({ workspace: { id }, doctor: { ok: true } }),
  statistics: async (id, { window }) => ({ workspace: { id }, window }),
  scanState: async (id) => ({ workspace: { id }, job: null }),
  startScan: async ({ workspaceId, mode, paths }) => ({ taskId: 't1', workspaceId, scanType: mode, scope: paths ?? [] }),
}

test('the route family covers exactly the documented operation set, with unique exact paths', () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  assert.deepEqual(
    routes.map((route) => route.path + ' ' + route.kind).sort(),
    [
      DASHBOARD_API_BASE + '/diagnostics exact',
      DASHBOARD_API_BASE + '/overview exact',
      DASHBOARD_API_BASE + '/scan exact',
      DASHBOARD_API_BASE + '/statistics exact',
      DASHBOARD_API_BASE + '/workspaces exact',
    ].sort(),
  )
  // The real Web server keys exact routes by path alone and throws on a
  // duplicate, so GET and POST /scan must share one registration.
  const paths = routes.map((route) => route.path)
  assert.equal(new Set(paths).size, paths.length, 'every registered path must be unique')
  const scan = routes.find((route) => route.path === DASHBOARD_API_BASE + '/scan')
  assert.deepEqual(scan.methods, ['GET', 'POST'])
  assert.match(DASHBOARD_API_BASE, /^\/api\/dsh-basemind-dashboard$/)
})

test('a non-loopback address is refused with the loopback-only code', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const res = await routeFor(routes, DASHBOARD_API_BASE + '/workspaces').call({ remoteAddress: '10.0.0.5' })
  assert.equal(res.status, 403)
  assert.equal(res.json().code, 'loopback-only')
})

test('a foreign Host header or cross-site marker is refused', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const badHost = await routeFor(routes, DASHBOARD_API_BASE + '/workspaces').call({ headers: { host: 'evil.example:3000' } })
  assert.equal(badHost.status, 403)
  const crossSite = await routeFor(routes, DASHBOARD_API_BASE + '/workspaces').call({ headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  const foreignOrigin = await routeFor(routes, DASHBOARD_API_BASE + '/workspaces').call({ headers: { origin: 'http://evil.example' } })
  assert.equal(foreignOrigin.status, 403)
  assert.equal(isLoopbackRequest(fakeRequest()), true)
})

test('a method outside the whitelist is a 405 with Allow', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const res = await routeFor(routes, DASHBOARD_API_BASE + '/workspaces', 'GET', 'POST').call()
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET')
  assert.equal(res.json().code, 'method-not-allowed')
})

test('the workspaces route returns the catalogue', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const res = await routeFor(routes, DASHBOARD_API_BASE + '/workspaces').call()
  assert.equal(res.status, 200)
  assert.equal(res.json().source, 'workspace-registry')
})

test('a missing workspace parameter is a 400', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const res = await routeFor(routes, DASHBOARD_API_BASE + '/overview').call()
  assert.equal(res.status, 400)
  assert.equal(res.json().code, 'missing-workspace')
})

test('GET routes forward the workspace and window', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const statistics = await routeFor(routes, DASHBOARD_API_BASE + '/statistics').call({ url: DASHBOARD_API_BASE + '/statistics?workspace=ws-1&window=24h' })
  assert.equal(statistics.status, 200)
  assert.deepEqual(statistics.json(), { workspace: { id: 'ws-1' }, window: '24h' })
})

test('POST /scan accepts a JSON object and defaults missing fields', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const res = await routeFor(routes, DASHBOARD_API_BASE + '/scan', 'POST').call({
    body: JSON.stringify({ workspace: 'ws-1', mode: 'incremental', paths: ['src/a.js'] }),
  })
  assert.equal(res.status, 202)
  assert.deepEqual(res.json().job, { taskId: 't1', workspaceId: 'ws-1', scanType: 'incremental', scope: ['src/a.js'] })
})

test('POST /scan without any workspace is a 400', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const res = await routeFor(routes, DASHBOARD_API_BASE + '/scan', 'POST').call({ body: '{}' })
  assert.equal(res.status, 400)
  assert.equal(res.json().code, 'missing-workspace')
})

test('POST /scan refuses a non-object body', async () => {
  const routes = createDashboardRoutes({ service: SERVICE })
  const res = await routeFor(routes, DASHBOARD_API_BASE + '/scan', 'POST').call({ body: '[]' })
  assert.equal(res.status, 400)
  assert.equal(res.json().code, 'bad-body')
})

test('a DashboardError keeps its status and machine code; any other error is a 500', async () => {
  const routes = createDashboardRoutes({
    service: {
      ...SERVICE,
      overview: async () => {
        throw new DashboardError('Unknown workspace id.', 404, 'unknown-workspace')
      },
      diagnostics: async () => {
        throw new Error('boom')
      },
    },
  })
  const notFound = await routeFor(routes, DASHBOARD_API_BASE + '/overview').call({ url: DASHBOARD_API_BASE + '/overview?workspace=ws-1' })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json().code, 'unknown-workspace')
  assert.equal(notFound.json().error, 'Unknown workspace id.')

  const internal = await routeFor(routes, DASHBOARD_API_BASE + '/diagnostics').call({ url: DASHBOARD_API_BASE + '/diagnostics?workspace=ws-1' })
  assert.equal(internal.status, 500)
  assert.equal(internal.json().code, 'internal')
})

test('registering the family starts no query, no timer and no process (plan §38 P1)', () => {
  let calls = 0
  const service = {
    ...SERVICE,
    overview: async () => {
      calls += 1
      return {}
    },
    diagnostics: async () => {
      calls += 1
      return {}
    },
    statistics: async () => {
      calls += 1
      return {}
    },
    scanState: async () => {
      calls += 1
      return {}
    },
  }
  const webServer = strictWebServer()
  registerDashboardRoutes(webServer, createDashboardRoutes({ service }))
  assert.equal(webServer.count(), 5)
  assert.equal(calls, 0)
})

test('registration hands every route to the Web server and returns one disposer each', () => {
  const webServer = strictWebServer()
  const routes = createDashboardRoutes({ service: SERVICE })
  const disposers = registerDashboardRoutes(webServer, routes)
  assert.equal(webServer.count(), routes.length)
  assert.equal(disposers.length, routes.length)
  for (const dispose of disposers) dispose()
  assert.equal(webServer.count(), 0)
})

test('a failing registration rolls back every route it already registered', () => {
  const webServer = strictWebServer()
  // Occupy one path the family also wants: the family's registration must throw
  // the real "duplicate exact route" error and leave nothing of its own behind.
  const blocker = webServer.register({ kind: 'exact', path: DASHBOARD_API_BASE + '/diagnostics', handler() {} })
  const routes = createDashboardRoutes({ service: SERVICE })
  assert.throws(() => registerDashboardRoutes(webServer, routes), /duplicate exact route/)
  assert.equal(webServer.count(), 1, 'only the blocker may remain registered')
  blocker()
  assert.equal(webServer.count(), 0)
})
