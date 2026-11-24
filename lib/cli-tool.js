/**
 * The argv-only BaseMind CLI adapter (`mcp__<server>__cli`).
 *
 * BaseMind exposes a few advanced analyses only on its CLI, not over MCP. This
 * tool runs the same verified binary the MCP relay uses, so a session never has
 * to trust whatever `basemind` happens to sit on PATH. Arguments are passed as
 * argv; there is no shell, no cwd parameter, no env parameter and no stdin.
 *
 * Only read-only verbs are admitted. The denylist wins over the allowlist, and a
 * refused verb becomes an `isError` envelope instead of a thrown error, so the
 * model sees exactly why it was refused.
 *
 * @module dsh-basemind-plugin/lib/cli-tool
 */

import { projectContent } from './result.js'
import { publicToolName } from './schema.js'
import { buildLaunchArgv } from './executable.js'

/** Result envelope shared with the MCP tools; `text` is what the model reads. */
const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    content: { type: 'array', items: { description: 'MCP content block.' } },
    isError: { type: 'boolean' },
    structuredContent: {
      description: 'MCP structuredContent for this result, when the server sends one.',
    },
  },
  required: ['text', 'content', 'isError'],
})

/** stdout budget before DSH spills to disk. */
const STDOUT_MAX_BYTES = 64 * 1024

/** stderr budget kept inline in the result. */
const STDERR_MAX_BYTES = 8 * 1024

/** Spill-file budget for the full stdout stream. */
const SPILL_MAX_BYTES = 2 * 1024 * 1024

/** Grace period before a terminated CLI process is force-killed. */
const GRACE_MS = 2000

/** Lower bound accepted for `timeout_ms`. */
const MIN_TIMEOUT_MS = 1000

/** Upper bound accepted for `timeout_ms` before the configured ceiling applies. */
const MAX_REQUEST_TIMEOUT_MS = 600000

/** How long to wait for the process to exit after terminate(). */
const TERMINATE_WAIT_MS = 2000

/** `code` subcommands that only read. */
const CODE_READ_VERBS = new Set([
  'outline',
  'symbols',
  'read',
  'grep',
  'search',
  'refs',
  'callers',
  'implementations',
  'dependents',
  'definition',
  'find',
  'files',
  'chunk',
  'impact',
  'cycles',
  'explain',
  'deadcode',
])

/** `git` subcommands that only read. */
const GIT_READ_VERBS = new Set([
  'log',
  'blame',
  'diff',
  'status',
  'recent',
  'touching',
  'search',
  'show',
  'symbol-history',
  'blame-symbol',
  'diff-outline',
  'churn',
  'hotspots',
  'by-path',
])

/** `memory` subcommands that only read. */
const MEMORY_READ_VERBS = new Set(['search', 'get', 'list'])

/** `memory` subcommands that write or delete. */
const MEMORY_DENIED_VERBS = new Set(['put', 'documents', 'delete', 'clear'])

/** `admin` subcommands that only read. */
const ADMIN_READ_VERBS = new Set(['repo', 'telemetry', 'tokens', 'eval'])

/** Commands that do not take a read-only subcommand. */
const STANDALONE_VERBS = new Set([
  'status',
  'doctor',
  'overview',
  'statusline',
  'sessions',
  'manual',
  'man',
  'completions',
])

/** Machine-global or mutating top-level verbs refused anywhere in argv. */
const DENIED_VERBS = new Set([
  'init',
  'scan',
  'rescan',
  'watch',
  'serve',
  'hook',
  'lang',
  'daemon',
  'comms',
  'agent',
  'workspace',
])

/** One-line allowlist summary reused in every refusal. */
const ALLOWED_SUMMARY =
  'code <outline|symbols|read|grep|search|refs|callers|implementations|dependents|definition|find|files|chunk|impact|cycles|explain|deadcode>, ' +
  'code migration check, ' +
  'git <log|blame|diff|status|recent|touching|search|show|symbol-history|blame-symbol|diff-outline|churn|hotspots|by-path>, ' +
  'memory <search|get|list>, docs search, cache stats, ' +
  'admin <repo|telemetry|tokens|eval>, status, doctor, overview, statusline, sessions, ' +
  'manual, man, completions, upgrade --plan'

/** @param {unknown} value @returns {boolean} true for object literals only. */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** @param {unknown} error @returns {string} a short message for a thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {unknown} value @returns {string} the trailing-whitespace-free text. */
function trimEnd(value) {
  return typeof value === 'string' ? value.replace(/\s+$/, '') : ''
}

