/**
 * Resolve and shape the BaseMind launcher command line for DSH's subprocess provider.
 *
 * Platform facts this module builds on (measured, not re-litigated):
 * - `child_process.spawn('<abs>.cmd', args)` fails with EINVAL; a `.cmd`/`.bat`
 *   launcher can only run through `cmd.exe /d /s /c <payload>`.
 * - Node/libuv escapes inner double quotes as `\"` on the command line and cmd.exe
 *   does not understand that, so a `.cmd` payload canNOT be quoted at all. Any token
 *   containing whitespace or the metacharacters `" % & | < > ^ ( ) !` is unquotable.
 * - A real `.exe` (even below a path with spaces) spawns directly.
 * - BaseMind accepts `--root .` while the child's cwd is the workspace root, so the
 *   plugin always spawns with `cwd = root` and appends `--root .`, which keeps
 *   workspace paths out of the command line entirely.
 *
 * Zero dependencies, Node >= 22 built-ins only.
 */

/** Environment variables that must survive scrubbing because processes need them. */
const ESSENTIAL_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
];

/** Secret-looking variable names that never reach the child process. */
const SECRET_ENV_KEY = /KEY|PASSWORD|SECRET|TOKEN/i;

/** Characters that cannot survive the unquoted cmd.exe payload. */
const CMD_UNQUOTABLE = /[ \t"%~&|<>^()!]/;

/** Max stdout bytes read from the `--version` probe. */
const VERSION_STDOUT_LIMIT = 4096;

/**
 * Read an environment entry by exact key or, failing that, case-insensitively
 * (Windows environment blocks are case-insensitive, so `Path` and `PATH` coexist).
 * @param {object} env
 * @param {string} key
 * @returns {string|undefined}
 */
function lookupEnv(env, key) {
  if (env == null || typeof env !== 'object') return undefined;
  const direct = env[key];
  if (typeof direct === 'string') return direct;
  const lowered = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && name.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/**
 * Build the child environment: every string-valued parent entry, minus secrets and
 * `DSH_*`, plus the execution-essential keys restored from the parent, plus `extra`
 * string values. Non-string values are dropped without a warning (this module has no
 * logger); their absence is never load-bearing.
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} [parentEnv]
 * @param {Record<string, unknown>} [extraEnv]
 * @returns {Record<string, string>}
 */
export function scrubEnv(parentEnv = process.env, extraEnv = {}) {
  const parent = parentEnv != null && typeof parentEnv === 'object' ? parentEnv : {};
  /** @type {Record<string, string>} */
  const out = {};

  for (const [key, value] of Object.entries(parent)) {
    if (typeof value === 'string') out[key] = value;
  }

  for (const key of Object.keys(out)) {
    if (SECRET_ENV_KEY.test(key) || key.startsWith('DSH_')) delete out[key];
  }

  for (const key of ESSENTIAL_ENV_KEYS) {
    const value = lookupEnv(parent, key);
    if (value === undefined) continue;
    // Keep the parent's casing when the key already survived scrubbing, so the
    // child environment never carries two spellings of the same variable.
    const existing = Object.keys(out).find((name) => name.toLowerCase() === key.toLowerCase());
    out[existing ?? key] = value;
  }

  if (extraEnv != null && typeof extraEnv === 'object') {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof value === 'string') out[key] = value;
    }
  }

  return out;
}

/**
 * True when `filePath` is a Windows batch launcher (`.cmd` / `.bat`).
 * @param {string} filePath
 * @param {NodeJS.Platform|string} [platform]
 * @returns {boolean}
 */
export function isWindowsScript(filePath, platform = process.platform) {
  if (platform !== 'win32') return false;
  if (typeof filePath !== 'string' || filePath === '') return false;
  return /\.(cmd|bat)$/i.test(filePath);
}

/**
 * Throw when any token cannot be passed through the cmd.exe wrapper.
 *
 * cmd.exe receives the payload unquoted (quotes cannot be escaped for it), so a
 * token with whitespace or a metacharacter would be re-split/re-interpreted.
 * @param {readonly unknown[]} tokens
 * @returns {void}
 */
export function assertCmdWrappable(tokens) {
  for (const token of tokens ?? []) {
    const text = String(token ?? '');
    if (!CMD_UNQUOTABLE.test(text)) continue;
    throw new Error(
      `BaseMind launcher token ${JSON.stringify(text)} contains characters that cannot pass through the cmd.exe wrapper ` +
        `(whitespace or one of " % & | < > ^ ( ) !). A .cmd/.bat launcher is only supported when the whole command line ` +
        `is free of those characters, because cmd.exe cannot receive an escaped payload. ` +
        `Set BASEMIND_BIN to a basemind .exe without spaces or cmd metacharacters in its path ` +
        `(for example C:\\Tools\\basemind\\basemind.exe), or install BaseMind natively so 'basemind' resolves to an .exe.`,
    );
  }
}

