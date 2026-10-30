import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  scrubEnv,
  isWindowsScript,
  assertCmdWrappable,
  buildLaunchArgv,
  resolveLaunch,
  readVersion,
} from '../lib/executable.js';

/**
 * Run `fn` with `process.env[key]` temporarily set (undefined deletes it).
 * @template T
 * @param {string} key
 * @param {string|undefined} value
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withEnv(key, value, fn) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/** Collect logger warnings. */
function createLogger() {
  /** @type {string[]} */
  const warnings = [];
  return {
    warnings,
    warn: (message) => warnings.push(String(message)),
  };
}

// ------------------------------------------------------------------ scrubEnv ---

test('scrubEnv drops secret-looking and DSH_* variables but keeps execution essentials', () => {
  const env = scrubEnv({
    PATH: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    TEMP: 'C:\\Temp',
    SOME_API_KEY: 'sk-live',
    MY_TOKEN: 'token-value',
    DSH_PROFILE: 'default',
    BASH_KEY: 'bash-key',
    NOT_A_STRING: 42,
    UNDEFINED_VALUE: undefined,
  });

  assert.equal(env.PATH, 'C:\\Windows\\System32');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ProgramFiles, 'C:\\Program Files');
  assert.equal(env['ProgramFiles(x86)'], 'C:\\Program Files (x86)');
  assert.equal(env.TEMP, 'C:\\Temp');

  for (const key of ['SOME_API_KEY', 'MY_TOKEN', 'DSH_PROFILE', 'BASH_KEY', 'NOT_A_STRING', 'UNDEFINED_VALUE']) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not reach the child process`);
  }
});

test('scrubEnv keeps the parent casing for essentials and does not duplicate names', () => {
  const env = scrubEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' });
  assert.equal(env.Path, 'C:\\bin');
  assert.equal(env.PATH, undefined);
  assert.equal(env.SystemRoot, 'C:\\Windows');
});

test('scrubEnv merges extra string values only, and extra wins over the parent', () => {
  const env = scrubEnv(
    { PATH: '/bin', SECRET_VALUE: 'hidden' },
    { FOO: 'bar', NUM: 5, NIL: null, PATH: '/usr/bin', SECRET_VALUE: 'explicit' },
  );

  assert.equal(env.FOO, 'bar');
  assert.equal(env.NUM, undefined);
  assert.equal(env.NIL, undefined);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.SECRET_VALUE, 'explicit');
});

test('scrubEnv tolerates missing arguments', () => {
  assert.deepEqual(scrubEnv({}, {}), {});
  // `undefined` keeps the parameter default (process.env); `null` means "no parent".
  assert.deepEqual(scrubEnv(null, null), {});
  assert.deepEqual(scrubEnv(null, { FOO: 'bar' }), { FOO: 'bar' });
});

// -------------------------------------------------------------- isWindowsScript ---

test('isWindowsScript only reports .cmd/.bat on win32', () => {
  assert.equal(isWindowsScript('C:\\tools\\basemind.cmd', 'win32'), true);
  assert.equal(isWindowsScript('C:\\tools\\BASEMIND.CMD', 'win32'), true);
  assert.equal(isWindowsScript('C:\\tools\\basemind.bat', 'win32'), true);
  assert.equal(isWindowsScript('C:\\tools\\basemind.exe', 'win32'), false);
  assert.equal(isWindowsScript('C:\\tools\\basemind', 'win32'), false);
  assert.equal(isWindowsScript('C:\\tools\\basemind.cmd', 'linux'), false);
  assert.equal(isWindowsScript('', 'win32'), false);
  assert.equal(isWindowsScript(undefined, 'win32'), false);
});

// ------------------------------------------------------------ assertCmdWrappable ---

test('assertCmdWrappable accepts tokens without whitespace or cmd metacharacters', () => {
  assert.doesNotThrow(() =>
    assertCmdWrappable(['C:\\tools\\basemind.cmd', 'serve', '--root', '.', '-y', 'basemind@latest']),
  );
});

test('assertCmdWrappable rejects unquotable tokens with an actionable message', () => {
  const unusable = [
    'basemind path.cmd',
    'C:\\Program Files\\basemind.cmd',
    'C:\\to%ols\\basemind.cmd',
    'C:\\a&b\\basemind.cmd',
    'C:\\a|b\\basemind.cmd',
    'C:\\a<b\\basemind.cmd',
    'C:\\a^b\\basemind.cmd',
    'C:\\a(b)\\basemind.cmd',
    'C:\\a!b\\basemind.cmd',
    'C:\\a"b\\basemind.cmd',
  ];

  for (const token of unusable) {
    assert.throws(
      () => assertCmdWrappable([token]),
      (error) => {
        assert.ok(
          error.message.includes(JSON.stringify(token)),
          `message must name the offending token ${JSON.stringify(token)}`,
        );
        assert.match(error.message, /cannot pass through the cmd\.exe wrapper/);
        assert.match(error.message, /BASEMIND_BIN/);
        assert.match(error.message, /\.exe/);
        return true;
      },
      `token ${token} must not be wrappable`,
    );
  }
});

// ---------------------------------------------------------------- buildLaunchArgv ---

test('buildLaunchArgv spawns a real .exe directly, even below a path with spaces', () => {
  const exe = 'C:\\Program Files\\BaseMind\\basemind.exe';
  const launch = buildLaunchArgv({ exe, args: ['serve', '--root', '.'], platform: 'win32' });

  assert.deepEqual(launch.argv, [exe, 'serve', '--root', '.']);
  assert.equal(launch.mode, 'direct');
  assert.equal(launch.comspec, undefined);
});

test('buildLaunchArgv wraps a .cmd through cmd.exe /d /s /c with one unquoted payload', async () => {
  await withEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe', () => {
    const launch = buildLaunchArgv({
      exe: 'C:\\tools\\basemind.cmd',
      args: ['serve', '--root', '.'],
      platform: 'win32',
    });

    assert.deepEqual(launch.argv, [
      'C:\\Windows\\System32\\cmd.exe',
      '/d',
      '/s',
      '/c',
      'C:\\tools\\basemind.cmd serve --root .',
    ]);
    assert.equal(launch.mode, 'cmd-wrapper');
    assert.equal(launch.comspec, 'C:\\Windows\\System32\\cmd.exe');
  });
});

test('buildLaunchArgv falls back to the bare cmd.exe name when ComSpec is unset', async () => {
  await withEnv('ComSpec', undefined, () => {
    const launch = buildLaunchArgv({ exe: 'C:\\tools\\basemind.cmd', platform: 'win32' });
    assert.equal(launch.comspec, 'cmd.exe');
    assert.deepEqual(launch.argv, ['cmd.exe', '/d', '/s', '/c', 'C:\\tools\\basemind.cmd']);
  });
});

test('buildLaunchArgv rejects a .cmd whose path or args cannot pass through cmd.exe', () => {
  assert.throws(
    () => buildLaunchArgv({ exe: 'C:\\Program Files\\basemind.cmd', platform: 'win32' }),
    /cannot pass through the cmd\.exe wrapper/,
  );
  assert.throws(
    () =>
      buildLaunchArgv({
        exe: 'C:\\tools\\basemind.cmd',
        args: ['--config', 'C:\\Program Files\\cfg.json'],
        platform: 'win32',
      }),
    /cannot pass through the cmd\.exe wrapper/,
  );
});

test('buildLaunchArgv treats .cmd as a plain file off Windows', () => {
  const launch = buildLaunchArgv({ exe: '/opt/basemind.cmd', platform: 'linux' });
  assert.deepEqual(launch.argv, ['/opt/basemind.cmd']);
  assert.equal(launch.mode, 'direct');
});

// ----------------------------------------------------------------- resolveLaunch ---

/**
 * Fake ctx.subprocess.resolveExecutable backed by a fixed lookup table.
 * @param {Record<string, string>} table
 */
function createResolveCtx(table = {}) {
  /** @type {{ command: string, env: any, signal: any }[]} */
  const calls = [];
  const ctx = {
    calls,
    subprocess: {
      async resolveExecutable(command, env, signal) {
        calls.push({ command, env, signal });
        if (Object.hasOwn(table, command)) return table[command];
        throw new Error(`cannot resolve executable '${command}'`);
      },
    },
  };
  return ctx;
}

test('resolveLaunch resolves a .cmd through cmd.exe and strips user --root args', async () => {
  await withEnv('ComSpec', 'cmd.exe', async () => {
    const logger = createLogger();
    const ctx = createResolveCtx({
      basemind: 'C:\\tools\\basemind.cmd',
      'cmd.exe': 'C:\\Windows\\System32\\cmd.exe',
    });
    const root = 'D:\\work space\\repo';
    const launch = await resolveLaunch({
      config: {
        command: 'basemind',
        args: ['serve', '--root', 'D:\\other', '--root=D:\\other2', '--verbose'],
      },
      ctx,
      root,
      platform: 'win32',
      logger,
    });

    assert.equal(launch.mode, 'cmd-wrapper');
    assert.equal(launch.exe, 'C:\\tools\\basemind.cmd');
    assert.equal(launch.provisioning, false);
    assert.equal(launch.comspec, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(launch.argv, [
      'C:\\Windows\\System32\\cmd.exe',
      '/d',
      '/s',
      '/c',
      'C:\\tools\\basemind.cmd serve --verbose --root .',
    ]);

    const payload = launch.argv[4];
    assert.match(payload, /--root \.$/);
    assert.equal(payload.includes('D:\\other'), false);
    assert.equal(payload.includes('D:\\other2'), false);
    // root is diagnostics only: never embedded in argv
    assert.equal(launch.argv.some((token) => token.includes('work space')), false);
    assert.equal(JSON.stringify(launch.argv).includes('work space'), false);

    // The scrubbed env is exposed for the caller and was passed to resolution.
    assert.equal(typeof launch.env, 'object');
    assert.equal(ctx.calls[0].command, 'basemind');
    assert.equal(ctx.calls[0].env, launch.env);
    assert.ok(logger.warnings.some((message) => /--root/.test(message)));
  });
});

test('resolveLaunch spawns a real .exe directly and appends --root .', async () => {
  const exe = 'C:\\tools\\basemind.exe';
  const ctx = createResolveCtx({ [exe]: exe });
  const launch = await resolveLaunch({
    config: { command: exe, args: ['serve'] },
    ctx,
    root: '/repo',
    platform: 'win32',
  });

  assert.equal(launch.mode, 'direct');
  assert.equal(launch.comspec, undefined);
  assert.equal(launch.provisioning, false);
  assert.deepEqual(launch.argv, [exe, 'serve', '--root', '.']);
  assert.deepEqual(launch.argv.slice(-2), ['--root', '.']);
});

test('resolveLaunch lets BASEMIND_BIN override the default command', async () => {
  await withEnv('BASEMIND_BIN', 'C:\\bin\\basemind.exe', async () => {
    const exe = 'C:\\bin\\basemind.exe';
    const ctx = createResolveCtx({ [exe]: exe });
    const launch = await resolveLaunch({ config: { command: 'basemind' }, ctx, root: '/repo' });

    assert.equal(launch.exe, exe);
    assert.equal(ctx.calls[0].command, exe);
    assert.deepEqual(launch.argv, [exe, '--root', '.']);
  });
});

test('resolveLaunch prefers an explicit config.command over BASEMIND_BIN', async () => {
  await withEnv('BASEMIND_BIN', 'C:\\bin\\basemind.exe', async () => {
    const exe = 'C:\\custom\\basemind.exe';
    const ctx = createResolveCtx({ [exe]: exe });
    const launch = await resolveLaunch({ config: { command: exe, args: ['serve'] }, ctx, root: '/repo' });

    assert.equal(launch.exe, exe);
    assert.equal(ctx.calls[0].command, exe);
    assert.equal(ctx.calls.length, 1);
  });
});

test('resolveLaunch falls back to npx when provisioning is enabled and the command is missing', async () => {
  await withEnv('ComSpec', 'cmd.exe', async () => {
    const logger = createLogger();
    const ctx = createResolveCtx({ npx: 'C:\\node\\npx.cmd', 'cmd.exe': 'C:\\Windows\\System32\\cmd.exe' });
    const launch = await resolveLaunch({
      config: { command: 'basemind', args: ['serve'], autoProvision: true, npxSpec: 'basemind@0.31.0' },
      ctx,
      root: 'D:\\repo',
      platform: 'win32',
      logger,
    });

    assert.equal(launch.provisioning, true);
    assert.equal(launch.exe, 'C:\\node\\npx.cmd');
    assert.equal(launch.mode, 'cmd-wrapper');
    assert.deepEqual(launch.argv.slice(0, 4), ['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c']);
    assert.equal(launch.argv[4], 'C:\\node\\npx.cmd -y basemind@0.31.0 serve --root .');
    assert.deepEqual(
      ctx.calls.map((call) => call.command),
      ['basemind', 'npx', 'cmd.exe'],
    );
    assert.ok(logger.warnings.some((message) => /autoProvision/.test(message)));
  });
});

test('resolveLaunch propagates the original error when provisioning is off', async () => {
  const ctx = createResolveCtx({});
  await assert.rejects(
    resolveLaunch({ config: { command: 'basemind', args: ['serve'] }, ctx, root: '/repo' }),
    /cannot resolve executable 'basemind'/,
  );
  assert.equal(ctx.calls.length, 1);
});

test('resolveLaunch rethrows the configured-command error when npx is missing too', async () => {
  const ctx = createResolveCtx({});
  await assert.rejects(
    resolveLaunch({ config: { command: 'basemind', autoProvision: true }, ctx, root: '/repo' }),
    (error) => {
      assert.match(error.message, /cannot resolve executable 'basemind'/);
      assert.doesNotMatch(error.message, /npx/);
      return true;
    },
  );
  assert.deepEqual(
    ctx.calls.map((call) => call.command),
    ['basemind', 'npx'],
  );
});

test('resolveLaunch falls back to the bare comspec when it cannot be resolved', async () => {
  await withEnv('ComSpec', 'cmd.exe', async () => {
    const logger = createLogger();
    const ctx = createResolveCtx({ basemind: 'C:\\tools\\basemind.cmd' });
    const launch = await resolveLaunch({
      config: { command: 'basemind', args: ['serve'] },
      ctx,
      root: '/repo',
      platform: 'win32',
      logger,
    });

    assert.equal(launch.mode, 'cmd-wrapper');
    assert.equal(launch.comspec, 'cmd.exe');
    assert.deepEqual(launch.argv, ['cmd.exe', '/d', '/s', '/c', 'C:\\tools\\basemind.cmd serve --root .']);
    assert.ok(logger.warnings.some((message) => /cmd\.exe/.test(message)));
  });
});

test('resolveLaunch rejects rather than guessing when a .cmd path cannot be wrapped', async () => {
  const ctx = createResolveCtx({ basemind: 'C:\\Program Files\\basemind.cmd' });
  await assert.rejects(
    resolveLaunch({ config: { command: 'basemind' }, ctx, root: '/repo', platform: 'win32' }),
    /cannot pass through the cmd\.exe wrapper/,
  );
});

// ------------------------------------------------------------------- readVersion ---

/** Fake ctx whose spawn emits `output` on stdout and then exits. */
function createVersionCtx({ output = '0.29.3\n', fail = false } = {}) {
  const calls = { spawn: 0, terminate: 0, waitForExit: 0, receiver: undefined };
  /** @type {any[]} */
  const specs = [];
  const ctx = {
    subprocess: {
      async resolveExecutable() {
        throw new Error('readVersion must not resolve executables');
      },
      spawn(spec) {
        calls.spawn += 1;
        calls.receiver = this;
        specs.push(spec);
        if (fail) throw new Error('spawn failed');

        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let resolveDone;
        const done = new Promise((resolve) => {
          resolveDone = resolve;
        });

        setImmediate(() => {
          if (output !== null) stdout.write(output);
          stdout.end();
          resolveDone({ exitCode: 0, signal: null });
        });

        return {
          stdout,
          stderr,
          done,
          terminate() {
            calls.terminate += 1;
          },
          async waitForExit() {
            calls.waitForExit += 1;
            return true;
          },
        };
      },
    },
  };
  return { ctx, calls, specs };
}

test('readVersion returns the first trimmed line of --version output', async () => {
  const { ctx, calls, specs } = createVersionCtx({ output: '\n  0.29.3  \nextra line\n' });
  const exe = 'C:\\tools\\basemind.exe';
  const version = await readVersion({ ctx, exe });

  assert.equal(version, '0.29.3');
  assert.equal(calls.spawn, 1);
  assert.equal(calls.receiver, ctx.subprocess, 'spawn keeps the provider as its receiver');
  assert.equal(calls.terminate, 1);
  assert.equal(calls.waitForExit, 1);
  assert.deepEqual(specs[0].argv, [exe, '--version']);
  assert.equal(specs[0].cwd, process.cwd());
  assert.equal(specs[0].graceMs, 2000);
  assert.deepEqual(specs[0].stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
});

test('readVersion returns undefined when spawn throws', async () => {
  const { ctx } = createVersionCtx({ fail: true });
  const logger = createLogger();
  assert.equal(await readVersion({ ctx, exe: 'C:\\tools\\basemind.exe', logger }), undefined);
  assert.ok(logger.warnings.length > 0);
});

test('readVersion returns undefined when the launcher cannot be expressed', async () => {
  const { ctx, calls } = createVersionCtx();
  assert.equal(
    await readVersion({ ctx, exe: 'C:\\Program Files\\basemind.cmd', platform: 'win32' }),
    undefined,
  );
  assert.equal(calls.spawn, 0);
});

test('readVersion returns undefined for binary-looking output', async () => {
  const { ctx } = createVersionCtx({ output: 'a\u0000b\n' });
  assert.equal(await readVersion({ ctx, exe: 'basemind' }), undefined);
});

test('readVersion returns undefined without a usable spawn provider', async () => {
  assert.equal(await readVersion({ ctx: {}, exe: 'basemind' }), undefined);
  assert.equal(await readVersion({ ctx: { subprocess: { spawn: undefined } }, exe: 'basemind' }), undefined);
});
