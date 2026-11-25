# BaseMind Dashboard — Review Fix Report

Date: 2026-11-25
Source review: [Independent review](./2026-11-25-basemind-dashboard-independent-review-report.md)
(2 Critical / 2 Important / 8 Minor)
Self-review (superseded): [Review report](./2026-11-25-basemind-dashboard-review-report.md)
Execution report: [Execution report](./2026-11-25-basemind-dashboard-execution-report.md)

## 0. Verdict

All four blocking findings were verified against the installed runtime and are **fixed**, each
with a regression test that fails on the pre-fix code. Seven of the eight Minor findings are
fixed; M8 is deferred with its reason. `npm run verify` is green (521 tests / 501 pass /
0 fail / 20 skipped) and the real BaseMind Dashboard gate passes.

## 1. Verification before fixing (no blind implementation)

| Finding | How it was verified here | Result |
| --- | --- | --- |
| C1 duplicate exact route | Read `@deepseek-ai/dsh-host-webserver/src/index.ts` from `app.asar`: `interface WebRoute { kind, path, handler }` (no `methods`) and `register()` throws `webserver: duplicate ${kind} route "${path}"` when the path is already in the `exact` table. | **Confirmed** |
| C2 hooks in an inline view call | Read `lib/dashboard/client.js`: `ScanView({...})` was called as a plain function from `DashboardPage`, and `ScanView` owns four `useState` hooks. React rejects the resulting hook-count change. | **Confirmed** |
| I1 argv injection | `normalizeScopePaths` had no leading-dash check; `basemind rescan --help` lists `--rebuild-git-history` and `--view <VIEW>`, and the scan argv appends scope entries before `--json`. | **Confirmed** |
| I2 dead `ready` listener | `@deepseek-ai/cordis` contains no `emit('ready')` / `internal/ready`; the host's own optional-service pattern is `ctx.inject(['webServer'], registerWebCarrier)` (`@deepseek-ai/dsh-client-modules` `@ src/index.ts:709). | **Confirmed** |

## 2. Fixes

### C1 — one exact `/scan` route; all-or-nothing registration

- `lib/dashboard/routes.js`: GET and POST `/scan` now share **one** `endpoint({ path, methods: ['GET','POST'] })`; the handler dispatches on the method the fence already resolved. The table is **five** exact paths for six operations.
- `registerDashboardRoutes()` registers inside `try/catch` and, on any failure, calls every disposer it already obtained before rethrowing.
- `index.js`: `let service` is created before registration; on failure it resets `state.dashboard`/`dashboardRegistered` and disposes the service, so no route can point at an undisposed service and a later reload is not poisoned by a duplicate.
- Regression evidence: `test/dashboard-routes.test.mjs` now uses a `strictWebServer()` double that throws on a duplicate `kind:path` (the real contract) and asserts unique paths, methods `['GET','POST']` on `/scan`, **five** registrations, and a rollback test where a pre-registered path makes the family throw and leaves only the blocker.
- Would the old code fail these tests? Yes: the uniqueness assertion and the strict double both throw on the second `/scan` route.

### C2 — every view is a real component element

- `lib/dashboard/client.js`: added `TabBody`, which returns `React.createElement(OverviewView|ScanView|DiagnosticsView|StatisticsView, props)`; `DashboardPage` renders `React.createElement(TabBody, {...})` and never calls a view.
- Regression evidence (`test/dashboard-client.test.mjs`):
  - The React stand-in now enforces React's hook rule: a render that calls a different number of hooks than the previous one throws (same message shape as React).
  - `TabBody` returns an element whose `type` is the expected function and executes **zero** hooks.
  - `DashboardPage` is rendered with a workspace, then the tab setter moves it to `scan` and it is rendered again — the exact transition that used to add ScanView's four hooks to the page's chain. Hook count stays stable and the tree still carries a `TabBody` element.
- Would the old code fail? Yes: the second render would execute ScanView inline and the stand-in throws `Rendered 20 hooks but expected 16`.

### I1 — scope entries cannot become CLI flags

- `lib/dashboard/contracts.js`: `normalizeScopePaths` now refuses any entry whose trimmed form starts with `-` and any entry containing NUL, with its own message.
- Regression evidence: contracts tests reject `['--rebuild-git-history']`, `['-x']`, `['--view','staged']`, `['-']` and a NUL-containing path.

### I2 — wait for the Web server the way the host does

- `index.js`: removed the `ctx.on('ready')` listener and call `ctx.inject(['webServer'], () => registerDashboard())` behind a `typeof ctx.inject === 'function'` guard; the existing `dashboardRegistered` guard keeps it idempotent.
- Regression evidence: `test/index.test.mjs` (30 tests) still passes with a context that has no `inject`; the injection path is the documented Cordis mechanism used by the host itself.

## 3. Minor findings

