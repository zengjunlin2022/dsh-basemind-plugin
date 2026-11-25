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
 *   - one `agent/created` listener that adopts a new Agent's root, waits
 *     (bounded) for the relay whose tools it serves, and retries a failed
 *     background startup
 *
 * @module dsh-basemind-plugin
 */
import { Buffer } from 'node:buffer'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import pkg from './package.json' with { type: 'json' }

import { createBinaryManager, resolveDshHome } from './lib/binary/manager.js'
import { createCliTool } from './lib/cli-tool.js'
import { resolveConfig } from './lib/config.js'
import { resolveLaunch, scrubEnv } from './lib/executable.js'
import { bootstrapText, registerBootstrapSection } from './lib/prompt/bootstrap.js'
import { createBasemindSkillProvider } from './lib/skills/provider.js'
import { renderStatus, statusReport } from './lib/status.js'
import { UPSTREAM } from './lib/upstream.js'
import { createMcpSession } from './lib/mcp-session.js'
import { publicToolName } from './lib/schema.js'
import { createStdioClient } from './lib/stdio-client.js'
import { createToolDefinition } from './lib/tool-bridge.js'
import { createWorkspacePool } from './lib/workspace-pool.js'
import { createScanHistory } from './lib/dashboard/history.js'
import { createDashboardRoutes, registerDashboardRoutes } from './lib/dashboard/routes.js'
import { createDashboardRunner } from './lib/dashboard/run.js'
import { createDashboardService } from './lib/dashboard/service.js'
import { createWorkspaceProvider } from './lib/dashboard/workspaces.js'

export const name = 'dsh-basemind-plugin'

/** Services this plugin cannot work without; `mcpResources` and `agents` stay optional. */
export const inject = ['tools', 'subprocess', 'workingDirectory', 'systemPrompt']

/** BaseMind instructions are truncated above this budget before becoming a prompt section. */
const INSTRUCTIONS_LIMIT_BYTES = 32 * 1024

/** Retry backoff after a failed background startup, index-capped at the last entry. */
const RETRY_DELAYS_MS = [5_000, 30_000, 300_000]

/** Fallback placement of the MCP server instructions section. */
const MCP_SERVERS_ORDER_FALLBACK = 3_100

