# dsh-basemind-plugin

Workspace-aware BaseMind bridge for DeepSeek Harness. Install the bundle and every session gets BaseMind's code-intelligence tools for the repository that session is working in — no MCP row to configure, no agent preset change.

## 1. What it is and why it exists

This is a **Host-only DSH bundle**. It starts BaseMind's own MCP server (`basemind serve`) as a child process, speaks MCP over stdio to it, and registers the tools it discovers at the profile root. It also bridges BaseMind's resources and adds BaseMind's server instructions to the system prompt. It has no Web Client half, no UI page, and it does not modify any agent preset.

It only uses Host services that ship in `dsh-base` (`tools`, `subprocess`, `workingDirectory`, `systemPrompt`, plus the optional `mcpResources`), so the same composition serves every surface of the profile: the Desktop app, a `dsh web` host and headless sessions. Loading on a surface follows from that composition; the verification in this repository was run on an installed Desktop profile, not on a DSH source checkout (see the execution report §6).

It exists because of a mismatch between the two sides:

- `basemind serve` binds **one process to one repository root** (`serve --root …`).
- DSH gives **every session its own working directory**, which can change with `cd`.

A normal MCP row has a static `cwd`, so such a row can only ever serve the one repository it was configured for. This plugin instead resolves the session's working directory on each call and keeps one BaseMind relay per repository root, so the tools follow the session. Tool names, descriptions and input schemas are not hard-coded: they are read from the relay at startup, so a newer BaseMind surfaces its new tools and modes without a plugin update.

| | Manual `basemind` MCP row | This bundle |
|---|---|---|
| Workspace root | static `cwd` in the row config | resolved per call from the session's working directory |
| Tool set | fixed at connect time for that one root | discovered per relay from `tools/list` |
| Rows to configure | one MCP row (plus a manager entry) | none — the bundle inserts its own plugin row |
| Several repositories | one more row each | one relay per root, automatically |

## 2. Requirements

| Requirement | Notes |
|---|---|
| DSH `>= 0.2.1-rc.3` | declared in `dsh.compatibility` |
| Node.js `>= 22` | declared in `engines`; the plugin is plain ESM with no dependencies |
| BaseMind available to DSH | on `PATH` as `basemind`, or point `command` / `BASEMIND_BIN` at the executable |

- **No BaseMind version is pinned, and no version gate is applied.** The plugin never reads `basemind --version` to decide what to expose. The feature set is exactly what the running BaseMind advertises through `tools/list` and `resources/list`: a newer version surfaces its new tools on its own, and a version that lacks something simply never offers it.
- BaseMind must be runnable in the environment where DSH spawns processes, and it manages its own repository index and caches there. This bundle neither installs BaseMind nor creates or refreshes an index.

## 3. Install

1. Through DSH's plugin manager, use the bundle install action with **this directory** as the target. It is a linked local directory install; the package is not published to npm.
2. **Do not hand-edit** the profile `package.json` or `cordis.patch.yml`. The plugin manager owns the profile manifest and applies the bundle patch. The patch inserts exactly one row, `id: dsh-basemind`, with `serverName: basemind`; it does not modify or remove any existing row.
3. If the runtime says a restart or a disable/enable toggle is required to load the new code, do that. Installing or updating a bundle replaces the linked package, and the Host picks up the new generation on the next load.
4. Installations are per profile. Profile-root tools do not cross profiles, so install the bundle in each profile where you want it.

To remove it, disable or uninstall the bundle with the same manager. The plugin removes its tools, resource provider, prompt section and relays (see §7). A `config` override you added yourself stays yours to delete.

## 4. Configuration

