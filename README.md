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
| DeepSeek Harness | `>= 0.2.1-rc.3 < 0.3.0-0`, declared in `engines.dsh` and enforced by DSH at install and startup. This version is verified on `0.2.1-rc.5`. |
| Node.js | `>= 24.20.0` (declared in `engines` and pinned with Volta). The plugin is plain ESM with no dependencies. |
| BaseMind | Any version. The plugin does not pin or gate BaseMind: the tools it exposes are exactly what the running `basemind serve` advertises through `tools/list`. This version is verified on BaseMind **0.34.0**; 0.29.3–0.33.0 expose the same code intelligence through the older mode-based tools (which also included `graph`, `web`, `shell` and `workspace`), and 0.34.0 replaced them with the verb tools (see §5.2). |

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

The tool list is read from the running BaseMind, so a newer version may expose more.

Some tools answer with line-oriented text or [TOON](https://toonformat.dev) rather than JSON (`code_outline`, `code_grep`, `find_files`, `git_diff`). The plugin projects whatever text the server sends and does not parse it; the machine-readable form of every 0.34.0 result is in MCP `structuredContent`, which the plugin keeps in its result envelope. Do not `JSON.parse` the text block.

BaseMind's MCP resources (`basemind://status`, plus the `basemind://outline/{path}` and `basemind://memory/{key}` templates) are exposed as resource server `basemind`, so `list_mcp_resources` and `read_mcp_resource` work against them. `basemind://repo/map` was removed upstream together with the `graph` tool.

### 5.2 Upgrading an installation to BaseMind 0.34.0

1. `basemind comms stop` — a 0.33 daemon cannot serve a 0.34 client; while both run, tool calls fail with a retryable `-32003` / `backend_unavailable`.
2. `basemind scan` — 0.34.0 bumps its release minor 33 → 34, so every view rebuilds its index once and the blob store moves to `cache/blobs/v34/`.
3. Reopen every DSH session — the plugin rediscovers the tool list on the new relay.

Tool names changed: `mcp__basemind__code`, `__git`, `__memory`, `__admin`, `__graph`, `__web`, `__shell`, `__workspace` and `__agents` no longer exist, so any permission entry, preset prompt or script that names them must be updated. The plugin does not rewrite presets or permission files.

---

MIT © 2026 Ken. See [LICENSE](LICENSE).