/** Package root that owns the vendored `skills/` directory. */
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))

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
    /** In-flight primary initialization, so a second creation can wait on it. */
    initPromise: undefined,
    /** Every discovery root that already had an attempt, lower-cased. */
    attemptedRoots: new Set(),
    /** The verified binary selection shared by the relay, CLI tool and status. */
    selection: undefined,
    skillsRegistered: false,
    bootstrapRegistered: false,
    statusRegistered: false,
    dashboardRegistered: false,
    /** The Dashboard service, disposed before the relays on shutdown. */
    dashboard: undefined,
    /** Last selection line already logged, so a replay does not spam the log. */
    selectionLogged: undefined,
  }

  const initController = new AbortController()

  /**
   * One availability signal for every surface: skills, the CLI tool and the
   * bootstrap section appear only while the relay that serves the tools is up.
   */
  const readiness = {
    ready: false,
    onChange(listener) {
      readiness.listeners.add(listener)
      return () => readiness.listeners.delete(listener)
    },
    listeners: new Set(),
    ok() {
      return state.ready && state.selection?.ok === true && state.selection?.compatible !== false
    },
    notify() {
      for (const listener of [...readiness.listeners]) {
        try {
          listener()
        } catch (error) {
          logger?.debug?.(`[dsh-basemind-plugin] an availability listener threw: ${message(error)}`)
        }
      }
    },
  }

  const binaryManager = createBinaryManager({ ctx, config: settings, logger })

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
    const selection = await binaryManager.select(root, poolSignal)
    if (selection?.ok !== true) {
      throw new Error(`BaseMind binary unavailable: ${selection?.reason ?? 'unknown reason'}`)
    }
    if (state.selection?.path !== selection.path || state.selection?.source !== selection.source) {
      state.selection = selection
      const summary = selection.version === undefined
        ? `${selection.source} -> ${selection.path} (version unverified)`
        : `${selection.source} -> ${selection.path} (BaseMind ${selection.version})`
      if (state.selectionLogged !== summary) {
        state.selectionLogged = summary
        logger?.info?.(`[dsh-basemind-plugin] binary: ${summary}`)
      }
      readiness.notify()
    }
    void binaryManager.noteWorkspace?.(root, selection)
    const launch = await resolveLaunch({
      config: settings,
      ctx,
      root,
      signal: poolSignal,
      logger,
      selection,
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
        // A relay that ended on its own can never serve another call. Forget the pool
        // entry (without trying to close the corpse) so the next call builds a fresh
        // relay for this workspace, and stop the dead primary session from being read
        // by the next tool-list re-sync. Deliberate closes pass `undefined` above.
        pool.forget(root)
        if (state.primaryRoot === root) state.primarySession = undefined
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
    const cli = cliDefinition()
    if (cli !== undefined && !owned.has(cli.name)) {
      const existing = ctx.tools.get(cli.name)
      if (existing !== undefined && existing !== null) return cli.name
    }
    return undefined
  }

  /**
   * The argv-only CLI adapter, present only when a verified binary is serving the
   * MCP tools. `any` mode leaves the CLI contract unverified, so it stays off.
   */
  function cliDefinition() {
    if (!settings.cliTool) return undefined
    const selection = state.selection
    // `verified` folds in the policy and the legacy npx case: only a pinned,
    // version-checked binary may expose the CLI contract and the skills text.
    if (selection?.ok !== true || selection.verified !== true) return undefined
    try {
      return createCliTool({ serverName, binary: selection, ctx, config: settings, logger })
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] the BaseMind CLI tool is unavailable: ${message(error)}`)
      return undefined
    }
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
    const cli = cliDefinition()
    if (cli !== undefined) definitions.push(cli)
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
      // Through `startPrimary`, so an Agent created while the retry runs can still be
      // released only after that attempt settles.
      void startPrimary()
    }, delay)
    state.retryTimer.unref?.()
  }

  /** Start (or join) one primary initialization attempt. */
  function startPrimary() {
    if (state.initPromise !== undefined) return state.initPromise
    if (state.disposed || state.ready || state.blocked || state.initializing) return undefined
    const promise = ensurePrimary().finally(() => {
      if (state.initPromise === promise) state.initPromise = undefined
    })
    state.initPromise = promise
    return promise
  }

  /**
   * Settle `promise` within `ms`, treating a timeout or an aborted caller as
   * "did not settle".
   * @returns `{ ok: true, value }` when it settled, `{ ok: false, error? }` otherwise.
   */
  function settleWithin(promise, ms, signal) {
    return new Promise((resolve) => {
      let done = false
      const finish = (outcome) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = () => finish({ ok: false })
      const timer = setTimeout(() => finish({ ok: false }), Math.max(1, ms))
      timer.unref?.()
      signal?.addEventListener?.('abort', onAbort, { once: true })
      promise.then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error }),
      )
    })
  }

  /**
   * Wait for the relay that serves the tools, prompt sections and skills before
   * this Agent's queued work is released, so its first turn is assembled with
   * them.
   *
   * The host awaits serial `agent/created` listeners before releasing queued
   * work, but initialization used to be left in the background: the first turn
   * raced the MCP handshake and lost, showing no BaseMind tools, no bootstrap
   * section and no vendored skills.
   *
   * The wait is bounded. A timeout, a failed or aborted attempt logs one
   * diagnostic and lets the turn proceed exactly as it did before the fix.
   */
  async function waitForPrimary(deadline, signal) {
    if (settings.coldStartTimeoutMs <= 0) return
    let timedOut = false
    while (state.initPromise !== undefined && !state.ready && !state.blocked && !state.disposed) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      const settled = await settleWithin(state.initPromise, remaining, signal)
      if (!settled.ok) {
        timedOut = true
        break
      }
    }
    if (state.ready || state.blocked || state.disposed || signal?.aborted === true) return
    // A settled attempt that failed already logged its own startup warning; only
    // an attempt that outlived the budget needs this one.
    if (!timedOut) return
    logger?.warn?.(
      `[dsh-basemind-plugin] BaseMind was not ready within ${String(settings.coldStartTimeoutMs)} ms; the first turn continues without its tools, instructions and skills`,
    )
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
      registerSkills()
      registerBootstrap()
      state.ready = true
      readiness.ready = true
      readiness.notify()
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
      // A newer root can arrive mid-attempt. Re-running the candidate loop here keeps
      // that second attempt inside the same promise, so the Agent that brought the root
      // keeps awaiting it instead of being released against the failed attempt.
      for (;;) {
        state.recheck = false
        for (const root of candidateRoots()) {
          if (state.disposed || state.ready || state.blocked) return
          state.attemptedRoots.add(root.toLowerCase())
          const outcome = await tryInitialize(root)
          if (outcome === 'ready' || outcome === 'fatal') return
        }
        scheduleRetry()
        if (!state.recheck || state.disposed || state.ready || state.blocked) return
      }
    } finally {
      state.initializing = false
    }
  }

  /**
   * Adopt a working directory that settled after the cold-start budget expired, so a
   * slow or remote `workingDirectory.ensure` costs the first turn its tools but not the
   * whole session.
   */
  function adoptLateDirectory(directory) {
    if (state.disposed || state.ready || state.blocked) return
    if (typeof directory !== 'string' || directory === '') return
    state.preferredRoot = directory
    state.retryIndex = 0
    if (state.initializing) {
      state.recheck = true
      return
    }
    void startPrimary()
  }

  /**
   * Adopt the working directory of a newly created Agent as the preferred
   * discovery root. BaseMind refuses a root that is not a project, and the
   * deployment fallback directory is often exactly such a root.
   */
  async function adoptAgentRoot(agent, signal) {
    if (state.disposed || state.ready || state.blocked) return
    const budget = settings.coldStartTimeoutMs
    const deadline = budget > 0 ? Date.now() + budget : 0
    const directoryPromise = ctx.workingDirectory.ensure(agent, signal ?? initController.signal)
    let directory
    try {
      if (budget > 0) {
        const resolved = await settleWithin(directoryPromise, budget, signal)
        if (!resolved.ok) {
          if (resolved.error !== undefined) {
            logger?.debug?.(`[dsh-basemind-plugin] could not resolve an Agent working directory: ${message(resolved.error)}`)
          } else {
            logger?.debug?.('[dsh-basemind-plugin] resolving the Agent working directory did not settle in time')
            // Bounding the first turn must not abandon the root: when the directory
            // arrives later, this Agent still gets its relay in the background.
            directoryPromise.then(adoptLateDirectory, () => {})
          }
          scheduleRetry()
          return
        }
        directory = resolved.value
      } else {
        directory = await directoryPromise
      }
      if (typeof directory === 'string' && directory !== '') {
        state.preferredRoot = directory
        state.retryIndex = 0
      }
    } catch (error) {
      logger?.debug?.(`[dsh-basemind-plugin] could not resolve an Agent working directory: ${message(error)}`)
      scheduleRetry()
      return
    }
    // A root's first attempt gates the first turn. After that the background retry
    // keeps trying on its own backoff, because blocking every new Agent on a repeated
    // failure would delay every session instead of helping one. A failed attempt for a
    // *different* root (`agent-first` against the deployment default) must not count, and
    // a root this mode would never try (`default` ignores Agent directories) cannot
    // justify a wait either: that attempt could not produce this session's tools.
    const preferred = state.preferredRoot
    const planned =
      typeof preferred === 'string' &&
      preferred !== '' &&
      candidateRoots().some((root) => root.toLowerCase() === preferred.toLowerCase())
    const rootUnseen = planned && !state.attemptedRoots.has(preferred.toLowerCase())
    const gate = budget > 0 && (state.initPromise !== undefined || rootUnseen)
    if (state.initializing) {
      state.recheck = true
    } else if (!state.ready && !state.blocked && !state.disposed) {
      void startPrimary()
    }
    if (gate) await waitForPrimary(deadline, signal)
  }

  /**
   * Register the vendored official skills behind `ctx.skills`, once. The provider
   * returns an empty catalog until a verified binary is actually serving tools.
   */
  function registerSkills() {
    if (state.skillsRegistered || !settings.skills) return
    if (state.selection?.verified !== true) return
    const skills = ctx.get?.('skills')
    if (skills === undefined || skills === null) {
      logger?.debug?.('[dsh-basemind-plugin] ctx.skills is unavailable; official skills are not registered')
      return
    }
    try {
      const control = {}
      const provider = createBasemindSkillProvider({ control, readiness, root: PACKAGE_ROOT, logger })
      const dispose = skills.registerProvider((registered) => {
        control.invalidate = registered?.invalidate
        return provider
      })
      state.disposers.push(dispose)
      state.skillsRegistered = true
      const stopWatching = readiness.onChange(() => control.invalidate?.())
      state.disposers.push(stopWatching)
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] official skills could not be registered: ${message(error)}`)
    }
  }

  /** Register the bootstrap prompt section, once. Its text is empty until ready. */
  function registerBootstrap() {
    if (state.bootstrapRegistered || !settings.bootstrap) return
    try {
      const dispose = registerBootstrapSection(ctx, {
        serverName,
        order: sectionOrder() + 10,
        logger,
        getText: () => {
          if (!readiness.ok()) return ''
          const selection = state.selection
          const verified = settings.binaryPolicy !== 'any' && selection?.verified === true
          return bootstrapText({
            ready: true,
            verified,
            serverName,
            version: verified ? selection?.version ?? UPSTREAM.version : undefined,
            source: verified ? selection?.source : undefined,
            cliToolName: verified && settings.cliTool ? publicToolName(serverName, 'cli') : null,
            skills: settings.skills,
          })
        },
      })
      state.disposers.push(dispose)
      state.bootstrapRegistered = true
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] the bootstrap prompt section is unavailable: ${message(error)}`)
    }
  }

  /** Register the human `/basemind-status` command, once, when DSH offers commands. */
  function registerStatusCommand() {
    if (state.statusRegistered) return
    const commands = ctx.get?.('commands')
    if (commands === undefined || commands === null) {
      logger?.debug?.('[dsh-basemind-plugin] ctx.commands is unavailable; /basemind-status is not registered')
      return
    }
    try {
      const dispose = commands.register({
        name: 'basemind-status',
        description: "Show this machine's BaseMind binary, its version, and whether it matches this plugin",
        handler: async () => {
          const report = await statusReport({ manager: binaryManager, config: settings, platform: process.platform })
          return { kind: 'success', text: renderStatus(report) }
        },
      })
      state.disposers.push(dispose)
      state.statusRegistered = true
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] /basemind-status is unavailable: ${message(error)}`)
    }
  }

  /**
   * Register the optional Dashboard route family.
   *
   * Registration is passive: it creates no service, runs no query and starts no
   * timer until a browser asks for one. The Web server is optional (headless
   * compositions have none), so it is read with `ctx.get` and its absence is a
   * silent, documented degradation — the agent-facing surfaces are unaffected.
   */
  function registerDashboard() {
    if (state.dashboardRegistered || settings.dashboard !== true) return
    let webServer
    try {
      webServer = ctx.get?.('webServer')
    } catch {
      webServer = undefined
    }
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      logger?.debug?.('[dsh-basemind-plugin] ctx.webServer is unavailable; the Dashboard is not registered')
      return
    }
    /** @type {any} */
    let service
    try {
      const history = createScanHistory({
        root: path.join(resolveDshHome(), 'cache', 'dsh-basemind-plugin', 'dashboard'),
        enabled: settings.dashboardHistory === true,
        logger,
      })
      service = createDashboardService({
        workspaces: createWorkspaceProvider({ ctx, logger }),
        history,
        runner: createDashboardRunner({ ctx, logger }),
        selection: () => state.selection,
        plugin: { version: pkg.version, serverName },
        relay: () => ({ relays: pool.size, workspaces: pool.roots }),
        logger,
      })
      const disposers = registerDashboardRoutes(webServer, createDashboardRoutes({ service, logger }))
      state.dashboard = service
      state.dashboardRegistered = true
      state.disposers.push(() => {
        for (const dispose of disposers) dispose()
      })
    } catch (error) {
      // A failed registration must not leave a half-registered route family or an
      // undisposed service behind; registerDashboardRoutes already rolled back.
      state.dashboard = undefined
      state.dashboardRegistered = false
      if (service !== undefined) void service.dispose()
      logger?.warn?.(`[dsh-basemind-plugin] the Dashboard could not be registered: ${message(error)}`)
    }
  }

  /** Release everything this plugin registered and every relay it spawned. */
  async function shutdown() {
    state.disposed = true
    initController.abort()
    // Cancel Dashboard-owned CLI work first: it is this plugin's own child, and
    // the shared daemon it forwards to is never terminated here.
    if (state.dashboard !== undefined) {
      try {
        await state.dashboard.dispose()
      } catch (error) {
        logger?.warn?.(`[dsh-basemind-plugin] disposing the Dashboard threw: ${message(error)}`)
      }
      state.dashboard = undefined
    }
    // Stop a managed download first: relays are cheap to terminate, but a
    // half-written asset would linger in the cache until the next sweep.
    try {
      await binaryManager.dispose()
    } catch (error) {
      logger?.warn?.(`[dsh-basemind-plugin] disposing the binary manager threw: ${message(error)}`)
    }
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
    readiness.ready = false
    readiness.notify()
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
      // The host awaits serial `agent/created` listeners before releasing
      // queued work; returning this promise is what lets the first turn see the
      // relay's tools and prompt sections instead of racing the handshake.
      return adoptAgentRoot(agent, payload?.signal)
    })
    registerStatusCommand()
    registerDashboard()
    // A composition may mount the Web server after this row. Cordis has no generic
    // 'ready' event; `ctx.inject` is the host's own way to wait for an optional
    // service, so it re-runs the (guarded) registration when webServer appears.
    try {
      if (typeof ctx.inject === 'function') ctx.inject(['webServer'], () => { registerDashboard() })
    } catch (error) {
      logger?.debug?.(`[dsh-basemind-plugin] webServer injection is unavailable: ${message(error)}`)
    }
    void startPrimary()
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
      const selection = await binaryManager.select(ctx.workingDirectory.defaultDirectory, undefined)
      if (selection?.ok !== true) {
        throw new Error(`BaseMind binary unavailable: ${selection?.reason ?? 'unknown reason'}`)
      }
      return effectResult
    })()
  }
  return effectResult
}