/**
 * Refuse a destructive verb with the plan's fixed, actionable wording.
 * @param {string} message the sentence after the `dsh-basemind-plugin: ` prefix.
 * @returns {{ ok: false, message: string }}
 */
function refusal(message) {
  return { ok: false, message: 'dsh-basemind-plugin: ' + message + ' Allowed: ' + ALLOWED_SUMMARY + '.' }
}

/**
 * Classify an argv as allowed or refused. The denylist is evaluated first; an
 * unknown read-shaped verb is refused too, but with the non-destructive wording.
 *
 * @param {string[]} argv
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function validateArgv(argv) {
  const lower = argv.map((token) => token.toLowerCase())

  for (const token of lower) {
    if (token === '--root' || token.startsWith('--root=')) {
      return refusal(
        '"--root" is not accepted: the workspace always comes from the session Agent, never from the arguments.',
      )
    }
  }

  for (let index = 0; index < lower.length; index += 1) {
    if (argv[index].startsWith('-')) continue
    if (DENIED_VERBS.has(lower[index])) {
      return refusal('"' + lower[index] + '" is a destructive machine-global command; run it yourself in a terminal.')
    }
  }

  const first = lower[0]
  const second = lower[1]

  if (first === 'memory' && MEMORY_DENIED_VERBS.has(second)) {
    return refusal('"memory ' + second + '" is a destructive machine-global command; run it yourself in a terminal.')
  }
  if (first === 'cache' && (second === 'gc' || second === 'clear')) {
    return refusal('"cache ' + second + '" is a destructive machine-global command; run it yourself in a terminal.')
  }
  if (first === 'upgrade' && !lower.includes('--plan')) {
    return refusal('"upgrade" without --plan would modify the machine-global installation; run it yourself in a terminal, or use "upgrade --plan" to preview.')
  }
  if (first === 'admin' && !ADMIN_READ_VERBS.has(second)) {
    return refusal('"admin ' + (second === undefined ? '' : second) + '" is not a read-only admin subcommand; run it yourself in a terminal.')
  }

  if (STANDALONE_VERBS.has(first)) return { ok: true }
  if (first === 'upgrade' || first === 'admin') return { ok: true }

  if (first === 'code') {
    if (second === 'migration') {
      if (lower[2] === 'check') return { ok: true }
      return refusal('"code migration" only supports the read-only "check" subcommand.')
    }
    if (CODE_READ_VERBS.has(second)) return { ok: true }
    return refusal('"code ' + (second === undefined ? '' : second) + '" is not an allowed read-only BaseMind verb.')
  }

  if (first === 'git') {
    if (GIT_READ_VERBS.has(second)) return { ok: true }
    return refusal('"git ' + (second === undefined ? '' : second) + '" is not an allowed read-only BaseMind verb.')
  }

  if (first === 'memory') {
    if (MEMORY_READ_VERBS.has(second)) return { ok: true }
    return refusal('"memory ' + (second === undefined ? '' : second) + '" is not an allowed read-only BaseMind verb.')
  }

  if (first === 'docs') {
    if (second === 'search') return { ok: true }
    return refusal('"docs ' + (second === undefined ? '' : second) + '" is not an allowed read-only BaseMind verb.')
  }

  if (first === 'cache') {
    if (second === 'stats') return { ok: true }
    return refusal('"cache ' + (second === undefined ? '' : second) + '" is not an allowed read-only BaseMind verb.')
  }

  return refusal('"' + first + '" is not an allowed read-only BaseMind verb.')
}

/**
 * Resolve the Agent whose working directory owns this call, using the same
 * fallback as lib/tool-bridge.js.
 * @returns {unknown} the Agent, or undefined.
 */