The bundle declares no `Config` schema, so the plugin manager shows no settings form. Configuration lives in the plugin row's `config` object, which you can override in your own profile patch by row id.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `serverName` | string | `basemind` | Tool prefix (`mcp__<serverName>__<tool>`) and the MCP resource server name. Must match `[A-Za-z0-9_-]{1,32}`; anything else falls back to `basemind`. |
| `command` | string | `basemind` | BaseMind executable to run. `BASEMIND_BIN` wins while `command` is still the default. |
| `args` | string[] | `['serve']` | Arguments handed to BaseMind. The plugin strips any `--root` you put here and always appends its own `--root .`, because the relay is spawned with `cwd` set to the workspace root. |
| `env` | object, string values | `{}` | Extra environment variables, merged over a scrubbed copy of DSH's environment. Names that look like secrets (`KEY`, `PASSWORD`, `SECRET`, `TOKEN`) and `DSH_*` are dropped; the rest of the inherited environment is kept, with the execution-essential variables (`PATH`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`/`TMP`, `SystemRoot`, `ComSpec`, `USERPROFILE`, `PATHEXT`, …) restored even if the scrub would have removed them. |
| `toolCallTimeoutMs` | number | `120000` | Timeout for one `tools/call`. On expiry the call is cancelled and fails with a timeout error; it is not retried. |
| `startupTimeoutMs` | number | `60000` | Budget for spawning BaseMind and completing the MCP `initialize` handshake, per relay. |
| `maxClients` | number | `32` | Upper bound on concurrent workspace relays. When it is reached, a new workspace root is refused instead of evicting an existing relay. |
| `autoProvision` | boolean | `false` | When `true` and `basemind` cannot be resolved, the relay is started through `npx -y <npxSpec>` instead. Requires npm and network access; off by default so nothing is downloaded silently. |
| `npxSpec` | string | `basemind@latest` | Package spec used by `autoProvision`. Pin a version here if you want reproducible relays. |
| `failOnStartupError` | boolean | `false` | When `true`, plugin activation returns a promise that rejects if the BaseMind launcher cannot be resolved, so a loader that awaits activation treats it as a failure. The full MCP handshake always runs in the background either way. |
| `logStderr` | boolean | `true` | When `true`, the relay's stderr tail (last 2 KiB) is included in the warning logged when a relay closes unexpectedly. |
| `discoveryRoot` | string | `agent` | Which directory seeds the initial `tools/list` discovery. `agent` waits for the first Session and uses its working directory — nothing is spawned before a session exists, so a `dsh web` launched from a checkout never indexes that checkout. `agent-first` tries the Agent directory, then the deployment default directory. `default` uses only the deployment default directory (eager; for deployments whose launch directory *is* the project). |

Numeric fields are clamped to sane ranges, and an invalid value (wrong type, empty string, bad `serverName`) falls back to the documented default with one warning instead of failing activation.

YAML override, in your own profile patch:

```yaml
- id: dsh-basemind
  config:
    serverName: basemind
    command: 'C:\Tools\basemind.exe'
    args: ['serve']
    toolCallTimeoutMs: 300000
```

**Warning:** an override **replaces the whole `config` object**. Fields you omit fall back to the built-in defaults in code — not to the values the bundle patch happens to contain. Restate every field you want to keep. `--root` is never yours to set; it is owned by the plugin.

## 5. How it works

- **One relay per workspace root.** The root comes from the session's working directory, resolved on every tool and resource call. Two sessions in different repositories each get their own `basemind serve`, and a `cd` inside a session makes the next call go to the new root without restarting anything.
- **Relays are keyed by the resolved directory.** Subdirectories of the same repository are different keys, and therefore different relays; v1 does not canonicalize to BaseMind's own repo root.
- **The first start is driven by a Session, not by the launch directory.** In the default `discoveryRoot: agent` the plugin spawns nothing until the first Session exists, then uses that Session's working directory for the initial `tools/list`; registration is profile-wide and happens in the background, so a slow BaseMind never blocks DSH startup. BaseMind refuses a root that is not a project (no `.git`, no `basemind.toml`), so a session in a scratch directory simply yields no tools until one runs in a project. `agent-first` additionally falls back to the deployment default directory, which is otherwise the *launch* directory — under `dsh web` that is the harness checkout itself, which is why it is not the default. A failed attempt retries on the next Session and with a bounded backoff (5 s, 30 s, then 5 min); it never blocks or spins.
- **A session opened before the plugin was enabled does not re-announce itself.** Its tools appear as soon as any new session is created (or after restarting DSH), because discovery registers the tool set profile-wide rather than per session.
- **Dynamic discovery.** When a relay finishes its MCP handshake, the plugin calls `tools/list` and turns every tool it finds into a DSH tool. Names, descriptions and input schemas are whatever that BaseMind build reports. Schemas are normalized to the subset DSH accepts (nullable type arrays collapse, `$schema`/`format`/bounds are dropped, and so on); a schema that cannot be normalized is degraded to an unconstrained object rather than failing the whole set.
- **Calls are serialized.** The bridge marks its tools as not concurrency-safe, so DSH serializes calls to them instead of running two BaseMind calls in parallel.
- **Failures are per call.** A missing executable, a failed handshake or a crashed relay never prevents DSH from starting: the plugin warns, and the next call retries the relay. Pending calls on a dead relay are failed, not replayed.
- **Repository routing is strict.** If a call arrives with no resolvable agent, and therefore no session working directory, it fails instead of guessing a root. That keeps a tool call from ever reading or writing the wrong repository.

