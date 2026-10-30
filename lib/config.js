/**
 * Row-config validation for dsh-basemind-plugin.
 *
 * The bundle exports no `Config` (a local directory bundle cannot resolve
 * `@deepseek-ai/schemastery`), so every field is validated and clamped here
 * instead of by the loader. Unknown fields are ignored; invalid values fall back
 * to the documented default with one warning, because a bad config must not stop
 * the whole harness from starting.
 *
 * @module dsh-basemind-plugin/lib/config
 */

/** Documented defaults; every value is also the fallback for an invalid field. */
export const DEFAULTS = Object.freeze({
  serverName: 'basemind',
  command: 'basemind',
  args: Object.freeze(['serve']),
  env: Object.freeze({}),
  toolCallTimeoutMs: 120_000,
  startupTimeoutMs: 60_000,
  maxClients: 32,
  autoProvision: false,
  npxSpec: 'basemind@latest',
  failOnStartupError: false,
  logStderr: true,
  discoveryRoot: 'agent',
})

/** Tool prefix/name constraints: the value becomes part of `mcp__<name>__<tool>`. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/**
 * How the first relay's workspace root is chosen.
 * - `agent` (default): only an Agent's working directory; nothing starts before a session exists.
 * - `agent-first`: an Agent's directory, then the deployment default directory.
 * - `default`: only the deployment default directory (eager, for launch-dir deployments).
 */
const DISCOVERY_ROOTS = new Set(['agent', 'agent-first', 'default'])

/** Integer with an inclusive range. */
function clampInt(value, { min, max, fallback, name, logger }) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof parsed === 'number' && Number.isFinite(parsed)) {
    const rounded = Math.trunc(parsed)
    const clamped = Math.min(max, Math.max(min, rounded))
    if (clamped !== rounded) logger?.warn?.(`[dsh-basemind-plugin] ${name} ${String(rounded)} was clamped to ${String(clamped)}`)
    return clamped
  }
  if (value !== undefined) logger?.warn?.(`[dsh-basemind-plugin] ${name} must be a number; using ${String(fallback)}`)
  return fallback
}

/** Boolean with a string fallback (`"true"`/`"false"` from YAML-ish sources). */
function readBoolean(value, { fallback, name, logger }) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  if (value !== undefined) logger?.warn?.(`[dsh-basemind-plugin] ${name} must be a boolean; using ${String(fallback)}`)
  return fallback
}

/** Non-empty trimmed string. */
function readString(value, { fallback, name, logger }) {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value !== undefined) logger?.warn?.(`[dsh-basemind-plugin] ${name} must be a non-empty string; using ${String(fallback)}`)
  return fallback
}

/**
 * Validate and clamp one row config.
 * @param raw - the row's `config` object; may be undefined or empty.
 * @param options - `{ logger }` used for one warning per corrected field.
 * @returns a frozen, fully-populated settings object.
 */
export function resolveConfig(raw, { logger } = {}) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && typeof raw === 'object' && Array.isArray(raw)) {
    logger?.warn?.('[dsh-basemind-plugin] config must be an object; using defaults')
  }

  let serverName = DEFAULTS.serverName
  if (input.serverName !== undefined) {
    if (typeof input.serverName === 'string' && SERVER_NAME.test(input.serverName)) serverName = input.serverName
    else logger?.warn?.(`[dsh-basemind-plugin] serverName must match ${SERVER_NAME.source}; using ${DEFAULTS.serverName}`)
  }

  const command = readString(input.command, { fallback: DEFAULTS.command, name: 'command', logger })

  let args = [...DEFAULTS.args]
  if (input.args !== undefined) {
    if (Array.isArray(input.args)) {
      const strings = input.args.filter((value) => typeof value === 'string')
      if (strings.length !== input.args.length) logger?.warn?.('[dsh-basemind-plugin] args entries must be strings; dropping the others')
      args = strings
    } else {
      logger?.warn?.(`[dsh-basemind-plugin] args must be an array of strings; using ${JSON.stringify(DEFAULTS.args)}`)
    }
  }

  const env = {}
  if (input.env !== undefined) {
    if (input.env !== null && typeof input.env === 'object' && !Array.isArray(input.env)) {
      for (const [key, value] of Object.entries(input.env)) {
        if (typeof value === 'string') env[key] = value
        else logger?.warn?.(`[dsh-basemind-plugin] env.${key} must be a string; dropping it`)
      }
    } else {
      logger?.warn?.('[dsh-basemind-plugin] env must be an object of string values; using {}')
    }
  }

  return Object.freeze({
    serverName,
    command,
    args: Object.freeze(args),
    env: Object.freeze(env),
    toolCallTimeoutMs: clampInt(input.toolCallTimeoutMs, {
      min: 1_000,
      max: 3_600_000,
      fallback: DEFAULTS.toolCallTimeoutMs,
      name: 'toolCallTimeoutMs',
      logger,
    }),
    startupTimeoutMs: clampInt(input.startupTimeoutMs, {
      min: 1_000,
      max: 600_000,
      fallback: DEFAULTS.startupTimeoutMs,
      name: 'startupTimeoutMs',
      logger,
    }),
    maxClients: clampInt(input.maxClients, {
      min: 1,
      max: 256,
      fallback: DEFAULTS.maxClients,
      name: 'maxClients',
      logger,
    }),
    autoProvision: readBoolean(input.autoProvision, {
      fallback: DEFAULTS.autoProvision,
      name: 'autoProvision',
      logger,
    }),
    npxSpec: readString(input.npxSpec, { fallback: DEFAULTS.npxSpec, name: 'npxSpec', logger }),
    failOnStartupError: readBoolean(input.failOnStartupError, {
      fallback: DEFAULTS.failOnStartupError,
      name: 'failOnStartupError',
      logger,
    }),
    logStderr: readBoolean(input.logStderr, { fallback: DEFAULTS.logStderr, name: 'logStderr', logger }),
    discoveryRoot: readDiscoveryRoot(input.discoveryRoot, { logger }),
  })
}

/** One of the supported discovery-root strategies, with a warning on an unknown value. */
function readDiscoveryRoot(value, { logger }) {
  if (value === undefined) return DEFAULTS.discoveryRoot
  if (typeof value === 'string' && DISCOVERY_ROOTS.has(value)) return value
  logger?.warn?.(
    `[dsh-basemind-plugin] discoveryRoot must be one of ${[...DISCOVERY_ROOTS].join(', ')}; using ${DEFAULTS.discoveryRoot}`,
  )
  return DEFAULTS.discoveryRoot
}
