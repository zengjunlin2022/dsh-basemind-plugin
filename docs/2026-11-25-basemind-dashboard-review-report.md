# BaseMind Dashboard — Review Report (Phase J)

Date: 2026-11-25
Plan: [2026-11-25-lightweight-workspace-dashboard-implementation-plan.md](./2026-11-25-lightweight-workspace-dashboard-implementation-plan.md)
Execution report: [2026-11-25-basemind-dashboard-execution-report.md](./2026-11-25-basemind-dashboard-execution-report.md)

> **Addendum, 2026-11-25 (after the independent review).** This self-review's verdict is
> **superseded**. The [independent review](./2026-11-25-basemind-dashboard-independent-review-report.md)
> found two Critical defects — a duplicate exact route registration that made scans unreachable
> and left five routes undisposed, and a view invoked as a plain function so the Scan tab broke
> React's hook order — plus two Important ones (argv-shaped incremental scan paths, and a
> non-existent Cordis `ready` event used as the webServer retry). Naming this review "self-review
> by the author" was accurate; its "no blocking issues" conclusion was not. The root cause of the
> miss is recorded in the [fix report](./2026-11-25-basemind-dashboard-review-fix-report.md) §5:
> the route double ignored path uniqueness and the React double had no hook boundary.

## 0. Review type and limitation

This is a **self-review by the author**, performed as a separate pass after implementation.
No independent reviewer subagent was dispatched: plan §45 allows one only with explicit
authorization, and dispatching a paid model was not authorized for this run. A self-review
is weaker than a fresh-context review; the user decides whether it is sufficient before merge.

Scope reviewed: the complete working-tree diff against `0e94e3e` (modified `index.js`,
`lib/config.js`, `package.json`, `cordis.patch.yml`, `scripts/check-pack.mjs`,
`README.md`, `README.zh.md`, `CHANGELOG.md`; new `lib/dashboard/*` and `test/dashboard-*`,
`test/integration-dashboard.test.mjs`; new docs). No commit exists, so the review covers
staged, unstaged and untracked files together.

## 1. Method

Requirement → plan (§6–§8 scope, §16 API, §17 identity, §26–§32 scan, §37–§39 performance, §50
checklist) → actual diff → execution report → targeted re-reads of the risky paths (limiter,
scan lifecycle, dispose order, route fence, client effects) → the full gate re-run.

## 2. Findings and fixes

| # | Severity | Location | Trigger and evidence | Expected vs actual | Impact | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | **Critical** | `lib/dashboard/service.js` `read()` | A fifth concurrent distinct query hit the 4-request queue cap: `acquire()` rejected with `429`, and the surrounding `try/finally` still called `release()` | Expected: a refused request changes nothing. Actual: it released a slot it never held, so a queued read started while another was running | Breaks the one-at-a-time guarantee the Agent-priority design depends on; could double the Dashboard's process load | Moved `await acquire()` outside the `try/finally` (fixed). The regression test now records peak concurrency and asserts exactly 1 |
| F2 | **Important** | `lib/dashboard/service.js` `execute()/scanState()` | A scan finishes: `state='completed'` was set before `history.record()` settled; the real gate read `scanState` immediately and saw zero history rows | Expected: a finished job and its history row appear together. Actual: a window where the Scan page shows a completed job with no row | UI inconsistency on completion; the client polling stops at completion and would not retry | Job carries a `recording` promise that `scanState` awaits (fixed); the real gate asserts history immediately after completion |
| F3 | **Important** | `lib/dashboard/service.js` `startScan()` | Two different workspaces could scan at once while both share one BaseMind daemon and one machine-global cache | Plan §27: serialise when upstream write scopes cannot be proven independent. Actual: only per-workspace de-duplication | Two concurrent full scans could compete for CPU/RAM/IO and the daemon writer | Machine-wide serialisation with a message naming the running workspace (fixed); unit test added |
| F4 | **Important** | `lib/dashboard/service.js` `dispose()` | Plugin unload while reads are queued | Expected: every waiter settles. Actual: queued waiters hung until process exit | Leak on disable/reload | `dispose()` rejects every waiter with `disposed` (fixed); unit test added |
| F5 | Important (hardening) | `lib/dashboard/service.js` `overview()/scanState()` | A history file that exists but cannot be read (permissions, corrupt handle) propagated out of the loader | Expected: a broken history file degrades to "no history". Actual: Overview and Scan returned 500 | One unreadable cache file could take out the whole Overview | Reads wrapped with `.catch(() => [])` (fixed); unit test with a throwing history |
| F6 | Important (hardening) | `lib/dashboard/routes.js` `POST /scan` | Body without `workspace` and no query parameter reached `startScan(undefined)` and produced a 404 "unknown workspace" | Expected: 400 "workspace parameter is required" | Diagnostic quality only | Explicit 400 (fixed); route test added |
| F7 | Minor→Important | `lib/dashboard/contracts.js` `normalizeScopePaths` | An incremental scan naming thousands of paths | Expected: bounded argv. Actual: unbounded | Command-line length failure instead of a clear refusal | `MAX_SCOPE_PATHS = 256` (fixed); contracts test added |
| F8 | Minor | `lib/dashboard/client.js` `text()` | Dead third parameter | — | Readability | Removed (fixed) |