```text
mcp__basemind__code { mode: 'outline', path: 'src/x.ts' }
  -> resolve the session's working directory
  -> get or spawn the relay for that root
  -> MCP tools/call with the raw tool name
  -> project the result as text content
```

## 6. Tools and resources

BaseMind (0.29.3) exposes nine mode-driven domain tools. Under the default `serverName` they register as:

| BaseMind tool | Registered as | Covers |
|---|---|---|
| `admin` | `mcp__basemind__admin` | status, repo info, rescan, cache statistics, gc, telemetry |
| `agents` | `mcp__basemind__agents` | multi-agent communication |
| `code` | `mcp__basemind__code` | outline, symbols, grep, files, find, definition, references, callers, implementations, dependents, expand, semantic search, chunk |
| `git` | `mcp__basemind__git` | status, history, blame, diff |
| `graph` | `mcp__basemind__graph` | calls, neighbours, paths, subgraphs, communities, map, export |
| `memory` | `mcp__basemind__memory` | memory put/recall, document search |
| `shell` | `mcp__basemind__shell` | long-lived shell sessions |
| `web` | `mcp__basemind__web` | scrape, crawl, list |
| `workspace` | `mcp__basemind__workspace` | workspaces, worktrees, branches, claims |

Every tool takes a required `mode` plus mode-specific parameters. The modes are read from the schema the running BaseMind reports, not hard-coded here: a version that adds a mode gets it, and a version that lacks a tool does not register it. Calling a tool this version does not have fails with an explicit message instead of a silent no-op.

**Resources.** BaseMind's MCP resources (`basemind://status`, `basemind://repo/map` at 0.29.3) are registered as resource server `basemind`, so DSH's shared `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource` tools work against them. Listing and reading are forwarded to the relay for the calling session's workspace. Newer BaseMind versions may add resources; they appear through the same route without a plugin change.

**Instructions.** The server instructions BaseMind returns during `initialize` are added as a system-prompt section next to the other MCP servers' instructions, so the model sees BaseMind's usage guidance with no extra setup. If BaseMind sends no instructions, no section is added.

MCP prompt templates are **not** bridged — see §8.

## 7. Lifecycle and cleanup

- Relays stay alive until the plugin is unloaded. There is **no idle eviction**: a relay you stopped using keeps serving if a session comes back to that repository. `maxClients` (default 32) is what bounds the total.
- Opening many repositories without restarting DSH eventually reaches `maxClients`. Raise it, or restart DSH to start over.
- Unloading the plugin removes the tool registrations, the resource provider, the prompt section and the event listeners, then terminates **only the child processes it spawned itself** — by handle, waiting up to 3 s per relay, and never by process name. Nothing else on the machine is scanned or killed.
- Closing a relay's stdin is not enough to stop BaseMind, so the plugin terminates the handle it owns. BaseMind may keep a shared `comms daemon` inside a relay's process tree; terminating a relay can take that daemon down with it, and BaseMind recreates it on the next start.
- A crashed relay has its pending calls failed and is dropped; the next call starts a new one. There is no background reconnect loop.
- The plugin never scans, rescans, rebuilds or garbage-collects a BaseMind index on its own. Those are explicit BaseMind operations, available through the `admin` tool.

## 8. Known limitations

- **MCP prompt templates are not bridged.** BaseMind's `prompts/list` entries (for example `explain-file`, `onboard-repo`, `review-working-tree`, `trace-symbol`) are convenience wrappers over the same tools; ask for the same thing with the domain tools instead.
- **MCP sampling, elicitation, completions and the tasks extension are not supported.** Server-initiated sampling or elicitation requests are refused, not emulated.
- **No automatic BaseMind install and no automatic index scan.** `autoProvision` is opt-in, and the plugin never runs `scan`/`rescan` for you.
- **A BaseMind upgrade is only picked up by new relays.** Relays that are already running keep the executable they were started with, so restart DSH or toggle the plugin to refresh them. If BaseMind sends `tools/list_changed`, a live relay's tool set is re-synced.
- **Windows launchers.** A `.cmd`/`.bat` shim cannot be spawned directly on Windows, so the plugin launches it through `cmd.exe /d /s /c`. That command line cannot carry quoted paths, so a `.cmd`/`.bat` launcher only works when its path contains neither spaces nor cmd metacharacters (`&`, `|`, `<`, `>`, `^`, `%`, `!`, parentheses). The npm-installed `basemind` can be such a launcher; if startup fails, point `BASEMIND_BIN` at the real `.exe`.
- **Large tool schemas.** The nine domain tools carry about 30 KB of JSON schema at BaseMind 0.29.3 (29.4 KiB across the nine input schemas, before normalization), and those schemas travel with every request in which the tools are offered. That is the cost of a fully discovered, version-agnostic toolset.
- **Preset tool policies still apply.** Tools are registered at the profile root; a preset that restricts or isolates its tool set keeps that policy, because the plugin does not register per-agent tools to get around it.
- **Resource support is optional by design.** It depends on DSH's MCP resource seam. If that service is unavailable, tools still work and resources are skipped.

