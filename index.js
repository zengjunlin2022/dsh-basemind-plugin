/**
 * dsh-basemind-plugin — workspace-aware BaseMind MCP bridge for DeepSeek Harness.
 *
 * The plugin owns one BaseMind MCP relay (`basemind serve`, stdio JSON-RPC) per
 * workspace root. Tools are discovered from the running BaseMind server, so the
 * exposed set always matches the installed version; nothing is version-gated.
 *
 * Registration surface, all owned by a single `ctx.effect`:
 *   - global tools   `mcp__<serverName>__<tool>`
 *   - one MCP resource provider named `serverName`
 *   - one system-prompt section carrying BaseMind's server instructions
 *   - one `agent/created` listener that retries a failed background startup
 *
 * @module dsh-basemind-plugin
 */
import { Buffer } from 'node:buffer'

import { resolveConfig } from './lib/config.js'
import { readVersion, resolveLaunch, scrubEnv } from './lib/executable.js'
import { createMcpSession } from './lib/mcp-session.js'
import { publicToolName } from './lib/schema.js'
import { createStdioClient } from './lib/stdio-client.js'
import { createToolDefinition } from './lib/tool-bridge.js'
import { createWorkspacePool } from './lib/workspace-pool.js'

export const name = 'dsh-basemind-plugin'

/** Services this plugin cannot work without; `mcpResources` and `agents` stay optional. */
export const inject = ['tools', 'subprocess', 'workingDirectory', 'systemPrompt']

/** BaseMind instructions are truncated above this budget before becoming a prompt section. */
const INSTRUCTIONS_LIMIT_BYTES = 32 * 1024

/** Retry backoff after a failed background startup, index-capped at the last entry. */
const RETRY_DELAYS_MS = [5_000, 30_000, 300_000]

/** Fallback placement of the MCP server instructions section. */
const MCP_SERVERS_ORDER_FALLBACK = 3_100

