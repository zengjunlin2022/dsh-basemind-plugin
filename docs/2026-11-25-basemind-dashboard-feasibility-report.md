# BaseMind Dashboard — Feasibility Report (Phase A)

Date: 2026-11-25
Plan: [2026-11-25-lightweight-workspace-dashboard-implementation-plan.md](./2026-11-25-lightweight-workspace-dashboard-implementation-plan.md)
Runtime under test: DSH Desktop **0.2.2-rc.5** (app.asar @dsh/package.json), plugin 0.2.1, BaseMind **0.34.0** (managed binary), Node 24.20.0, Windows x64.

Every statement below comes from the installed runtime or from an isolated real BaseMind
invocation. Nothing is inferred from README examples.

## 1. DSH client-extension contract (plan §9, §10)

### 1.1 What the installed runtime actually supports

| Question | Evidence | Verdict |
| --- | --- | --- |
| Can a bundle load a browser half? | `package.json` of @deepseek-ai/dsh-client-ui-plugin-manager and @linxin666/dsh-client-ui-git-graph (installed profile) both declare `dsh.client = { inject: [...], platform: 'web' }` and export `./client`. | **SUPPORTED** |
| What format is the browser bundle? | `lib/client.js` of the installed git-graph and config-manager: `window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })`, a lazy-CJS factory. | **SUPPORTED**, hand-writable (no bundler needed) |
| Which modules may the factory require? | The web frontend bundle (`dsh-web-frontend/dist/assets/index-*.js`) seeds exactly: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`. | **SUPPORTED** (only `react` needed) |
| Does the Plugins page offer an entry point for a bundle's own page? | `dsh-client-ui-plugin-manager/src/client/slot-contract.ts` declares pluggable slots, including **`plugins.row.config` keyed by `<package>#<row id>`**; the page renders `view: 'page'` with a Configure control on that row (`PluginManagerPage.tsx` `renderSlot('plugins.row.config', { view: 'page', form }, { entryKey })`). | **SUPPORTED** — this is decision order **B** (native row configuration page) |
| Does registering a page require touching DSH source or the production profile? | No: `ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name, key, locale }, Component))`, as config-manager does for `settings.section`. | **SUPPORTED** |
| How does a client page call the Host? | Host plugins register named routes on `ctx.webServer` (`register({ kind, path, handler })` → disposer); config-manager's 82 routes are the working precedent, guarded by a loopback/same-origin fence. | **SUPPORTED** (native HTTP route family, no new server) |
| Workspace list | `ctx.workspaceRegistry.list(): Workspace[]` with `id / path / title / createdAt / updatedAt`; `resolveByPath(path)` canonicalises. | **SUPPORTED** (identity is a registry id, never a client-supplied path) |
| Theme | The web CSS exposes `--dsw-alias-label-primary/secondary/tertiary`, `--dsw-alias-bg-base/layer-1/2/3`, `--dsw-alias-border-l1..l4`, `--dsw-alias-state-business/success/warn/error-primary`, `--dsw-radius-sm/md`. | **SUPPORTED** (inline styles, no CSS framework) |

### 1.2 Rejected alternatives

- **Own router / own page**: no such contract in this runtime; rejected without spike.
- **Settings page (`settings.section`)**: works, but the Dashboard belongs to the BaseMind row and the plan asks for the Plugins area, not global Settings.
- **DOM injection, monkey patch, extra HTTP server**: forbidden by plan §10-D and unnecessary.

## 2. BaseMind 0.34.0 data contract (plan §12)

Probed with the managed binary in a throwaway `BASEMIND_DATA_HOME` / `BASEMIND_COMMS_DIR`,
a scratch git repository, and `NO_COLOR=1`. Every command below is the one the Dashboard
uses; none is a guess from README text.

