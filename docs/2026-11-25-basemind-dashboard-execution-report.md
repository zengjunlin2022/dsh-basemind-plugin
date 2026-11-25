# BaseMind Dashboard — Execution Report

Date: 2026-11-25
Plan: [2026-11-25-lightweight-workspace-dashboard-implementation-plan.md](./2026-11-25-lightweight-workspace-dashboard-implementation-plan.md)
Feasibility: [2026-11-25-basemind-dashboard-feasibility-report.md](./2026-11-25-basemind-dashboard-feasibility-report.md)
Review: [2026-11-25-basemind-dashboard-review-report.md](./2026-11-25-basemind-dashboard-review-report.md)

## 1. Baseline

| Item | Value |
| --- | --- |
| Repository | dsh-basemind-plugin, branch `feat/lightweight-workspace-dashboard` (created from `main`) |
| Baseline commit | `0e94e3e` (plugin 0.2.1, "fix(test): 隔离 BASEMIND_BIN … 并发布 0.2.1") |
| Working tree before work | only the untracked plan document |
| DSH runtime | 0.2.2-rc.5 (Desktop, `app.asar/dsh/package.json`) |
| BaseMind | 0.34.0, managed binary `$DSH_HOME/cache/dsh-basemind-plugin/managed-binaries/0.34.0/windows-x64/basemind.exe` |
| Node.js | 24.20.0 (Volta pin) |
| Commits | **none**: plan §52 and AGENTS.md §12 forbid `git add/commit/push`; the user reviews and commits |

## 2. What was implemented

### 2.1 Host half (new, `lib/dashboard/`)

| File | Responsibility |
| --- | --- |
| `contracts.js` | Pure normalisers for `status/overview/doctor/cache stats/telemetry/scan/rescan` JSON, plus the repo-relative scope validator. Unknown values stay `null`, never `0`. |
| `run.js` | One argv-only BaseMind spawn through `ctx.subprocess.spawn` (never `node:child_process`, never a shell), bounded output, timeout, terminate-on-abort. |
| `workspaces.js` | `ctx.workspaceRegistry.list()` → `{id,title,path,name}`; missing registry is a documented `unavailable`, not an error. |
| `history.js` | Bounded (10/workspace, 50 workspaces) scan history in the plugin's own cache, atomic `tmp+rename`, schema-validated on read, switchable off. |
| `service.js` | Queries, 5 s snapshot cache (8 entries), identical-request coalescing, one-at-a-time limiter with a 4-request queue, scan state machine, machine-wide scan serialisation, dispose. |
| `routes.js` | Five exact routes for six operations under `/api/dsh-basemind-dashboard`: `GET workspaces/overview/diagnostics/statistics`, one `scan` route for `GET` (state) and `POST` (start); loopback + same-origin fence, method whitelist, 64 KiB body cap, one `{error,code}` shape. |
| `client.js` | Browser half in the DSH module-loader format (hand-written, no build): registers `plugins.row.config` keyed `dsh-basemind-plugin#dsh-basemind`, draws Overview / Scan / Diagnostics / Statistics with DSH theme tokens, zh+en dictionaries, loading/empty/error states. |

### 2.2 Host wiring (modified)

- `index.js`: `registerDashboard()` runs inside the existing single effect, reads `ctx.get('webServer')` optionally (and re-runs through `ctx.inject(['webServer'], …)` when the service arrives later), builds the service from the already-selected binary, registers the six routes, and is disposed first during `shutdown()`. It performs no query, starts no timer and creates no relay.
- `lib/config.js`: `dashboard` (default true) and `dashboardHistory` (default true), both validated and switchable off.
- `package.json`: `./client` export and `dsh.client = { inject: ['@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-ui-plugin-manager'], platform: 'web' }`.
- `cordis.patch.yml`: both settings declared with their cache-write rule.
- `scripts/check-pack.mjs`: the seven Dashboard modules are now required package contents.