/**
 * Shape the spawn argv. The comspec is NOT resolved here (see {@link resolveLaunch}).
 * @param {{ exe: string, args?: readonly string[], platform?: NodeJS.Platform|string }} params
 * @returns {{ argv: string[], mode: 'direct'|'cmd-wrapper', comspec: string|undefined }}
 */
export function buildLaunchArgv({ exe, args = [], platform = process.platform }) {
  const exeText = String(exe ?? '');
  const argList = Array.isArray(args) ? args.map((arg) => String(arg)) : [];

  if (isWindowsScript(exeText, platform)) {
    const tokens = [exeText, ...argList];
    assertCmdWrappable(tokens);
    const comspec = process.env.ComSpec || 'cmd.exe';
    return {
      argv: [comspec, '/d', '/s', '/c', tokens.join(' ')],
      mode: 'cmd-wrapper',
      comspec,
    };
  }

  return { argv: [exeText, ...argList], mode: 'direct', comspec: undefined };
}

/**
 * Drop user-supplied `--root` / `--root=<path>` tokens: the plugin owns the root and
 * always passes `--root .` with `cwd = root`.
 * @param {unknown} args
 * @returns {string[]}
 */
function stripRootArgs(args) {
  const input = Array.isArray(args) ? args : [];
  /** @type {string[]} */
  const out = [];
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (typeof token !== 'string') continue;
    if (token === '--root') {
      index += 1; // also swallow the value that follows
      continue;
    }
    if (token.startsWith('--root=')) continue;
    out.push(token);
  }
  return out;
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Resolve the cmd.exe interpreter to an absolute path when possible, substituting it
 * as `argv[0]`. Falls back to the bare interpreter name and warns on failure.
 * @param {{ ctx: any, env: Record<string, string>, signal?: AbortSignal, logger?: any, root?: string,
 *           launched: { argv: string[], mode: 'direct'|'cmd-wrapper', comspec: string|undefined },
 *           exe: string, provisioning: boolean }} params
 */
async function finalizeLaunch({ ctx, env, signal, logger, root, launched, exe, provisioning }) {
  /** @type {{ argv: string[], exe: string, mode: 'direct'|'cmd-wrapper', provisioning: boolean, comspec?: string, env: Record<string, string> }} */
  const result = { argv: launched.argv, exe, mode: launched.mode, provisioning, env };

  if (launched.mode === 'cmd-wrapper' && launched.comspec) {
    result.comspec = launched.comspec;
    try {
      const resolved = await ctx.subprocess.resolveExecutable(launched.comspec, env, signal);
      result.comspec = resolved;
      result.argv = [resolved, ...launched.argv.slice(1)];
    } catch (error) {
      logger?.warn?.(
        `basemind: could not resolve the cmd.exe interpreter '${launched.comspec}' for workspace ${root ?? '<unknown>'}; ` +
          `falling back to the bare name (${errorMessage(error)})`,
      );
    }
  }

  return result;
}

/**
 * Resolve the launcher for one workspace.
 *
 * `root` is diagnostics only: it is never embedded into argv, because the caller
 * spawns with `cwd = root` and the plugin intentionally appends `--root .` instead.
 *
 * Returned object is `{ argv, exe, mode, provisioning }` plus `comspec` for
 * `cmd-wrapper` and `env` (the scrubbed child environment, so callers do not have to
 * call {@link scrubEnv} a second time).
 * @param {{ config?: any, ctx: any, root?: string, signal?: AbortSignal,
 *           platform?: NodeJS.Platform|string, logger?: any }} params
 */