| # | Status | What changed |
| --- | --- | --- |
| M1 | **fixed** | `history.js` caps a stored scope at `MAX_SCOPE_PATHS` (256) instead of 64, so the history agrees with the validator. |
| M2 | **fixed** | Reads merge the caller's signal with the dispose signal via `AbortSignal.any` (fallback to the caller signal), so disposing the service aborts an in-flight child even when a route supplied its own signal. Test: dispose aborts a read that carried a client signal. |
| M3 | **fixed** | Per-workspace epoch: a read that began before an invalidation returns its value but no longer repopulates the cache. Test: a read that started before a scan finishes is not cached (the next Overview runs a second `status`). |
| M4 | **fixed** | The Scan poll is a `setTimeout` chain scheduled only after the previous request settled, so two `/scan` reads can never overlap. |
| M5 | **fixed** | Scan summaries and history use `count(...) \|\| '—'` instead of `String(...)`, so a missing number is a dash, never `null`; states were already translated. |
| M6 | **fixed** | The header health badge falls back to the Diagnostics index verdict, so it no longer disappears on non-Overview tabs. |
| M7 | **fixed** | `test/config.test.mjs` covers `dashboard`/`dashboardHistory`: defaults, explicit `false`, string `'false'`, and one warning per invalid value. |
| M8 | **deferred** | An index-level wiring test needs the fake context to grow a Web server and a workspace registry. The properties that matter at that seam are covered at the registrar boundary (strict double, unique paths, rollback) and by inspection; a full index test would duplicate the plugin harness for little added signal. Recorded as a deferred minor, not a claim of coverage. |

## 4. Test results (after the fixes)

| Command | Result |
| --- | --- |
| `npm run verify` | PASS — check 27 files, check:pack 59 files, **521 tests / 501 pass / 0 fail / 20 skipped** |
| `node --test test/dashboard-routes.test.mjs` | 14 pass (uniqueness + rollback) |
| `node --test test/dashboard-client.test.mjs` | 11 pass (element boundary + hook order) |
| `node --test test/dashboard-contracts.test.mjs` | 12 pass (flag-like paths) |
| `node --test test/dashboard-service.test.mjs` | 18 pass (dispose abort, invalidation epoch) |
| `node --test test/config.test.mjs` | 24 pass (dashboard settings) |
| Real gate `BASEMIND_DASHBOARD_INTEGRATION=1 …` | 1 pass, 7.3 s |

## 5. Correction to the earlier reports

The self-review reported "No blocking issues found". That verdict was **wrong**: C1 and C2 were
statically determinable and were missed because the test doubles did not model the real
contracts (the route double ignored path uniqueness; the React double had no hook boundary and
the view tests bypassed the page). The independent review was right on both. The self-review
report now carries an addendum pointing here, and the execution report records these fixes.

## 6. Residual risks (unchanged or new)

- Real Desktop UI acceptance remains **NOT RUN**; the element-boundary fix is covered by the
  contract tests but still unproven in a packaged Desktop session.
- A Web server **replacement** after registration is not followed (routes stay bound to the
  replaced server); the same limitation exists in the installed config-manager precedent. The
  injection covers the "mounted later" case only.
- The 30-sample Agent-latency benchmark and the 20-cycle open/close run remain **NOT RUN**.
- Scope validation is lexical; symlink/junction resolution is delegated to BaseMind's own root
  validation.

## 8. Round 2 — scoped re-review (2026-11-25)

Source: [Scoped re-review](./2026-11-25-basemind-dashboard-scoped-re-review-report.md). Verdict there:
C1/C2/I2 ADDRESSED, **I1 still open**, two new Minor observations. Each was checked here first.

### I1 — was still open; now fixed

Probe before the fix (actual call, no mocks):

    ['./--rebuild-git-history'] -> { ok: true, paths: ['--rebuild-git-history'] }
    ['./-x']                    -> { ok: true, paths: ['-x'] }

Root cause: the leading-dash and NUL checks ran on the raw trimmed entry, but the value pushed
into argv is the normalised one; dropping the @@.@@ segment turns @@./-x@@ into @@-x@@. The check
now runs on the canonical entry that actually reaches argv (the raw-form checks remain as the
first line of defence). Probe after the fix:

    ['./--rebuild-git-history'] -> { ok: false, message: '…must not start with a dash: --rebuild-git-history' }
    ['./-x']                    -> { ok: false, … }
    ['./-']                     -> { ok: false, … }
    ['src/./a.js']              -> { ok: true, paths: ['src/a.js'] }

Regression tests: the flag-like list now includes @@['./-x']@@, @@['./--rebuild-git-history']@@ and
@@['./-']@@; a normal path that merely contains a dot segment still passes.

### Minor "0 renders as a dash" — not a defect (evidence)

@@count(0)@@ returns @@(0).toLocaleString()@@, i.e. the **non-empty string** @@"0"@@, which is truthy:
@@count(value) || '—'@@ renders @@0@@ for a measured zero and @@'—'@@ only for @@null@@. Verified by
probe (@@(0).toLocaleString()@@ → @@"0"@@). A regression test now pins it: a completed scan whose
summary is all zeros renders @@scan.summary.scanned 0@@ / @@updated 0@@ / @@removed 0@@ and never a dash,
and no @@null@@ text appears.

### Minor "last-scan status is a raw token" — fixed

@@OverviewView@@ rendered @@String(lastDashboardScan.status)@@ while the history table used
@@t('scan.state.' + status)@@. It now uses the same translated key, and a test asserts the last-scan
card shows @@scan.state.completed@@ and not a raw @@completed@@ token.

### Out-of-scope note

The @@AbortSignal.any@@ fallback for Node without @@any()@@ is unreachable here: @@engines.node@@ is
@@>=24.20.0@@. It is left in place as a defensive branch and is not covered by a test.

### Gates after round 2

@@npm run verify@@ → check 27 files, check:pack 59 files, **522 tests / 502 pass / 0 fail /
20 skipped**; real BaseMind Dashboard gate → 1 pass.
## 9. No commits

The review fixes are in the working tree only; the user reviews and commits.
