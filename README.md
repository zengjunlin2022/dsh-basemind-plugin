# dsh-basemind-plugin

English | [繁體中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-basemind-plugin)](https://www.npmjs.com/package/dsh-basemind-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Workspace-aware BaseMind bridge for DeepSeek Harness. Install the bundle and every session gets BaseMind's code-intelligence tools for the repository that session is working in — no MCP row to configure, no agent preset change.

New to BaseMind? Start with the [BaseMind introduction](https://basemind.ai/start/introduction/).

## 1. What it is

This is a DSH bundle. It starts BaseMind's own MCP server (`basemind serve`) for the repository the session is working in, registers the tools BaseMind advertises, and keeps them pointed at that workspace as the session moves. A `cd` inside a session makes the next call use the new repository without restarting anything. It has no UI page and does not modify any agent preset.

| | Manual `basemind` MCP row | This bundle |
|---|---|---|
| Workspace root | static `cwd` in the row config | resolved per call from the session's working directory |
| Tool set | fixed at connect time for that one root | discovered from `tools/list` |
| Rows to configure | one MCP row (plus a manager entry) | none — the bundle inserts its own plugin row |
| Several repositories | one more row each | one relay per root, automatically |

The relay is per workspace root. Since BaseMind 0.34.0 the index, memory and document stores behind it are scoped to a **repository group**, so two worktrees of the same repository share one index and one memory store, while two different repositories do not. That is upstream behaviour, not a missing isolation layer.

## 2. Version

The plugin is available on npm as `dsh-basemind-plugin`; the badge above shows the current version. To check the version in a profile:

```bash
npm view dsh-basemind-plugin version
```

Release notes are in [CHANGELOG.md](CHANGELOG.md).

## 3. Compatibility

| Component | Requirement |
|---|---|
| DeepSeek Harness | `>= 0.2.1-rc.3 < 0.3.0-0`, declared in `engines.dsh` and enforced by DSH at install and startup. This version is verified on `0.2.2-rc.5` (and earlier on `0.2.1-rc.5`). |
| Node.js | `>= 24.20.0` (declared in `engines` and pinned with Volta). The plugin is plain ESM with no dependencies. |
| BaseMind | **0.34.0**, pinned in `lib/upstream.js` and enforced by `binaryPolicy: 'exact'` (the default, §8): a local `basemind` whose major.minor.patch differs is reported in the log and `/basemind-status`, then skipped instead of used, and when no compatible local binary is found, `binaryDownload: true` (the default, §7) installs that pinned release from GitHub. `binaryPolicy: 'minor'` and `'any'` are escape hatches; `'any'` keeps only the MCP bridge and disables skills, the CLI tool and the version notice. Verified with a real external binary on Windows and, for the managed download/install path, on **Windows x64 locally (2026-11-24)** and on **Windows x64 / Linux x64 / macOS arm64 in CI** (`Managed binary` workflow, 2026-11-25, all green) — see §15. Older releases (0.29.3–0.33.0) expose the mode-based tools instead of the verb tools (see §5.2). |

## 4. Install

### 4.1 Install BaseMind

Install the `basemind` program first, following the [BaseMind introduction](https://basemind.ai/start/introduction/), and check the environment DSH will use:

```bash
basemind --version
```

If DSH cannot find `basemind` on `PATH`, point the plugin at the executable with an absolute `BASEMIND_BIN` (or its `command` option).

### 4.2 Install the bundle

- **DSH Desktop:** open the plugin manager (the **Plugins** page), install `dsh-basemind-plugin`, and enable it.
- **CLI-managed profile:** install it with the profile you boot:

  ```bash
  dsh plugin --profile <profile> add dsh-basemind-plugin
  ```

Installations are per profile. If the runtime asks for a restart or a disable/enable toggle to load the new bundle, do that.

### 4.3 Verify

In a session opened on a project, call `mcp__basemind__index_status` with `{}`. It returns that session's workspace root, its index `schema_version` and an `indexing` flag. Under the default `serverName` the 15 verb tools BaseMind 0.34.0 advertises are registered: `code_grep`, `code_outline`, `code_read`, `code_refs`, `code_search`, `code_symbols`, `docs_search`, `find_files`, `git_blame`, `git_diff`, `git_log`, `index_rescan`, `index_status`, `memory_save`, `memory_search`. A comms build also registers `agent_inbox`, `agent_post` and `agent_threads`.

### 4.4 Update and remove

- **Update:** Plugins page → Update, or `dsh plugin --profile <profile> add dsh-basemind-plugin@latest`.
- **Remove:** disable or uninstall the bundle in the plugin manager, or `dsh plugin --profile <profile> remove dsh-basemind-plugin`.

## 5. Usage

Each tool does one thing; there is no `mode` and no `format` switch. Calls use the `mcp__basemind__<tool>` prefix.

**Look at a file's structure before reading it**

```json
{ "tool": "mcp__basemind__code_outline", "arguments": { "path": "index.js" } }
```

**Find where a symbol is defined**

```json
{ "tool": "mcp__basemind__code_symbols", "arguments": { "name": "createWorkspacePool" } }
```

**Find every reference to a symbol**

```json
{ "tool": "mcp__basemind__code_refs", "arguments": { "name": "publicToolName" } }
```

**Read one symbol's body**

```json
{ "tool": "mcp__basemind__code_read", "arguments": { "path": "lib/tool-bridge.js", "symbol": "createToolDefinition" } }
```

**Read git history at symbol resolution**

```json
{ "tool": "mcp__basemind__git_blame", "arguments": { "path": "index.js", "symbol": "activate" } }
```

**See what changed in the workspace**

```json
{ "tool": "mcp__basemind__git_diff", "arguments": {} }
```

**Check index health for the current workspace**

```json
{ "tool": "mcp__basemind__index_status", "arguments": {} }
```

### 5.1 Tools

| Tool | Covers |
|---|---|
| `mcp__basemind__code_outline` | the symbols in one file |
| `mcp__basemind__code_symbols` | find a symbol by name |
| `mcp__basemind__code_grep` | literal text or regex search inside indexed files (`regex: true` for a regex) |
| `mcp__basemind__code_search` | semantic code search |
| `mcp__basemind__code_read` | one symbol's body, or an exact line span |
| `mcp__basemind__code_refs` | references, callers, implementations, importers and definition (via `relation`) |
| `mcp__basemind__find_files` | locate files by name |
| `mcp__basemind__docs_search` | project documents |
| `mcp__basemind__memory_save`, `mcp__basemind__memory_search` | key/value memory and its search |
| `mcp__basemind__git_log`, `mcp__basemind__git_diff`, `mcp__basemind__git_blame` | history, working-tree diff, blame |
| `mcp__basemind__index_status`, `mcp__basemind__index_rescan` | index health and a rescan (`{}` rescans the whole workspace) |
| `mcp__basemind__agent_inbox`, `mcp__basemind__agent_post`, `mcp__basemind__agent_threads` | agent comms (comms build only) |

The tool list is read from the running BaseMind. Under the default `binaryPolicy: 'exact'` that build is the pinned **0.34.0** (§8); another version runs only behind the `minor` / `any` escape hatches, and only then can a newer build expose a different tool set.

Some tools answer with line-oriented text or [TOON](https://toonformat.dev) rather than JSON (`code_outline`, `code_grep`, `find_files`, `git_diff`). The plugin projects whatever text the server sends and does not parse it; the machine-readable form of every 0.34.0 result is in MCP `structuredContent`, which the plugin keeps in its result envelope. Do not `JSON.parse` the text block.

BaseMind's MCP resources (`basemind://status`, plus the `basemind://outline/{path}` and `basemind://memory/{key}` templates) are exposed as resource server `basemind`, so `list_mcp_resources` and `read_mcp_resource` work against them. `basemind://repo/map` was removed upstream together with the `graph` tool.

### 5.2 Upgrading an installation to BaseMind 0.34.0

1. `basemind comms stop` — a 0.33 daemon cannot serve a 0.34 client; while both run, tool calls fail with a retryable `-32003` / `backend_unavailable`.
2. `basemind scan` — 0.34.0 bumps its release minor 33 → 34, so every view rebuilds its index once and the blob store moves to `cache/blobs/v34/`.
3. Reopen every DSH session — the plugin rediscovers the tool list on the new relay.

Tool names changed: `mcp__basemind__code`, `__git`, `__memory`, `__admin`, `__graph`, `__web`, `__shell`, `__workspace` and `__agents` no longer exist, so any permission entry, preset prompt or script that names them must be updated. The plugin does not rewrite presets or permission files.

### 5.3 The first turn of a new session

A new Agent is released to its first prompt only after the BaseMind relay has answered, so that turn already carries the tools, the bootstrap section and the skills catalog. The wait is bounded by `coldStartTimeoutMs` (default 15000 ms; `0` disables the wait; the accepted maximum is 120000). Past the budget the turn proceeds without BaseMind exactly as before, and the background attempt still registers the tools as soon as it finishes.

Two details matter when you tune it:

- The budget covers `workingDirectory.ensure`, the relay handshake and `tools/list`. A slow or remote working directory that misses it is still adopted in the background, so that session gets its tools on a later turn instead of losing them.
- The first start after a fresh `binaryDownload` managed install may spend 13.5–55.7 s downloading 75–102 MB. Unless `coldStartTimeoutMs` is raised accordingly, that first session's first turn can still run without BaseMind tools; later sessions reuse the warm cache and wait only for the handshake.

## 6. Local-first binary selection

On every start the plugin performs one selection per process, in this order:

1. `command` when it is not the default `basemind` (an absolute path is used as given).
2. `BASEMIND_BIN` (only while `command` stays at its default).
3. `basemind` on `PATH`.
4. the managed cache for the pinned version and platform.
5. the official GitHub release for the pinned version (only when `binaryDownload: true`).
6. `npx -y <npxSpec>` — the legacy path, only when `autoProvision: true` and everything above failed.

Every candidate must pass the version policy before it is used. A local binary that does not match is reported in the log and in `/basemind-status`, then the next candidate is tried. `binaryFallback: false` stops at an incompatible explicit binary instead of falling through.

The selection is fixed for the life of the process: every relay, CLI call and diagnostic uses it, and changing a session's working directory does not re-select. A compatible local hit or a valid cache hit performs no network request. Only the plugin-owned cache is written (state.json per workspace, install.json for a managed install).

## 7. Managed binary download (on by default)

`binaryDownload: true` is the default and is declared explicitly in `cordis.patch.yml`. When no local compatible binary exists, the plugin downloads the pinned asset from `github.com/Goldziher/basemind/releases/download/v<version>/`, verifies the published SHA256 from `basemind_<version>_checksums.txt`, unpacks the **complete release tree** with pure Node (tar.gz or zip: the main binary, the bundled `lib/` DLL/SO/DYLIB files, root DLLs for Windows, `licenses/**`, `LICENSE`, `ATTRIBUTIONS.md` and `THIRD_PARTY_LICENSES`; traversal, symlink, hardlink and device entries are rejected), probes the unpacked binary, records every installed file in `install.json` and swaps the directory in atomically. The tree must be complete: the Windows executable statically imports `heif.dll`, and the Linux/macOS binaries load `lib/` through their RUNPATH/`@loader_path`, so a single-file install cannot start on any of the four platforms.

- It writes only under `$DSH_HOME/cache/dsh-basemind-plugin/`.
- It never touches the BaseMind data home, the project, the npm installation or `PATH`, and it never runs an installer.
- Failure fails closed: an unverified binary is never executed, the plugin stays without tools, and `/basemind-status` plus one log line explain why.
- Retries are bounded (two extra attempts); repeated failures back off for ten minutes per target.
- Disk cost: about 230–320 MB per installed platform, because the whole uncompressed release tree is kept (the asset download itself is 75–102 MB). Only the pinned version and target are installed.
- Upgrading from a layout-1 cache (a single binary plus the old install record) re-downloads the full tree once on the next start. The old directory is swapped out atomically, never patched.
- Set `binaryDownload: false` to forbid it completely.

## 8. Version policy

`binaryPolicy` decides which found version counts as compatible with the pinned upstream version (currently `0.34.0`):

| Value | Accepts | Notes |
| --- | --- | --- |
| `exact` (default) | the same major.minor.patch | prereleases are rejected |
| `minor` | the same major.minor | patch is ignored, prereleases still rejected; use only after verifying that patch |
| `any` | any executable | MCP bridge only: skills, the CLI tool and the version notice stay off |

If you are stuck on `0.34.1`, either wait for a plugin release that pins and verifies it (recommended — the skills text and the CLI allowlist ship with the pin), or set `binaryPolicy: 'minor'` and accept that the skills were not verified against that patch.

## 9. Cache, offline use and a custom binary

- Cache: `$DSH_HOME/cache/dsh-basemind-plugin/managed-binaries/<version>/<platform>/` where platform is `windows-x64`, `linux-x64`, `linux-arm64` or `darwin-arm64`; metadata lives in `install.json` (layout 2: main binary, its own `binarySha256`, file count and every installed `{ path, size }`; `sha256` stays the digest of the downloaded archive), failure state in `state.json`, temporary downloads in `download/`. `$DSH_HOME` is `DSH_HOME` when set, otherwise `~/.dsh`.
- Reuse: a valid cache hit requires every recorded file to exist with its recorded size, so the binary, the bundled libraries and the licence files must all be there. Size and mtime are checked with `stat`; the main binary is re-hashed only when they differ from the record. A valid hit performs no network request at all. Deleting the cache directory is safe; the next start re-selects.
- Layout migration: a layout-1 cache (one binary plus an old install record, or no record) is incomplete and is replaced by a full download on the next start when `binaryDownload: true`. It is not patched in place. `/basemind-status` shows the layout, the recorded file count and the first missing file.
- Interrupted swap: if the process stopped between moving the previous tree aside and moving the new one in, that tree sits next to the target as `.old-<platform>-*`. The next selection restores it (no download) before reading the cache and removes any superseded leftover, so a crash cannot lose the cache or leak 230–320 MB.
- Offline: `binaryDownload: false` forbids every network request. The supported offline paths are a full official BaseMind install on `PATH` (the complete release tree, not just the executable), `command`, or `BASEMIND_BIN`. Hand-placing a single binary in the managed cache is not a supported install and is treated as incomplete.
- Custom binary: set `command: "C:\\tools\\basemind\\basemind.exe"` or `BASEMIND_BIN`. `binaryFallback: false` turns an incompatible pin into a hard stop with a diagnostic instead of a silent fallthrough.

## 10. Checking the local binary: /basemind-status

Type `/basemind-status` in the composer. It is a human command: it does not call the model and does not consume tokens. It reports whether a binary is present, its path, the found and expected versions, whether they are compatible, the selection source, the cache state, the download state and the two or three actions that would fix the situation.

```
BaseMind status - dsh-basemind-plugin 0.2.1
  expected upstream : 0.34.0 (exact)
  platform          : windows-x64 (x86_64-pc-windows-msvc)
  present           : yes
  path              : ...\Programs\basemind\basemind.exe
  found             : 0.33.0
  compatible        : NO - minor mismatch (0.33 vs 0.34)
  source            : path
  managed cache     : empty (...\.dsh\cache\dsh-basemind-plugin\managed-binaries)
  download          : enabled (binaryDownload=true)

  What to do:
    - install BaseMind 0.34.0 and point command / BASEMIND_BIN at it, or
    - restart DSH later so the next start retries after a short cooldown, or
    - set binaryPolicy: "minor" to accept 0.34.x only after you have verified it.
```

It is not a settings page, and it does not add a card to the Settings or Plugins UI.

## 11. Official skills

The package ships the ten official BaseMind skills (`basemind`, `basemind-cli`, `basemind-code-search`, `basemind-comms`, `basemind-doctor`, `basemind-documents`, `basemind-git-history`, `basemind-multi-agent-room`, `basemind-scan`, `basemind-stats`) and registers them through `ctx.skills.registerProvider()` at rank 1000. A skill with the same name from the project, from `~/.dsh/skills`, or from another plugin wins; the plugin's copy appears only when nothing else provides that name. The catalog carries name and description only, and the body loads when the model opens the skill. `skills: false` disables them.

The DSH adaptations of the upstream text live in `skills/.dsh-adapt.json`; regenerate with `npm run sync:skills` and verify with `npm run check:skills`. Do not edit `skills/**` by hand.

## 12. MCP tools and the CLI bridge

All MCP tools come from the running BaseMind, so the set follows the binary. Alongside them the plugin registers `mcp__basemind__cli`: argv only, read-only, no shell, running the same verified binary as the relay. It covers capabilities that have no MCP tool (`code explain`, `code impact`, `code deadcode`, `code cycles`, `code migration check`, `overview`, `git hotspots`, `doctor`, `status`, `upgrade --plan`, `manual`). Destructive verbs (`scan`, `rescan`, `serve`, `comms`, `memory put/delete/clear`, `cache clear/gc`, a bare `upgrade`) are refused with an explanation. Output is capped at 64 KB with a spill path, and `timeout_ms` is clamped to the tool-call timeout. `cliTool: false` disables it.

## 13. Bootstrap prompt section

One short prompt section covers only what BaseMind's own MCP instructions do not: the CLI-only verbs, the fallback to the harness's own read/grep/glob/bash tools, and the workspace semantics. It is empty until a verified binary is serving tools, contains no timestamp or absolute path, and costs at most about 400 tokens. `bootstrap: false` disables it.

## 14. Syncing the next BaseMind release

`lib/upstream.js` is the only place the pinned version lives. The upgrade checklist (sync skills, capture fixtures, run the gates) is in [docs/upstream-sync.md](docs/upstream-sync.md).

## 15. What has been verified

Three separate gates. They are deliberately **not** interchangeable — passing one says nothing about the others.

| Gate | Command | What it proves | Configured in | Run for this change set |
| --- | --- | --- | --- | --- |
| Local/unit | `npm test` | Everything that does not need a real BaseMind as a subject. The two real suites run only when a compatible BaseMind is on `PATH` or in `BASEMIND_BIN`; otherwise they skip. | `ci.yml` | Windows x64, locally: 455 tests, 445 pass, 10 skipped (the gated managed suite) |
| External binary contract | `BASEMIND_REQUIRE_INTEGRATION=1 node --test test/integration.test.mjs test/integration-legacy.test.mjs` | The MCP/CLI contract of a BaseMind build installed **outside** the plugin and unpacked with the system `tar`/`unzip` (`compat.yml`). Structurally cannot detect a broken managed install. | `compat.yml` (Ubuntu x64, macOS arm64, Windows x64) | **NOT RUN** in CI yet (the workflow is dispatchable; the two suites did run locally against a real 0.34.0 inside `npm test`) |
| Managed install | `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1 node --test test/integration-managed.test.mjs` | The plugin's **own** path: real download of the pinned asset, published-SHA256 verification, complete tree extraction, layout-2 install record, real `basemind --version`, real MCP relay tools/resources and real CLI verbs from that managed binary (`managed-binary.yml`). | `managed-binary.yml` (Windows x64, Linux x64, macOS arm64; Linux arm64 only via the `include_linux_arm64` input) | **Windows x64 locally: passed twice on 2026-11-24** (cold install 13.5–55.7 s, network-dependent; warm selection 57–77 ms, 0 network). **CI: all green on 2026-11-25** for Windows x64, Linux x64 and macOS arm64 (manual `Managed binary` dispatch on `72d4fde`, run [45538156378](https://github.com/zengjunlin2022/dsh-basemind-plugin/actions/runs/45538156378)). Linux arm64: **NOT RUN** (opt-in only) |

### 15.1 Phase 3 effectiveness benchmark (2026-11-25)

A separate A/B benchmark measured what the plugin's Bootstrap/Skills/CLI surfaces add on
top of the same MCP tools: group A disables those three surfaces, group B keeps the
defaults, everything else (commit, BaseMind 0.34.0, index, model, prompt, preset) is
identical. 34 runs (Pilot 12 + full 22) across two models and six tasks:

- **Correctness: identical** — every run in both groups passed its rubric; no task regressed.
- **Cost: mixed and small-sample** — on DeepSeek group B used 11.3% more tokens (3.46M vs 3.10M, 6 runs each); on GPT 70% more (1.27M vs 0.75M, 5 runs each).
- The B2 GPT pair was not run (cost) and several runs exceeded the 400k per-run budget; both are recorded.

Results and deviations: [docs/2026-11-25-basemind-benchmark-report.md](docs/2026-11-25-basemind-benchmark-report.md).
This is effectiveness evidence, not release gating; the gates above stand on their own.

Details of the gate contract:

- `npm test` never downloads the release: without `BASEMIND_REQUIRE_MANAGED_INTEGRATION` the managed suite skips with a message that names the variable.
- With the gate set, a missing or unreachable release, a checksum mismatch, an incomplete install, a relay that does not start, or a tool that does not answer **fails** the run. It never degrades to a skip.
- The suite asserts that no `basemind` is resolvable on `PATH` and removes every `PATH` entry carrying BaseMind's private runtime libraries, so a global Windows install's DLLs cannot make an incomplete managed tree look usable.
- `DSH_BASEMIND_MANAGED_TEST_KEEP=1` keeps the throwaway root; `MANAGED_DIAGNOSTICS_DIR=<dir>` writes one small diagnostics JSON (selection, cache facts, install record, timings) for CI artifacts.
- `test/workflows.test.mjs` (part of `npm test`) statically guards the CI contract: no job-level `if` on `matrix`, verbatim `uname -m` architecture values, no fake-green switches, no hardcoded BaseMind version, and the release gate wired to this same workflow.

The managed path supports exactly the targets in `lib/upstream.js`: `windows-x64`, `linux-x64`, `linux-arm64`, `darwin-arm64`. Upstream publishes no macOS x64 or Windows arm64 asset, so those are **not** supported by the managed path. Linux arm64 is not scheduled by default anywhere, because this repository cannot confirm the `ubuntu-24.04-arm` runner label; a maintainer opts in explicitly.

DSH Desktop acceptance (D1–D15) is a separate manual checklist: [docs/2026-11-24-basemind-desktop-acceptance-checklist.md](docs/2026-11-24-basemind-desktop-acceptance-checklist.md). **D1–D15 are all verified as of 2026-11-25** on DSH `0.2.2-rc.5` (real desktop profile plus an isolated `DSH_HOME` for the managed-fallback items): [acceptance report](docs/2026-11-25-basemind-desktop-acceptance-report.md).

---

MIT © 2026 Ken. See [LICENSE](LICENSE).