### 2.3 Architecture

    Plugins page (plugins.row.config, key dsh-basemind-plugin#dsh-basemind)
      → client.js (React, inline DSH styles)
      → fetch /api/dsh-basemind-dashboard/*   (loopback + same-origin)
      → service.js (cache · coalescing · 1-at-a-time · scan jobs · history)
      → run.js → ctx.subprocess.spawn → the already-selected basemind binary
      → official read-only verbs (status/doctor/cache stats/telemetry) and explicit scan/rescan

The Agent surfaces (tools, relay, pool, bootstrap, skills) are untouched; the Dashboard shares
only the selected binary and, for diagnostics, the relay count.

## 3. Interface results (measured)

| Operation | Implementation | Measured (warm) |
| --- | --- | --- |
| Overview | `basemind status --json --root .` | 1.2 s process end-to-end, 1.9 ms query |
| Diagnostics | `doctor --json` + `status --json` | 0.4–1.3 s |
| Statistics | `cache stats --json` + `admin telemetry --window … --json` | 0.2 s + 0.3 s |
| Full scan | `scan --json --root .` | 33 s cold on a 3-file repo (grammar fetch + git history); summary parsed |
| Incremental scan | `rescan <paths> --json --root .` | 0.44 s one path / 0.47 s whole tree |
| Invalid scope | refused before any spawn | `400 bad-scope` |
| No binary selected | `503 binary-unavailable`, no probe, no download | unit test |
| Second scan | `409 scan-busy` (machine-wide) | unit + integration |

## 4. UI result

### 4.1 What is implemented

Plugins page → BaseMind row → **Configure** → a full page with four tabs:

- **Overview**: index badge (ready / not-indexed / degraded / error / unknown), file count, blob count, index size, language count, branch/HEAD, language table with CSS share bars (share only when `file_count > 0`), most-imported, oversized files, BaseMind's own notice verbatim, active-scan banner, last Dashboard scan, and a line stating that BaseMind exposes no scan timestamp.
- **Scan**: current job (state/type/scope/elapsed/summary/error), confirm-first full scan naming the path and the CPU/RAM/IO risk, incremental path box with client-side rejection of absolute/traversal paths, 10-entry history, and an explicit "no progress API" note. While a submitted job runs, the page polls `GET /scan` every 3 s and stops when it finishes or the tab closes.
- **Diagnostics**: plugin version, binary state/version/source, index state, relay count, every `doctor` check with its own verdict, and a read-only statement.
- **Statistics**: window selector (today/1h/24h/all), tool calls, estimated tokens saved, response bytes, cache bytes, query-process peak RSS, per-tool table, cache components, and the machine-global scope labels plus the heuristic-estimate note.

Switching a tab loads only that tab; closing the page removes the listeners and poll timer.
Unknown values render "not available" — never a zero, never a fabricated figure.

### 4.2 Verification performed here

| Check | Result |
| --- | --- |
| Bundle loads through the documented loader contract and registers id `dsh-basemind-plugin` | PASS (`test/dashboard-client.test.mjs`) |
| `apply` registers exactly one `plugins.row.config` entry with key `dsh-basemind-plugin#dsh-basemind` (matches `cordis.patch.yml` row id) | PASS |
| zh/en dictionaries carry identical key sets (>40 keys) | PASS |
| `view: 'summary'` renders nothing; `view: 'page'` renders the shell | PASS |
| The four views render real payloads (counts, shares, checks, history cap, scope labels, truncated notice) | PASS |
| Real Desktop UI acceptance (packaged install, theme switch, disable/uninstall, locale switch) | **NOT RUN** |

### 4.3 Why the Desktop UI acceptance is NOT RUN, and how to run it

No isolated Desktop profile was installed for this work, and the production desktop profile was
deliberately left untouched (plan §42, AGENTS.md §6). The structural evidence above cannot
substitute for a packaged run. Minimal manual steps:

1. `dsh plugin --profile <throwaway> add link:<repo>` (or install the packed tarball) with an isolated `DSH_HOME`.
2. Open **Plugins** → BaseMind row → **Configure**: the Dashboard opens, first tab Overview, project selector shows the DSH workspaces, English and Chinese copy follow the UI language, theme switches with DSH.
3. Confirm the four tabs and that no Files module exists; run a full scan once (confirmation names the path); watch the state change; reopen and see the history row.
4. Disable the bundle: the Configure control and the page disappear; re-enable: they return.
5. Headless check: start a session without the Web GUI and confirm tools/skills/status still work and no Dashboard route is registered.

## 5. Test results

All commands run from the repository root on Windows x64.

| # | Command | Result |
| --- | --- | --- |
| 1 | `node --test test/dashboard-contracts.test.mjs test/dashboard-history.test.mjs` | 17 pass |
| 2 | `node --test test/dashboard-service.test.mjs test/dashboard-contracts.test.mjs` | 28 pass (service 16 + contracts 12) |
| 3 | `node --test test/dashboard-routes.test.mjs` | 13 pass |
| 4 | `node --test test/dashboard-workspaces.test.mjs` | 4 pass |
| 5 | `node --test test/dashboard-client.test.mjs` | 9 pass |
| 6 | `npm run check` | syntax ok: 27 files; bundle manifest ok |
| 7 | `npm run check:pack` | pack contents ok: 59 files |
| 8 | `npm test` (part of `npm run verify`) | **522 tests / 502 pass / 0 fail / 20 skipped** (after the independent-review and scoped-re-review fixes) |
| 9 | `npm run verify` | PASS (check + check:pack + test) |
| 10 | `BASEMIND_DASHBOARD_INTEGRATION=1 BASEMIND_DASHBOARD_DATA_HOME=<warm isolated home> node --test test/integration-dashboard.test.mjs` | **1 pass, 7.0 s** against the real 0.34.0 binary |
| 11 | `npm run check:skills` | not run separately (no skill files touched; `npm run verify` does not include it) |
| 12 | Remote CI / release gate | **NOT RUN** (no push, per plan §52) |

The 20 skips are the existing gated real-binary suites plus the new Dashboard gate, which needs
`BASEMIND_DASHBOARD_INTEGRATION=1` and a warm isolated data home because a cold one downloads
the 22 MB grammar bundle. The real gate was executed once here (row 10) and passed.

## 6. Performance

| Scenario | Evidence | Result |
| --- | --- | --- |
| P1 Dashboard never opened | `registerDashboard()` only reads a service and registers six routes; a unit test asserts registration itself invokes no query; no timer exists anywhere in `lib/dashboard` | PASS: 0 CLI calls, 0 timers, 0 relays, 0 daemons, tool schema/skills/bootstrap untouched |
| P2 Dashboard open and idle | Overview caches 5 s; no interval unless a submitted scan is active; no other workspace is queried | PASS |
| P3 Tab switching | each tab has its own effect with an `AbortController`; Overview cache prevents repeat queries within 5 s | PASS |
| P4 Fast workspace switching | aborted controller per view; results of a switched-away workspace are dropped by the abort check | PASS (unit-level) |
| P5 Agent under load | reads are serialised Host-wide (one child, queue ≤ 4), identical requests coalesce; no Agent path modified | PASS by design; no latency benchmark was run (NOT RUN) |
| P6 During a scan | one scan per machine, progress not simulated, polling only while the tab is open, stops on completion | PASS |
| P7 Open/close cycles | every effect returns cleanup; no module-level timer or listener; route disposers owned by the plugin effect | PASS by inspection and unit tests; no 20-cycle Desktop measurement (NOT RUN) |

No model tokens are consumed by any of this; every number on the page comes from BaseMind or the
Host's own job records.

## 7. Package size

| | Files | Tarball | Unpacked |
| --- | --- | --- | --- |
| Before (baseline) | 52 | not recorded | ~509 KB |
| After | 59 | 180,995 B | 616,482 B (+107,229 B: the seven Dashboard modules) |

`npm pack --dry-run` + `scripts/check-pack.mjs` confirm node_modules, tests, docs, scripts,
fixtures, binaries and pack.json stay out; the seven Dashboard modules are now required.

## 8. Automatic repair log (Phase J)

| # | Finding | Severity | Root cause | Fix | Regression test |
| --- | --- | --- | --- | --- | --- |
| 1 | A refused read (`429 busy`) called `release()` although it never acquired the slot, so it could start a queued read alongside the running one | **Critical** (the one-at-a-time guarantee) | `await acquire()` sat inside the `try/finally` that always released | Acquire before the `try` | "only one read runs at a time…" now tracks peak concurrency and asserts 1 |
| 2 | `scanState` could return a completed job with an empty history because the history write raced the state change | **Important** (UI shows a finished scan with no row) | `state = 'completed'` happened before `history.record` settled | Job exposes `recording`, and `scanState` awaits it | Real gate asserts history length immediately after completion |
| 3 | Two workspaces could scan concurrently while the daemon and machine-global cache are shared | **Important** (plan §27 conservative rule) | Only per-workspace de-duplication | Machine-wide scan serialisation, message names the running workspace | "a scan of another workspace is refused while one runs" |
| 4 | A queued read could hang forever after plugin disposal | **Important** (leak on unload) | Queue waiters were not settled | `dispose()` rejects every waiter with `disposed` | "dispose rejects every queued read so nothing hangs" |
| 5 | Incremental scope had no upper bound | Minor→Important (argv size) | none | `MAX_SCOPE_PATHS = 256` | contracts test |

## 9. Known limitations and unimplemented fields

- **Scan progress, percentage, cancel**: BaseMind 0.34.0 has no API; the page shows state, elapsed and the operation's own summary and says so.
- **Last scan timestamp / index freshness from BaseMind**: not exposed; Overview shows only Dashboard-submitted scans, labelled, with `lastScanFromBaseMind: false`.
- **"Follow the current session"**: a Host-only plugin has no reliable current-session resolver; the DSH Workspace registry supplies the list, the first entry is selected, and the payload declares `followCurrentSession: false` (plan §11 PARTIAL).
- **Per-project telemetry / disk**: BaseMind reports machine-global figures; the page labels them and does not present them as project-only.
- **Daemon/relay internals**: Diagnostics shows the relay count this plugin owns, not daemon process memory.
- **Diagnostics and Statistics are not cached**: they are explicit actions, so each tab open runs its queries (0.4–1.4 s).
- **Activation order**: route registration needs `webServer` at `apply` or at the Cordis `ready` event; if neither has it, the Dashboard is absent with a debug log and everything else works.
- **Dashboard UI on a real Desktop**: NOT RUN here (see §4.3).
- **Localisation**: the page's own copy is bilingual; the rest of the Host UI keeps its own locale behaviour.

## 10. Final acceptance checklist (plan §50)

Only items with evidence are PASS; the rest are labelled.

### UI

| Item | Verdict |
| --- | --- |
| Plugins-page entry | **PARTIAL** — registration and key match are unit-verified; the rendered control was not seen on a real Desktop |
| Independent page | **PARTIAL** — same reason; contract verified against the installed slot contract |
| Workspace selector | **PARTIAL** — host route returns registry items; UI render tested inline |
| Four pages render | **PARTIAL** — each view rendered against real payload shapes in a module-loader sandbox |
| No Files module | **PASS** (does not exist in code or routes) |
| Native theme / locale | **PARTIAL** — uses `--dsw-*` tokens, theme switch not exercised |
| Disappears on disable/uninstall | **PARTIAL** — owned by the plugin effect; not exercised on a Desktop |

### Data

| Item | Verdict |
| --- | --- |
| Official real data | **PASS** (measured contracts; real gate) |
| No invented fields | **PASS** (unknown → null → "not available") |
| Unknown is not 0 | **PASS** (unit tests) |
| Scope labels | **PASS** (unit + view tests) |
| No private index format read | **PASS** (CLI only) |
| No per-file traversal for statistics | **PASS** (aggregates only) |

### Scan

| Item | Verdict |
| --- | --- |
| First scan is user-submitted | **PASS** (no automatic scan; confirm-first UI) |
| Full scan | **PASS** (real gate) |
| Incremental scan | **PASS** (real gate) |
| Scope validation | **PASS** (unit + real gate refuses `../`) |
| No duplicate scan of the same write scope | **PASS** (409 machine-wide) |
| Real progress/state | **PARTIAL** — state and elapsed real; progress unsupported by upstream |
| Closing the Dashboard does not cancel | **PASS by design** — client disconnect cancels reads only; scan runs on the Host |
| Last 10 summaries | **PASS** (unit + real gate) |

### Performance

| Item | Verdict |
| --- | --- |
| Zero model tokens | **PASS** |
| Zero queries while closed | **PASS** (registration test + code inspection) |
| Zero polling while closed | **PASS** |
| No new Agent tools / skills / bootstrap change | **PASS** |
| No resident daemon / UI relay | **PASS** |
| Passive view does not index | **PASS** (status does not build an index; real gate asserts not-indexed before the scan) |
| No obvious repeatable Agent regression | **NOT RUN** — no 30-sample latency benchmark |
| No timer/listener/process leak | **PASS by inspection + dispose tests**; 20-cycle Desktop run NOT RUN |

### Compatibility

| Item | Verdict |
| --- | --- |
| Existing plugin regression | **PASS** (`npm test`, 502 pass) |
| Headless | **PASS by design** (webServer optional, no required injection) — no headless runtime run in this environment (**NOT RUN** for a live headless session) |
| Safe degradation without UI API | **PASS** (unit test: registration without a web server is a no-op) |
| Manifest / skills / pack checks | **PASS** (check, check:pack; check:skills not separately needed — no skill file changed) |
| Full regression gate | **PASS** (`npm run verify`) |

## 11. Post-review fixes (2026-11-25)

An independent review then found 2 Critical / 2 Important / 8 Minor findings. All were verified
against the installed runtime and fixed, with regression tests that fail on the pre-fix code:

- **C1** — GET and POST `/scan` registered two exact routes with one path; the real Web server
  keys exact routes by path and threw, so only five routes existed, POST fell to 405, and the
  service was never disposed. Fixed to one method-dispatching route plus all-or-nothing
  registration rollback.
- **C2** — the four views were invoked as plain functions; ScanView's hooks then extended the
  page's hook chain, so opening the Scan tab threw React's hook-order error. Fixed with a
  `TabBody` element boundary.
- **I1** — incremental scope entries starting with `-` reached BaseMind's argv as flags
  (`--rebuild-git-history`). Refused at validation.
- **I2** — the webServer retry used a Cordis event that does not exist. Replaced with the
  host's own `ctx.inject(['webServer'], …)` pattern.
- Minors M1–M7 fixed (scope cap, dispose abort merge, invalidation epoch, non-overlapping poll,
  null-safe labels, diagnostics health fallback, config tests); M8 deferred with its reason.
- A scoped re-review then found I1 still open through `./` prefixes (the checks ran before the
  path was normalised) and one unlocalised label; the re-review's "0 renders as a dash" claim did
  not reproduce (`count(0)` is the truthy string "0"). Both real items are fixed and pinned by
  tests; see the fix report §8.

Full evidence: [review fix report](./2026-11-25-basemind-dashboard-review-fix-report.md).

## 12. Manual follow-up owned by the user

1. Review the diff and commit (no commit was created).
2. Run the Desktop UI acceptance steps in §4.3 on a throwaway profile.
3. Optionally record a 30-sample P5 latency benchmark; the current report marks it NOT RUN.