## 9. Coexistence with a manually configured `basemind` MCP row

Do not run both for the same name. If you already have an MCP server configured with `serverName: basemind`, this plugin would register the same `mcp__basemind__*` tools. It detects those duplicate names before registering and **stays inactive** (logging a warning) instead of creating conflicts, and it never modifies the existing row.

Load order matters: if this plugin loads first and the manual row loads later, the manual row can be the one that fails on duplicate names. Disable or remove the manual `basemind` row before enabling this plugin.

A manual MCP server with a **different** name (for example `basemind-repo`) can coexist. You will simply see two sets of BaseMind tools with different prefixes, each with its own `cwd` behaviour.

## 10. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| No BaseMind tools, warning about the executable | `basemind` is not on the `PATH` DSH uses, or `BASEMIND_BIN`/`command` points at something that does not exist | Run `basemind --version` in the same environment; set `BASEMIND_BIN` to an absolute path, or enable `autoProvision` |
| Startup timeout | BaseMind is slow on first run (daemon or cache warm-up), or the executable hangs | Raise `startupTimeoutMs`; check the stderr tail in the warning for index or permission errors |
| Some tools are missing | That BaseMind version does not expose them, or a duplicate name made the plugin stay inactive | Compare with the version's own `tools/list`; check for a manual `basemind` MCP row; nothing is silently dropped |
| No BaseMind tools in a session that predates the plugin, but they work in a new session | Discovery registers profile-wide, and an already-running session does not re-announce itself | Open a new session, or restart DSH from a project directory |
| No tools at all, and nothing was spawned | `discoveryRoot: agent` (the default) waits for the first Session; none has picked a project directory yet | Open a session in a project |
| Warning that the deployment default directory is not a BaseMind workspace | Only possible in `agent-first`/`default` mode: BaseMind refuses a root without `.git` or `basemind.toml` | Keep the default `agent` mode, or point the mode at a real project directory |
| Tools are missing but BaseMind clearly ran, and the launch directory got indexed | `discoveryRoot` is `default` or `agent-first` and the launch directory is a project | Use the default `agent` mode unless you want launch-directory discovery |
| Tools answer for the wrong repository | The session's working directory is not what you think, or another session is in another repository | Call `mcp__basemind__admin` with `mode: 'status'` and check `root`; `cd` and call again |
| `BASEMIND_TOO_MANY_WORKSPACES` | More distinct workspace roots than `maxClients` | Raise `maxClients`, or restart DSH to drop relays; subdirectories of one repository count separately |
| `--root` seems ignored or duplicated | `args` cannot carry `--root`; the relay is spawned with `cwd` set to the root and gets `--root .` appended | Remove `--root` from `args`; BaseMind may still resolve upward to the repository root — that is BaseMind's behaviour |
| Unclear what failed | Diagnostics are plugin warnings (DSH logger) plus BaseMind's stderr. A relay keeps up to 8 KiB of stderr; a startup-failure message carries its last 2 KiB, and the unexpected-close warning adds that tail when `logStderr` is on. | Read the warning text; tool errors also carry the raw tool name, the root and the stderr tail, never your arguments |

## 11. Development

- **Zero runtime dependencies, plain ESM, no build step.** No `node_modules` is required to load the plugin.
- `node --test` runs the unit suite with Node's built-in runner (`npm test` maps to the same command).
- `node --check index.js` and `node --check lib/*.js` are the syntax gate; there is no bundler or transpiler.
- Tests live in `test/*.test.mjs`; fixtures — including the scripted MCP server the plugin-entry tests spawn — live in `fixtures/` at the package root, so a bare `node --test` never tries to execute the fixture as a test. Tests that need a real BaseMind skip themselves when `basemind` is not on `PATH`, so the suite runs on a machine without BaseMind.
- Runtime layout: `index.js` (plugin entry), `lib/config.js`, `lib/executable.js`, `lib/stdio-client.js`, `lib/mcp-session.js`, `lib/schema.js`, `lib/result.js`, `lib/tool-bridge.js`, `lib/workspace-pool.js`.
- A local directory install links this checkout, so edits are picked up on the next load. Run `node --test` before reloading.

## 12. License

MIT.