/**
 * Activate the plugin.
 * @param ctx - cordis context of the plugin row.
 * @param config - raw row config; every field is validated by `resolveConfig`.
 * @returns a promise only when `failOnStartupError` asks for best-effort fail-fast.
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  const settings = resolveConfig(config ?? {}, { logger })
  const serverName = settings.serverName

  const state = {
    disposed: false,
    /** Primary tools/resources/instructions are registered. */
    ready: false,
    /** A terminal condition (tool-name collision) that retrying cannot fix. */
    blocked: false,
    initializing: false,
    /** A newer root (an Agent's working directory) arrived mid-initialization. */
    recheck: false,
    /** Most specific discovery root known so far (an Agent's validated directory). */
    preferredRoot: undefined,
    primaryRoot: undefined,
    primarySession: undefined,
    instructionsRegistered: false,
    resourcesRegistered: false,
    generation: undefined,
    disposers: [],
    syncChain: Promise.resolve(),
    retryIndex: 0,
    retryTimer: undefined,
  }

  const initController = new AbortController()

  const pool = createWorkspacePool({
    config: settings,
    logger,
    createSession,
  })

  /** @returns {string} a short, log-safe message for an unknown error value. */
  function message(error) {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Start (or reuse) the relay for one workspace root.
   * The pool owns the session lifetime; this function only performs the
   * version-independent launch + MCP initialize handshake.
   */
  async function createSession(root, poolSignal) {
    const launch = await resolveLaunch({
      config: settings,
      ctx,
      root,
      signal: poolSignal,
      logger,
    })
    const client = createStdioClient({
      argv: launch.argv,
      cwd: root,
      env: launch.env ?? scrubEnv(process.env, settings.env),
      startupTimeoutMs: settings.startupTimeoutMs,
      toolCallTimeoutMs: settings.toolCallTimeoutMs,
      logger,
      spawn: (spec) => ctx.subprocess.spawn(spec),
      onNotification: (notification) => {
        if (notification.method === 'notifications/tools/list_changed') scheduleToolSync()
      },
      onClose: (error) => {
        if (error === undefined) return
        const tail = settings.logStderr ? ` (stderr tail: ${client.stderrTail.slice(-2048)})` : ''
        logger?.warn?.(`[dsh-basemind-plugin] relay for ${root} closed: ${message(error)}${tail}`)
      },
    })
    const session = createMcpSession(client, { logger, serverName })
    try {
      await session.initialize(poolSignal)
      // Load the tool list for every relay, not only the primary one: the bridge
      // gates each call on `hasTool`, and a fresh relay for a second workspace
      // must know what its own BaseMind version exposes.
      await session.listTools(poolSignal)
    } catch (error) {
      try {
        await session.close()
      } catch (closeError) {
        logger?.debug?.(`[dsh-basemind-plugin] closing a failed relay threw: ${message(closeError)}`)
      }
      throw error
    }
    return session
  }

  /** Register BaseMind's server instructions as a prompt section, once. */
  function registerInstructions(instructions) {
    if (state.instructionsRegistered) return
    if (typeof instructions !== 'string' || instructions.trim() === '') return
    let text = instructions
    if (Buffer.byteLength(text, 'utf8') > INSTRUCTIONS_LIMIT_BYTES) {
      text = Buffer.from(text, 'utf8').subarray(0, INSTRUCTIONS_LIMIT_BYTES).toString('utf8')
      logger?.warn?.(
        `[dsh-basemind-plugin] BaseMind instructions exceed ${String(INSTRUCTIONS_LIMIT_BYTES)} bytes and were truncated for the prompt section`,
      )
    }
    const order = sectionOrder()
    for (const sectionName of [`mcp:${serverName}`, `mcp:${serverName}:plugin`]) {
      try {
        state.disposers.push(ctx.systemPrompt.section({ name: sectionName, order, text, interpolate: false }))
        state.instructionsRegistered = true
        return
      } catch (error) {
        logger?.warn?.(`[dsh-basemind-plugin] prompt section ${sectionName} is unavailable: ${message(error)}`)
      }
    }
  }

  /** Resolve the MCP servers section placement without trusting it to exist. */
  function sectionOrder() {
    try {
      const order = ctx.systemPrompt.getSectionOrder?.('MCP_SERVERS')
      return typeof order === 'number' && Number.isFinite(order) ? order : MCP_SERVERS_ORDER_FALLBACK
    } catch {
      return MCP_SERVERS_ORDER_FALLBACK
    }
  }

  /** Register the resource provider that forwards DSH resource tools to BaseMind, once. */
  function registerResources() {
    if (state.resourcesRegistered) return
    const mcpResources = ctx.get?.('mcpResources')
    if (mcpResources === undefined || mcpResources === null) return
    try {
      const dispose = mcpResources.register(serverName, {
        async request(request, exec) {
          const agent = exec?.agent ?? ctx.get?.('agents')?.currentInitiator?.()
          if (agent === undefined || agent === null) {
            throw new Error(
              'BaseMind resource request requires an Agent to resolve the workspace; no initiating Agent was available',
            )
          }
          const root = await ctx.workingDirectory.ensure(agent, exec.signal)
          const session = await pool.clientFor(root, exec.signal)
          switch (request.method) {
            case 'resources/list':
              return session.listResources(request.cursor, exec.signal)
            case 'resources/templates/list':
              return session.listResourceTemplates(request.cursor, exec.signal)
            case 'resources/read':
              return session.readResource(request.uri, exec.signal)
            default:
              throw new Error(`unsupported MCP resource method: ${String(request.method)}`)
          }
        },
      })
      state.disposers.push(dispose)
      state.resourcesRegistered = true
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] resource provider ${serverName} is unavailable: ${message(error)}`)
    }
  }

  /** Build one tool definition per discovered BaseMind tool, dropping unusable entries. */
  function definitionsFor(rawTools) {
    const seen = new Set()
    const definitions = []
    for (const rawTool of rawTools) {
      let definition
      try {
        definition = createToolDefinition({
          serverName,
          rawTool,
          pool,
          ctx,
          config: settings,
          logger,
        })
      } catch (error) {
        logger?.warn?.(
          `[dsh-basemind-plugin] skipping BaseMind tool ${String(rawTool?.name)}: ${message(error)}`,
        )
        continue
      }
      if (seen.has(definition.name)) {
        logger?.warn?.(`[dsh-basemind-plugin] skipping BaseMind tool with duplicate public name ${definition.name}`)
        continue
      }
      seen.add(definition.name)
      definitions.push(definition)
    }
    return definitions
  }

  /**
   * Public names this generation would register that another provider already owns.
   * @returns the first colliding public name, or `undefined`.
   */
  function findCollision(rawTools) {
    const owned = new Set(
      state.generation === undefined ? [] : state.generation.definitions.map((definition) => definition.name),
    )
    for (const rawTool of rawTools) {
      if (typeof rawTool?.name !== 'string' || rawTool.name === '') continue
      const publicName = publicToolName(serverName, rawTool.name)
      if (owned.has(publicName)) continue
      const existing = ctx.tools.get(publicName)
      if (existing !== undefined && existing !== null) return publicName
    }
    return undefined
  }

  /** Dispose a tool generation in reverse registration order. */
  function disposeGeneration(generation) {
    for (const dispose of [...generation.disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        logger?.warn?.(`[dsh-basemind-plugin] disposing a tool registration threw: ${message(error)}`)
      }
    }
  }

  /** Try to put a previous generation back after a failed registration. */
  function restoreGeneration(previous) {
    const disposers = []
    try {
      for (const definition of previous.definitions) disposers.push(ctx.tools.register(definition))
      state.generation = { definitions: previous.definitions, disposers }
      logger?.warn?.('[dsh-basemind-plugin] restored the previous tool generation after a failed re-registration')
      return true
    } catch (error) {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose()
        } catch {
          // A failed restore leaves the tools absent; the next re-sync retries.
        }
      }
      state.generation = undefined
      logger?.warn?.(`[dsh-basemind-plugin] could not restore the previous tool generation: ${message(error)}`)
      return false
    }
  }

  /**
   * Replace the current tool generation with `definitions`.
   * The previous generation is unloaded before registration because a duplicate
   * name inside one layer is rejected by the registry.
   * @returns {{ok: true} | {ok: false, collision?: string, error?: unknown}} the outcome.
   */
  function installGeneration(definitions) {
    const previous = state.generation
    const owned = new Set(previous === undefined ? [] : previous.definitions.map((definition) => definition.name))
    for (const definition of definitions) {
      if (owned.has(definition.name)) continue
      const existing = ctx.tools.get(definition.name)
      if (existing !== undefined && existing !== null) return { ok: false, collision: definition.name }
    }

    if (previous !== undefined) disposeGeneration(previous)
    const disposers = []
    try {
      for (const definition of definitions) disposers.push(ctx.tools.register(definition))
    } catch (error) {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose()
        } catch {
          // Ignore: the generation is being discarded anyway.
        }
      }
      state.generation = undefined
      if (previous !== undefined) restoreGeneration(previous)
      return { ok: false, error }
    }

    state.generation = { definitions, disposers }
    return { ok: true }
  }

  /** Synchronize the registry with a freshly discovered tool list. */
  function syncTools(rawTools, { initial = false } = {}) {
    if (state.disposed) return { ok: false }
    const definitions = definitionsFor(rawTools)
    if (definitions.length === 0) {
      logger?.warn?.('[dsh-basemind-plugin] BaseMind reported no tools; nothing to register')
      return { ok: false }
    }
    const result = installGeneration(definitions)
    if (!result.ok && result.collision !== undefined) {
      if (initial) {
        state.blocked = true
        logger?.warn?.(
          `[dsh-basemind-plugin] tool ${result.collision} is already registered (an MCP server named ${serverName} is configured); staying inactive to avoid duplicate tools`,
        )
      } else {
        logger?.warn?.(
          `[dsh-basemind-plugin] tool re-sync skipped: ${result.collision} is registered by another provider`,
        )
      }
    } else if (!result.ok && result.error !== undefined) {
      logger?.warn?.(`[dsh-basemind-plugin] tool registration failed: ${message(result.error)}`)
    }
    return result
  }

  /** Serialize `tools/list_changed` re-syncs so generations never interleave. */
  function scheduleToolSync() {
    if (state.disposed) return
    state.syncChain = state.syncChain
      .then(async () => {
        if (state.disposed || state.primarySession === undefined) return
        const rawTools = await state.primarySession.listTools(initController.signal, { refresh: true })
        syncTools(rawTools)
      })
      .catch((error) => {
        logger?.warn?.(`[dsh-basemind-plugin] tool re-sync failed: ${message(error)}`)
      })
  }

  /** Arm one background retry with backoff. */
  function scheduleRetry() {
    if (state.disposed || state.ready || state.blocked) return
    if (state.retryTimer !== undefined) return
    const delay = RETRY_DELAYS_MS[Math.min(state.retryIndex, RETRY_DELAYS_MS.length - 1)]
    state.retryIndex += 1
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      void ensurePrimary()
    }, delay)
    state.retryTimer.unref?.()
  }

  /** Every root worth trying for discovery, most specific first. */
  function candidateRoots() {
    const roots = []
    const seen = new Set()
    const add = (directory) => {
      if (typeof directory !== 'string' || directory === '') return
      const key = directory.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      roots.push(directory)
    }
    // An Agent's validated working directory is the only root a user chose
    // explicitly. The deployment fallback is a guess: under `dsh web` it is the
    // launch directory, which would be the harness checkout itself.
    if (settings.discoveryRoot !== 'default') add(state.preferredRoot)
    if (settings.discoveryRoot !== 'agent') add(ctx.workingDirectory.defaultDirectory)
    return roots
  }

  /**
   * Try to open one root and register its discovery surfaces.
   * @returns {'ready' | 'retry' | 'fatal'} the outcome for the candidate loop.
   */
  async function tryInitialize(root) {
    state.primaryRoot = root
    try {
      const session = await pool.clientFor(root, initController.signal)
      const rawTools = await session.listTools(initController.signal)
      state.primarySession = session

      // Decide the collision question before touching any surface: prompt and
      // resources must not point at a source whose tools are unavailable.
      const collision = findCollision(rawTools)
      if (collision !== undefined) {
        state.blocked = true
        logger?.warn?.(
          `[dsh-basemind-plugin] tool ${collision} is already registered (an MCP server named ${serverName} is configured); staying inactive to avoid duplicate tools`,
        )
        await pool.drop(root)
        state.primarySession = undefined
        return 'fatal'
      }

      // Tools first: the prompt section and the resource provider must only ever
      // point at a registry this plugin actually populated, so a failed
      // generation leaves no instructions from a root that served nothing.
      const result = syncTools(rawTools, { initial: true })
      if (!result.ok) {
        await pool.drop(root)
        state.primarySession = undefined
        return state.blocked ? 'fatal' : 'retry'
      }
      registerInstructions(session.instructions)
      registerResources()
      state.ready = true
      logger?.debug?.(
        `[dsh-basemind-plugin] ready with ${String(state.generation?.definitions.length ?? 0)} tools from ${root}`,
      )
      return 'ready'
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] BaseMind startup failed for ${root}: ${message(error)}`)
      try {
        await pool.drop(root)
      } catch (dropError) {
        logger?.debug?.(`[dsh-basemind-plugin] dropping a failed relay threw: ${message(dropError)}`)
      }
      state.primarySession = undefined
      return 'retry'
    }
  }

  /**
   * Background primary startup: open a relay for the best known root, discover
   * tools, then register prompt/resource/tool surfaces.
   */
  async function ensurePrimary() {
    if (state.disposed || state.ready || state.blocked || state.initializing) return
    // `discoveryRoot: 'agent'` has no root until a session exists; waiting is the
    // point of that mode, so it must not arm a retry loop over nothing.
    if (candidateRoots().length === 0) return
    state.initializing = true
    try {
      for (const root of candidateRoots()) {
        if (state.disposed || state.ready || state.blocked) return
        const outcome = await tryInitialize(root)
        if (outcome === 'ready' || outcome === 'fatal') return
      }
      scheduleRetry()
    } finally {
      state.initializing = false
      if (state.recheck) {
        state.recheck = false
        void ensurePrimary()
      }
    }
  }

  /**
   * Adopt the working directory of a newly created Agent as the preferred
   * discovery root. BaseMind refuses a root that is not a project, and the
   * deployment fallback directory is often exactly such a root.
   */
  async function adoptAgentRoot(agent) {
    if (state.disposed || state.ready || state.blocked) return
    try {
      const directory = await ctx.workingDirectory.ensure(agent, initController.signal)
      if (typeof directory === 'string' && directory !== '') {
        state.preferredRoot = directory
        state.retryIndex = 0
      }
    } catch (error) {
      logger?.debug?.(`[dsh-basemind-plugin] could not resolve an Agent working directory: ${message(error)}`)
      scheduleRetry()
      return
    }
    if (state.initializing) {
      state.recheck = true
      return
    }
    await ensurePrimary()
  }

  /**
   * One background `<exe> --version` probe for diagnostics only. It never gates a
   * feature: the exposed tool set is whatever `tools/list` reports.
   */
  async function probeVersion() {
    try {
      const launch = await resolveLaunch({
        config: settings,
        ctx,
        root: ctx.workingDirectory.defaultDirectory,
        logger,
      })
      const version = await readVersion({ ctx, exe: launch.exe, logger })
      if (version !== undefined) {
        logger?.debug?.(`[dsh-basemind-plugin] BaseMind launcher reports ${version} (${launch.exe})`)
      }
    } catch (error) {
      logger?.debug?.(`[dsh-basemind-plugin] could not read the BaseMind version: ${message(error)}`)
    }
  }

  /** Release everything this plugin registered and every relay it spawned. */
  async function shutdown() {
    state.disposed = true
    initController.abort()
    if (state.retryTimer !== undefined) {
      clearTimeout(state.retryTimer)
      state.retryTimer = undefined
    }
    for (const dispose of [...state.disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        logger?.warn?.(`[dsh-basemind-plugin] disposing a plugin resource threw: ${message(error)}`)
      }
    }
    state.disposers.length = 0
    if (state.generation !== undefined) {
      disposeGeneration(state.generation)
      state.generation = undefined
    }
    // Terminate synchronously first: cleanup may not be awaited by every caller,
    // and `basemind serve` does not exit when its stdin closes.
    try {
      pool.terminateSyncAll()
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] terminating relays threw: ${message(error)}`)
    }
    try {
      await pool.disposeAll()
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] relay cleanup failed: ${message(error)}`)
    }
    state.primarySession = undefined
  }

  let retryListenerDispose
  const effectResult = ctx.effect(() => {
    retryListenerDispose = ctx.on('agent/created', (payload) => {
      if (state.disposed || state.ready || state.blocked) return
      const agent = payload?.agent
      if (agent === undefined || agent === null) {
        scheduleRetry()
        return
      }
      void adoptAgentRoot(agent)
    })
    void ensurePrimary()
    void probeVersion()
    return async () => {
      try {
        retryListenerDispose?.()
      } catch {
        // The listener is owned by this fiber and is already being disposed.
      }
      await shutdown()
    }
  }, 'dsh-basemind-plugin')

  if (settings.failOnStartupError) {
    // Best-effort fail-fast: a loader that awaits `apply` observes the preflight
    // failure. A loader that does not await keeps the background behaviour.
    return (async () => {
      await resolveLaunch({ config: settings, ctx, root: ctx.workingDirectory.defaultDirectory, signal: undefined, logger })
      return effectResult
    })()
  }
  return effectResult
}