function resolveAgent(ctx, exec) {
  if (exec !== undefined && exec !== null && exec.agent !== undefined && exec.agent !== null) {
    return exec.agent
  }
  try {
    return ctx.get?.('agents')?.currentInitiator?.()
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} binary selection object or executable path.
 * @returns {string|undefined}
 */
function binaryPath(binary) {
  if (typeof binary === 'string' && binary !== '') return binary
  if (isPlainObject(binary) && typeof binary.path === 'string' && binary.path !== '') return binary.path
  return undefined
}

/**
 * @param {unknown} requested
 * @param {unknown} configured
 * @returns {number} the effective timeout, bounded by the configured ceiling.
 */
function effectiveTimeout(requested, configured) {
  const ceiling =
    Number.isFinite(configured) && configured > 0
      ? Math.max(MIN_TIMEOUT_MS, Math.trunc(configured))
      : MAX_REQUEST_TIMEOUT_MS
  const requestedMs = Number.isFinite(requested) ? Math.trunc(requested) : ceiling
  return Math.min(ceiling, Math.max(MIN_TIMEOUT_MS, Math.min(MAX_REQUEST_TIMEOUT_MS, requestedMs)))
}

/**
 * Wait for one spawn handle without exceeding the timeout.
 * @returns {Promise<{ kind: 'exit', info: any } | { kind: 'timeout' } |
 *   { kind: 'aborted' } | { kind: 'error', error: unknown }>}
 */
function waitForSettle(handle, timeoutMs, signal) {
  if (signal?.aborted === true) return Promise.resolve({ kind: 'aborted' })
  const done = handle?.done
  if (done === undefined || done === null || typeof done.then !== 'function') {
    return Promise.resolve({ kind: 'exit', info: undefined })
  }
  return new Promise((resolve) => {
    let settled = false
    let timer
    const onAbort = () => {
      finish({ kind: 'aborted' })
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        signal?.removeEventListener?.('abort', onAbort)
      } catch {
        // ignore: a foreign AbortSignal implementation may not support removal
      }
      resolve(value)
    }
    timer = setTimeout(() => {
      finish({ kind: 'timeout' })
    }, timeoutMs)
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true })
    } catch {
      // ignore: a foreign AbortSignal implementation may not support listeners
    }
    Promise.resolve(done).then(
      (info) => {
        finish({ kind: 'exit', info })
      },
      (error) => {
        finish({ kind: 'error', error })
      },
    )
  })
}

/**
 * Read one collected stream defensively.
 * @returns {{ text: string, lossy: boolean, spillPath: string|undefined }}
 */
function readStream(handle, name) {
  const empty = { text: '', lossy: false, spillPath: undefined }
  const collected = handle?.collected?.[name]
  if (collected === undefined || collected === null || typeof collected.readFrom !== 'function') {
    return empty
  }
  try {
    const read = collected.readFrom(0)
    if (!isPlainObject(read)) return empty
    return {
      text: typeof read.text === 'string' ? read.text : '',
      lossy: read.lossy === true,
      spillPath: typeof read.spillPath === 'string' && read.spillPath !== '' ? read.spillPath : undefined,
    }
  } catch {
    return empty
  }
}

/**
 * Build the canonical envelope from a final text and error flag.
 * @param {string} text
 * @param {boolean} isError
 * @returns {{ text: string, content: unknown[], isError: boolean }}
 */
function envelope(text, isError) {
  return { text, content: [], isError }
}

/** Refuse one call with the plugin's diagnostic prefix. */
function fail(message) {
  return envelope('dsh-basemind-plugin: ' + message, true)
}

/**
 * Create the argv-only BaseMind CLI tool definition.
 *
 * @param {{ serverName: string, binary: { path?: string }|string, ctx: any,
 *           config?: { toolCallTimeoutMs?: number }, logger?: any }} options
 * @returns {object} a complete DSH ToolDefinition.
 */