No other Critical or Important finding survived the pass.

## 3. Deliberate decisions (not findings)

- **Plugins row-configuration page instead of a Settings card** — plan §10 decision order B and §19 (no global entry). Verified against the installed slot contract.
- **Overview uses one `status` call** rather than adding `overview`: `overview` costs a second process and only adds per-language line counts, which the plan does not require (share is computed on `file_count`, plan §23).
- **No cache for Diagnostics and Statistics**: they are explicit actions (plan §34 allows a manual trigger); each tab open runs its queries once.
- **`followCurrentSession: false`**: a Host-only plugin cannot reliably name the current session's workspace; the plan's §11 fallback (current workspace first, list from the registry) is implemented and disclosed in the payload.
- **Unknown scan timestamp**: BaseMind exposes none; showing a fabricated "last scanned" would violate plan §22/§24, so Overview shows the last Dashboard-submitted scan and declares `lastScanFromBaseMind: false`.
- **Registration time**: `ctx.get('webServer')` at `apply()` plus one retry on `ready`. If a composition never exposes it, the page is absent with a debug log — the documented degradation (plan §43).

## 4. Scoped re-review of the fixes

| Fix | Re-read | Re-run |
| --- | --- | --- |
| F1 acquire/release | `read()` now acquires before the guarded section; `release()` remains the only decrement | `node --test test/dashboard-service.test.mjs` (29 pass, peak concurrency = 1) |
| F2 recording promise | `execute()` assigns `job.recording`; `scanState()` awaits it | real gate: history length 1 immediately after completion |
| F3 serialisation | one loop over all jobs before job creation | unit test: cross-workspace 409 naming `C:/repo` |
| F4 dispose queue | every waiter rejected before the controller aborts | unit test: 3 pending reads all reject, ≥2 with `disposed` |
| F5 history degrade | both call sites use `.catch(() => [])` | unit test with a throwing history |
| F6/F7 | route validation and scope cap | route + contracts tests |

## 5. Regression evidence

| Gate | Result |
| --- | --- |
| `npm run check` | syntax ok: 27 files; bundle manifest ok |
| `npm run check:pack` | pack contents ok: 59 files |
| `npm test` | 515 tests / 495 pass / 0 fail / 20 skipped |
| `npm run verify` | PASS |
| Dashboard real gate | 1 pass (7.0 s) with the warm isolated data home |
| `npm run check:skills` | not needed (no vendored skill file changed) |

After the fixes above, the new and the pre-existing suites are green; existing tests were not
modified except where a new assertion strengthened them.

## 6. Residual risks (unverified, not findings)

1. **Real Desktop rendering (NOT RUN).** The bundle is verified structurally (loader format, slot key, dictionaries, view rendering in a sandbox) but has not been seen inside a packaged Desktop session. Layout details (page scroll container, narrow width) and the theme switch are unproven.
2. **Web-server availability at activation.** If neither `apply()` nor `ready` sees `webServer`, the routes are never registered. Nothing else breaks, but the page would be missing until the plugin reloads.
3. **Agent-latency benchmark (NOT RUN).** Plan §38 P5 asks for 30 interleaved samples; none were taken. The serialisation design bounds concurrency, but a regression under real Agent load is unmeasured.
4. **Lifecycle loop (NOT RUN).** The 20 open/close cycles of plan §38 P7 were not exercised on a Desktop; only the dispose unit tests cover the cleanup path.
5. **`dsh.client.inject` supplier names.** The declaration names `@deepseek-ai/dsh-client-locale` and `@deepseek-ai/dsh-client-ui-plugin-manager`, the same pattern the installed plugin-manager and config-manager use. If a future host renames the Provider Row, the browser half would not load; the Host half would be unaffected.
6. **History file lifecycle.** Corrupt or foreign content is ignored and eventually overwritten; there is no migration path from a future schema (version 1 only).

## 7. Verdict

**No blocking issues found** within the reviewed scope and the evidence produced here.

This verdict does not mean every platform or surface was exercised: the Desktop UI acceptance
and the Agent-latency benchmark are explicitly **NOT RUN**, and a self-review by the author is
weaker than an independent one. Nothing was committed; the user reviews the diff and decides.
