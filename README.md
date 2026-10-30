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

## 2. Version

The plugin is available on npm as `dsh-basemind-plugin`; the badge above shows the current version. To check the version in a profile:

```bash
npm view dsh-basemind-plugin version
```

## 3. Compatibility

| Component | Requirement |
|---|---|
| DeepSeek Harness | `>= 0.2.1-rc.3 < 0.3.0-0`, declared in `engines.dsh` and enforced by DSH at install and startup. This version is verified on `0.2.1-rc.5`. |
| Node.js | `>= 22` (declared in `engines`). The plugin is plain ESM with no dependencies. |
| BaseMind | Any version. The plugin does not pin or gate BaseMind: the tools it exposes are exactly what the running `basemind serve` advertises through `tools/list`. |

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

In a session opened on a project, call `mcp__basemind__admin` with `{ "mode": "repo" }`. It returns the workspace root and HEAD of that session's repository. Under the default `serverName`, nine tools are registered: `admin`, `agents`, `code`, `git`, `graph`, `memory`, `shell`, `web`, `workspace`.

### 4.4 Update and remove

- **Update:** Plugins page → Update, or `dsh plugin --profile <profile> add dsh-basemind-plugin@latest`.
- **Remove:** disable or uninstall the bundle in the plugin manager, or `dsh plugin --profile <profile> remove dsh-basemind-plugin`.

## 5. Usage

Every tool takes a required `mode` plus mode-specific parameters, under the `mcp__basemind__<tool>` prefix.

**Look at a file's structure before reading it**

```json
{ "tool": "mcp__basemind__code", "arguments": { "mode": "outline", "path": "index.js" } }
```

**Find where a symbol is defined**

```json
{ "tool": "mcp__basemind__code", "arguments": { "mode": "symbols", "name": "createWorkspacePool" } }
```

**Find every call site of a symbol**

```json
{ "tool": "mcp__basemind__code", "arguments": { "mode": "references", "name": "publicToolName" } }
```

**Read git history at symbol resolution**

```json
{ "tool": "mcp__basemind__git", "arguments": { "mode": "blame_symbol", "path": "index.js", "name": "activate" } }
```

**See the repository's architecture**

```json
{ "tool": "mcp__basemind__graph", "arguments": { "mode": "map" } }
```

**Check index health for the current workspace**

```json
{ "tool": "mcp__basemind__admin", "arguments": { "mode": "status" } }
```

### Tools

| Tool | Covers |
|---|---|
| `mcp__basemind__admin` | status, repo info, rescan, cache statistics, gc, telemetry |
| `mcp__basemind__agents` | multi-agent communication |
| `mcp__basemind__code` | outline, symbols, grep, files, find, definition, references, callers, implementations, dependents, expand, semantic search, chunk |
| `mcp__basemind__git` | status, history, blame, diff |
| `mcp__basemind__graph` | calls, neighbours, paths, subgraphs, communities, map, export |
| `mcp__basemind__memory` | memory put/recall, document search |
| `mcp__basemind__shell` | long-lived shell sessions |
| `mcp__basemind__web` | scrape, crawl, list |
| `mcp__basemind__workspace` | workspaces, worktrees, branches, claims |

The modes are read from the running BaseMind, so a newer version may expose more. BaseMind's MCP resources (`basemind://status`, `basemind://repo/map`) are exposed as resource server `basemind`, so `list_mcp_resources` and `read_mcp_resource` work against them.

---

MIT © 2026 Ken. See [LICENSE](LICENSE).
