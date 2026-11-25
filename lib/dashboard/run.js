/**
 * One argv-only spawn of the selected BaseMind executable for the Dashboard.
 *
 * Deliberately separate from the agent-facing CLI tool: the Dashboard has no
 * Agent, no tool envelope and no arbitrary-argv surface, and its output is JSON
 * parsed by the Host rather than returned as tool text. It still goes through
 * `ctx.subprocess.spawn` (never `node:child_process`) and never through a shell.
 *
 * @module dsh-basemind-plugin/lib/dashboard/run
 */
import { buildLaunchArgv } from '../executable.js'

const STDOUT_MAX_BYTES = 256 * 1024
const STDERR_MAX_BYTES = 32 * 1024
const SPILL_MAX_BYTES = 2 * 1024 * 1024
const GRACE_MS = 2_000
const TERMINATE_WAIT_MS = 2_000

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read one collected stream defensively. */
function readStream(handle, name) {
  const empty = { text: '' }
  const collected = handle?.collected?.[name]
  if (collected === undefined || collected === null || typeof collected.readFrom !== 'function') return empty
  try {
    const read = collected.readFrom(0)
    return isPlainObject(read) && typeof read.text === 'string' ? { text: read.text } : empty
  } catch {
    return empty
  }
}

/** Wait for one spawn handle without exceeding the timeout. */
function waitForSettle(handle, timeoutMs, signal) {
  if (signal?.aborted === true) return Promise.resolve({ kind: 'aborted' })
  const done = handle?.done
  if (done === undefined || done === null || typeof done.then !== 'function') {
    return Promise.resolve({ kind: 'exit', info: undefined })
  }
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        signal?.removeEventListener?.('abort', onAbort)
      } catch {
        // a foreign AbortSignal implementation may not support removal
      }
      resolve(value)
    }
    const onAbort = () => {
      finish({ kind: 'aborted' })
    }
    timer = setTimeout(() => {
      finish({ kind: 'timeout' })
    }, timeoutMs)
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true })
    } catch {
      // a foreign AbortSignal implementation may not support listeners
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
 * Create the Dashboard's CLI runner.
 * @param {{ ctx: any, logger?: any }} options
 * @returns {{ available: boolean, run: (call: object) => Promise<object> }}
 */
export function createDashboardRunner({ ctx, logger } = {}) {
  const spawn = typeof ctx?.subprocess?.spawn === 'function' ? ctx.subprocess.spawn.bind(ctx.subprocess) : undefined

  /**
   * Run one read-only or explicitly requested BaseMind command.
   * @returns `{ ok: true, exitCode, stdout, stderr }` or
   *   `{ ok: false, code, message, stdout, stderr }`.
   */
  async function run({ binary, cwd, args, timeoutMs = 30_000, signal } = {}) {
    if (spawn === undefined) {
      return { ok: false, code: 'unavailable', message: 'ctx.subprocess.spawn is unavailable; the Dashboard cannot run BaseMind.', stdout: '', stderr: '' }
    }
    const exe = typeof binary?.path === 'string' && binary.path !== '' ? binary.path : undefined
    if (exe === undefined) {
      return {
        ok: false,
        code: 'binary-unavailable',
        message: 'No verified BaseMind binary is selected yet. Open a BaseMind session once (or let the plugin finish its handled startup) and retry.',
        stdout: '',
        stderr: '',
      }
    }
    const prefix = Array.isArray(binary?.extraArgs) ? binary.extraArgs.map((value) => String(value)) : []
    let launched
    try {
      launched = buildLaunchArgv({ exe, args: [...prefix, ...args.map((value) => String(value))] })
    } catch (error) {
      return { ok: false, code: 'argv', message: 'Could not shape the BaseMind command line: ' + message(error), stdout: '', stderr: '' }
    }

    let handle
    try {
      handle = spawn({
        argv: launched.argv,
        cwd,
        stdio: {
          stdout: { maxBytes: STDOUT_MAX_BYTES, spill: { maxBytes: SPILL_MAX_BYTES } },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: GRACE_MS,
      })
    } catch (error) {
      return { ok: false, code: 'spawn', message: 'Could not start the BaseMind CLI: ' + message(error), stdout: '', stderr: '' }
    }
    if (handle === undefined || handle === null) {
      return { ok: false, code: 'spawn', message: 'The subprocess provider returned no handle.', stdout: '', stderr: '' }
    }

    const outcome = await waitForSettle(handle, timeoutMs, signal)
    if (outcome.kind === 'timeout' || outcome.kind === 'aborted') {
      try {
        handle.terminate?.()
      } catch (error) {
        logger?.warn?.('[dsh-basemind-plugin] dashboard: could not terminate BaseMind: ' + message(error))
      }
      try {
        await handle.waitForExit?.(AbortSignal.timeout(TERMINATE_WAIT_MS))
      } catch {
        // the process may already be gone
      }
    }

    const stdout = readStream(handle, 'stdout').text
    const stderr = readStream(handle, 'stderr').text

    if (outcome.kind === 'timeout') {
      return { ok: false, code: 'timeout', message: 'BaseMind did not answer within ' + String(timeoutMs) + ' ms and was terminated.', stdout, stderr }
    }
    if (outcome.kind === 'aborted') {
      return { ok: false, code: 'aborted', message: 'The Dashboard query was cancelled.', stdout, stderr }
    }
    if (outcome.kind === 'error') {
      return { ok: false, code: 'failed', message: 'BaseMind failed: ' + message(outcome.error), stdout, stderr }
    }

    const info = isPlainObject(outcome.info) ? outcome.info : {}
    const exitCode = typeof info.exitCode === 'number' ? info.exitCode : null
    const signalName = typeof info.signal === 'string' ? info.signal : null
    return { ok: true, exitCode, signal: signalName, stdout, stderr }
  }

  return { available: spawn !== undefined, run }
}