export function createCliTool({ serverName, binary, ctx, config, logger } = {}) {
  const toolName = publicToolName(serverName, 'cli')
  const configuredTimeoutMs = isPlainObject(config) ? config.toolCallTimeoutMs : undefined

  return {
    name: toolName,
    description:
      'Run the BaseMind CLI verb (same verified binary as the MCP tools): ' +
      'advanced analysis that has no MCP tool — code explain/impact/deadcode/cycles/' +
      'migration check, overview, git hotspots, doctor, status, upgrade --plan, manual. ' +
      'Read-only verbs only. Arguments are passed as argv, never through a shell.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Full argv after the program name, for example ["code","explain","lib/x.js"].',
        },
        timeout_ms: { type: 'integer', minimum: MIN_TIMEOUT_MS, maximum: MAX_REQUEST_TIMEOUT_MS },
      },
      required: ['args'],
    },
    output: {
      schema: RESULT_SCHEMA,
      render(_args, value) {
        return projectContent(value)
      },
    },
    timeoutMs:
      (Number.isFinite(configuredTimeoutMs) ? configuredTimeoutMs : 120000) + 5000,
    // Only read-only verbs are admitted, so concurrent calls are safe.
    isConcurrencySafe() {
      return true
    },
    async execute(input, exec) {
      const parsed = input === undefined || input === null ? {} : input
      if (!isPlainObject(parsed)) {
        return fail('the cli tool requires a JSON object argument.')
      }

      const rawArgs = parsed.args
      if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
        return fail('the cli tool requires a non-empty "args" array of strings.')
      }
      const argv = []
      for (const token of rawArgs) {
        if (typeof token !== 'string' || token === '' || token.includes(String.fromCharCode(0))) {
          return fail('every "args" entry must be a non-empty string without NUL characters.')
        }
        argv.push(token)
      }

      const validation = validateArgv(argv)
      if (!validation.ok) return envelope(validation.message, true)

      if (exec?.signal?.aborted === true) {
        return fail('the BaseMind CLI call was cancelled before it started.')
      }

      const agent = resolveAgent(ctx, exec)
      if (agent === undefined) {
        return fail('the cli tool needs a live Agent to resolve its workspace; none was available for this call.')
      }

      let root
      try {
        root = await ctx.workingDirectory.ensure(agent, exec?.signal)
      } catch (error) {
        return fail('could not resolve the workspace for this call: ' + describe(error) + '.')
      }

      const exe = binaryPath(binary)
      if (exe === undefined) {
        return fail('no verified BaseMind binary is selected; the MCP relay and this tool share one binary.')
      }

      let launched
      try {
        // A legacy npx selection carries the package spec it must be launched with
        // (`-y <spec>`); a managed/explicit selection carries none.
        const prefix = Array.isArray(binary?.extraArgs) ? binary.extraArgs.map((value) => String(value)) : []
        launched = buildLaunchArgv({ exe, args: [...prefix, ...argv, '--root', '.'] })
      } catch (error) {
        return fail('could not shape the command line: ' + describe(error) + '.')
      }

      const spawn = ctx?.subprocess?.spawn
      if (typeof spawn !== 'function') {
        return fail('ctx.subprocess.spawn is unavailable; the CLI tool cannot start.')
      }

      const timeout = effectiveTimeout(parsed.timeout_ms, configuredTimeoutMs)

      /** @type {any} */
      let handle
      try {
        handle = spawn({
          argv: launched.argv,
          cwd: root,
          stdio: {
            stdout: { maxBytes: STDOUT_MAX_BYTES, spill: { maxBytes: SPILL_MAX_BYTES } },
            stderr: { maxBytes: STDERR_MAX_BYTES },
          },
          graceMs: GRACE_MS,
        })
      } catch (error) {
        return fail('could not start the BaseMind CLI: ' + describe(error) + '.')
      }
      if (handle === undefined || handle === null) {
        return fail('the subprocess provider returned no handle for the BaseMind CLI.')
      }

      const outcome = await waitForSettle(handle, timeout, exec?.signal)

      if (outcome.kind === 'timeout' || outcome.kind === 'aborted') {
        try {
          handle.terminate?.()
        } catch (error) {
          logger?.warn?.('basemind: could not terminate the CLI process: ' + describe(error))
        }
        try {
          await handle.waitForExit?.(AbortSignal.timeout(TERMINATE_WAIT_MS))
        } catch (error) {
          logger?.warn?.('basemind: CLI process did not report exit: ' + describe(error))
        }
      }

      const stdout = readStream(handle, 'stdout')
      const stderr = readStream(handle, 'stderr')

      let failure = ''
      if (outcome.kind === 'timeout') {
        failure = 'BaseMind CLI call timed out after ' + timeout + ' ms and was terminated.'
      } else if (outcome.kind === 'aborted') {
        failure = 'BaseMind CLI call was cancelled.'
      } else if (outcome.kind === 'error') {
        failure = 'BaseMind CLI failed: ' + describe(outcome.error) + '.'
      } else {
        const info = isPlainObject(outcome.info) ? outcome.info : {}
        const exitCode = info.exitCode
        const signalName = info.signal
        if (typeof exitCode === 'number' && exitCode !== 0) {
          failure = 'BaseMind CLI exited with code ' + exitCode + '.'
        } else if (typeof signalName === 'string' && signalName !== '') {
          failure = 'BaseMind CLI was terminated by signal ' + signalName + '.'
        }
      }

      const parts = []
      if (failure !== '') parts.push('dsh-basemind-plugin: ' + failure)
      const stdoutText = trimEnd(stdout.text)
      if (stdoutText !== '') parts.push(stdoutText)
      const stderrText = trimEnd(stderr.text)
      if (stderrText !== '') parts.push('[stderr]\n' + stderrText)
      if (stdout.lossy) {
        parts.push(
          '[output truncated' +
            (stdout.spillPath === undefined ? '' : '; full stream: ' + stdout.spillPath) +
            ']',
        )
        parts.push(
          '[stdout exceeded ' +
            String(STDOUT_MAX_BYTES) +
            ' bytes; narrow the query with --json, --limit or --cursor]',
        )
      }
      if (stderr.lossy) parts.push('[stderr truncated]')

      return envelope(parts.join('\n'), failure !== '')
    },
  }
}