export async function resolveLaunch({ config = {}, ctx, root, signal, platform = process.platform, logger }) {
  const subprocess = ctx?.subprocess;
  if (typeof subprocess?.resolveExecutable !== 'function') {
    throw new Error('dsh-basemind-plugin requires ctx.subprocess.resolveExecutable to launch BaseMind');
  }

  const env = scrubEnv(process.env, config?.env);
  const configured = typeof config?.command === 'string' ? config.command : '';
  const binOverride = typeof process.env.BASEMIND_BIN === 'string' ? process.env.BASEMIND_BIN.trim() : '';
  const useBin = (configured === '' || configured === 'basemind') && binOverride !== '';
  const command = useBin ? binOverride : configured;

  const rawArgs = Array.isArray(config?.args) ? config.args : [];
  const args = stripRootArgs(rawArgs);
  if (args.length !== rawArgs.filter((arg) => typeof arg === 'string').length) {
    logger?.warn?.(
      `basemind: removed user-supplied --root from config.args for workspace ${root ?? '<unknown>'}; ` +
        `the plugin always appends '--root .' and spawns with cwd = root`,
    );
  }

  /** @type {unknown} */
  let resolveError;
  /** @type {string|undefined} */
  let exe;
  try {
    exe = await subprocess.resolveExecutable(command, env, signal);
  } catch (error) {
    resolveError = error;
  }

  if (resolveError !== undefined) {
    if (config?.autoProvision !== true) throw resolveError;

    let npxExe;
    try {
      npxExe = await subprocess.resolveExecutable('npx', env, signal);
    } catch {
      // Provisioning is not possible: surface the ORIGINAL failure, not the npx one.
      throw resolveError;
    }

    const npxSpec = typeof config?.npxSpec === 'string' && config.npxSpec !== '' ? config.npxSpec : 'basemind@latest';
    logger?.warn?.(
      `basemind: '${command}' is not resolvable for workspace ${root ?? '<unknown>'} (${errorMessage(resolveError)}); ` +
        `autoProvision is on, falling back to 'npx -y ${npxSpec}'`,
    );

    const launched = buildLaunchArgv({ exe: npxExe, args: ['-y', npxSpec, ...args, '--root', '.'], platform });
    return await finalizeLaunch({ ctx, env, signal, logger, root, launched, exe: npxExe, provisioning: true });
  }

  const launched = buildLaunchArgv({ exe, args: [...args, '--root', '.'], platform });
  return await finalizeLaunch({ ctx, env, signal, logger, root, launched, exe, provisioning: false });
}

/**
 * First trimmed line of a `--version` capture, when it plausibly is text.
 * @param {string} text
 * @returns {string|undefined}
 */
function versionLine(text) {
  const line = String(text)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');
  if (!line) return undefined;
  if (line.length > 128) return undefined;
  if (/[\u0000-\u0008\u000E-\u001F\u007F]/.test(line)) return undefined;
  return line;
}

/**
 * Best-effort `<exe> --version` diagnostics. NEVER throws: any failure (including a
 * `.cmd` launcher path that the wrapper cannot express) resolves to `undefined`.
 * @param {{ ctx: any, exe: string, platform?: NodeJS.Platform|string, logger?: any, timeoutMs?: number }} params
 * @returns {Promise<string|undefined>}
 */
export async function readVersion({ ctx, exe, platform = process.platform, logger, timeoutMs = 10000 }) {
  /** @type {any} */
  let handle;
  /** @type {NodeJS.Timeout|undefined} */
  let timer;

  try {
    let argv;
    try {
      argv = buildLaunchArgv({ exe, args: ['--version'], platform }).argv;
    } catch (error) {
      logger?.warn?.(`basemind: skipping '--version' probe: ${errorMessage(error)}`);
      return undefined;
    }

    const spawn = typeof ctx?.subprocess?.spawn === 'function'
      ? ctx.subprocess.spawn.bind(ctx.subprocess)
      : undefined;
    if (spawn === undefined) return undefined;

    handle = spawn({
      argv,
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 2000,
    });

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      if (size >= VERSION_STDOUT_LIMIT) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const slice = buffer.subarray(0, VERSION_STDOUT_LIMIT - size);
      chunks.push(slice);
      size += slice.length;
    };

    const stdout = handle?.stdout;
    const done = handle?.done;
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(undefined);
      };

      timer = setTimeout(finish, waitMs);
      timer.unref?.();
      stdout?.on?.('data', onData);
      stdout?.once?.('end', finish);
      stdout?.once?.('close', finish);
      if (done && typeof done.then === 'function') done.then(finish, finish);
    });

    return versionLine(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    logger?.warn?.(`basemind: '--version' probe failed: ${errorMessage(error)}`);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    if (handle) {
      try {
        handle.terminate?.();
      } catch (error) {
        logger?.warn?.(`basemind: could not terminate the '--version' probe: ${errorMessage(error)}`);
      }
      try {
        await handle.waitForExit?.(AbortSignal.timeout(1000));
      } catch (error) {
        logger?.warn?.(`basemind: '--version' probe did not report exit: ${errorMessage(error)}`);
      }
    }
  }
}