| Data Source | JSON shape (verified) | Scope | Side effects | Cost (measured) | Error contract | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| `basemind status --json` | `file_count, blob_count, total_size_bytes, languages{lang:count}, large_files{threshold_lines,count}, most_imported[], cache_dir, grammar_dir, schema_version:34, root, branch, head_sha/head_short_sha, config_stamp, elapsed_us, admission{heavy,medium,queue_wait_ms}, startup_us`; unindexed adds `notice{state:'empty_index', message, retry}` | workspace | **does not build an index**; creates the workspace cache directory; a cold data home downloads the tree-sitter grammar bundle (22,118,403 B, 16.5 s startup) | warm 1.2 s incl. process start (`elapsed_us` 1.9 ms) | exit 0 even for an empty index | **SUPPORTED** (Overview) |
| `basemind overview --json --sections languages --limit N` | `files, lines, bytes, languages[{language,files,lines,bytes}]` | workspace | none observed | 1.0 s cold process, 0.2 ms query | exit 0 | **CONDITIONAL** — costs a second process; only per-language line counts, so Overview uses `status` counts and keeps shares on `file_count` (plan §23) |
| `basemind doctor --json` | `ok, checks[{check,status:'ok'|'warn'|'FAIL',detail}]` (version, root, config, index, grammars, hook, daemon, cache) | workspace + install | none observed (no repair) | 0.4–1.3 s | **exit 1 when a check fails, JSON still printed** | **SUPPORTED** (Diagnostics; `allowNonZero`) |
| `basemind cache stats --json` | `blobs_bytes, views_bytes, lance_bytes, git_history_bytes, telemetry_bytes, total_bytes, blob_count, orphan_blob_count, blob_accounting_ok, per_view_file_count, repo_groups, last_gc, rss_bytes, peak_rss_bytes` | **machine-global cache** | none | 0.2 s | exit 0 | **SUPPORTED**, with `rss` labelled as the **query process**, not daemon or project memory (plan §35) |
| `basemind admin telemetry --window <today\|1h\|24h\|all> --json` | `window, total_calls, total_resp_bytes, total_est_tokens_saved, per_tool[], per_baseline[], recent[], truncated, savings_note` | **machine-global telemetry** | none | 0.3 s | exit 0 | **SUPPORTED**, scope labelled; `savings_note` surfaced (heuristic estimate) |
| `basemind scan --json` | `scanned, updated, removed, skipped_unchanged, skipped_no_lang, docs_indexed, docs_degraded, docs_text_fallback, doc_timeouts, extract_failed, elapsed_ms, root` | workspace (forwarded to the daemon when one runs) | writes the index and git-history index | 33 s cold for 3 files (includes grammar fetch + git history); synchronous | non-zero exit + stderr | **SUPPORTED** (explicit full scan) |
| `basemind rescan [PATH...] --json` | same summary, scoped to the paths | workspace | writes the index | 0.47 s whole tree / 0.44 s one path (warm) | exit 2 for an invalid path, one message per path ("outside the repository root", "does not exist and is not in the index") | **SUPPORTED** (incremental scan) |
| scan progress / cancel | none | — | — | — | — | **UNSUPPORTED** (DEGRADED to state + elapsed, plan §29) |
| `index_status` MCP tool | superset of `status` on a running relay | workspace | starts a relay | — | — | Not used: the Dashboard must not create a relay (plan §8.3) |

### 2.1 Side-effect findings that changed the design

1. **A cold data home downloads grammars even for `status`.** The Dashboard therefore never
   chooses a data home or a binary: it reuses the one the Agent-facing plugin already selected,
   and a missing selection is reported as `binary-unavailable` instead of triggering a probe or
   download (plan §8.5).
2. **`status` creates the workspace cache directory.** Tolerable (it is BaseMind's own cache),
   but it is why every query is explicit and never runs at plugin activation.
3. **Workspace roots are guarded upstream.** A directory that is neither a git repository nor
   holds `basemind.toml` is refused with exit 1 and a long diagnostic. The Dashboard passes that
   message through verbatim (it is actionable) and does not try `BASEMIND_ALLOW_ANY_ROOT`.
4. **`doctor` exits 1 on a failing check** while still printing JSON; treating non-zero as a
   transport error would throw away the diagnosis. Diagnostics parses the body either way.
5. **`scan` is a shared-daemon operation.** With a relay up, the CLI forwards the scan to the
   daemon; terminating the CLI process is **not** a daemon cancel (plan §28). The Dashboard v1
   offers no cancel at all.

## 3. Classification (plan §13)

| Capability | Classification | Note |
| --- | --- | --- |
| Plugins-page entry, independent Dashboard page, four tabs | SUPPORTED | `plugins.row.config` page |
| Overview: health, file/blob counts, index bytes, language distribution, most-imported, admission | SUPPORTED | one `status` call |
| Diagnostics: binary/version, doctor checks (incl. daemon, grammars, index), plugin version, relay count | SUPPORTED | read-only; no repair |
| Statistics: cache components, machine-global telemetry, per-tool calls, estimated tokens saved | SUPPORTED | scopes labelled; RSS is per query process |
| Full and incremental scan submitted by the user | SUPPORTED | confirm-first UI, machine-wide serialisation |
| Scan progress / cancel / live percentage | UNSUPPORTED | DEGRADED to job state + elapsed, never simulated |
| Last scan timestamp / freshness from BaseMind | UNSUPPORTED | Overview shows the last **Dashboard-submitted** scan and says so |
| Multi-project switching | PARTIAL | DSH Workspace registry only; no reliable "current session" resolver for a Host-only plugin, so the first registry entry is selected and `followCurrentSession: false` is declared |
| Live Desktop UI acceptance (D1-style) | **NOT RUN** | no isolated Desktop profile install was performed; the production profile was not touched (see execution report §UI) |

## 4. Performance cost model

- Activation: no query, no timer, no relay, no daemon. Registration is six route objects.
- One open Dashboard tab: one `status` per 5 s cache window for Overview; Diagnostics and
  Statistics each run their own explicit queries when the tab opens (0.4–1.4 s warm).
- Reads are serialised Host-wide (one BaseMind CLI child at a time) with a 4-request queue and
  identical-request coalescing, so a page cannot fan out into parallel processes.
- Scans are the only expensive operation and are always user-confirmed; the Dashboard never
  measures scan cost as UI cost (plan §38 P6).
