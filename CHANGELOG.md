# Changelog

All notable changes to `dsh-basemind-plugin` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A real managed-binary integration suite with its own gate.** `test/integration-managed.test.mjs` lets the plugin's own Binary Manager download the pinned release over the real network, verify the published SHA256, extract the complete tree, install it into a throwaway `DSH_HOME`, and then drive the real MCP relay (initialize, tools, resources, index_status, code_outline/code_symbols/code_read/code_refs/code_grep, git_log, structuredContent) and the real CLI adapter (status, doctor, overview, `code explain`) from that same binary. `BASEMIND_REQUIRE_MANAGED_INTEGRATION=1` makes every failure fatal; without it the suite skips so `npm test` never downloads 75–102 MB. It runs with `DSH_HOME`, `BASEMIND_DATA_HOME`, `BASEMIND_COMMS_DIR`, `BASEMIND_BIN` and `PATH` isolated, and asserts that no `basemind` is resolvable, so a global install can neither stand in for the download nor rescue an incomplete tree.
- **`.github/workflows/managed-binary.yml`.** Cold-cache managed installs on Windows x64, Linux x64 and macOS arm64, with Linux arm64 as a real opt-in (`include_linux_arm64`, default false, declared for both `workflow_dispatch` and `workflow_call`): a `plan` job builds the matrix because `jobs.<id>.if` cannot read the `matrix` context. Each runner's `uname -m` and Node platform/arch are compared verbatim with the matrix entry and with the release target resolved from `lib/upstream.js` instead of trusting the runner label. No `actions/cache`, no pre-unpacked binary, `BASEMIND_BIN` never set, one job-level diagnostics directory, and a failure artifact containing only the small diagnostics JSON and the test summary. `release.yml` now calls it as a `managed-gate` job that the release job `needs`, so a release cannot be published from a commit without that evidence.
- **`test/workflows.test.mjs`** statically guards the CI contract without any dependency: no job-level `if` on `matrix`, the managed matrix built by the plan job with arm64 only under the opt-in guard, verbatim `uname` architecture values, no `continue-on-error`/`|| true`/`actions/cache`, no hardcoded BaseMind version or tag, `ci.yml` still invoking `npm test`, and the release gate wired to the managed workflow.
- **`.github/workflows/ci.yml` writes a test summary artifact on failure**, and `.github/workflows/compat.yml` gained a weekly schedule plus an explicit scope statement. Linux arm64 is deliberately not scheduled there: an unschedulable runner label queues indefinitely, so arm64 evidence comes from the managed workflow's opt-in input after a maintainer confirms the label.
- **A DSH Desktop acceptance checklist** (`docs/2026-11-24-basemind-desktop-acceptance-checklist.md`) with executable steps, agent prompts, expected results, PASS/FAIL/NOT RUN rules and rollback, for the parts that need a real GUI session.

- **A reproducible A/B effectiveness benchmark (`benchmark/`).** Frozen task prompts and ground truth, a Web API harness that runs one new session per run and records usage, tool sequence, schema/catalog bytes and duration, a rule-based scorer that hides the group label, and a synthetic staged repository for the review task. It is development tooling: it is not in the npm `files` whitelist and its results never enter the repository. Phase 3 Pilot (12 runs) and full (22 runs) results, including the deviations (no B2 GPT pair, several runs over the 400k per-run budget), are in `docs/2026-11-25-basemind-benchmark-report.md`.

### Fixed

- **A new session's first turn no longer races the BaseMind relay.** `agent/created` was handled as fire-and-forget, so the host released queued work (the first prompt) while the MCP handshake was still running: turn 1 was assembled with 34 tools, zero `mcp__basemind__*` names, no bootstrap section and a skills catalog without the vendored BaseMind skills, and only turn 2 saw them. The listener now returns the initialization promise the host awaits before releasing queued work (the documented `agent/created` contract), bounded by the new `coldStartTimeoutMs` (default 15000 ms; `0` disables the wait). A timeout, a failed attempt or an aborted creation logs one diagnostic and lets the turn continue exactly as before. Only the first attempt for a given discovery root gates, so `agent-first` still waits for the Agent's own root after the deployment default directory failed; a second Agent created during the handshake waits for the same relay instead of starting another; and a working directory that settles after the budget is still adopted in the background instead of forfeiting the session's tools. The first-ever `binaryDownload` install is **not** covered by that budget — the download alone measured 13.5–55.7 s — so the very first session after a fresh install can still run its first turn without the tools and get them once the background install finishes; later sessions reuse the warm cache and wait only for the handshake.
- **`/basemind-status` could report a cache as valid that the next start would re-download.** The cache snapshot used its own completeness rule, which did not require the recorded `binarySha256`, while the selection does. Both now share one stat-only predicate, so `` `cache` `` facts and the selection can never disagree about what a complete layout-2 install is.
- **An interrupted-swap backup could be deleted before the surviving cache was validated.** `recoverParkedTrees()` removed every other `.old-*` tree as soon as it restored the newest one (and removed all of them whenever the target existed), without checking that the surviving tree was complete — so two crash windows could replace the only intact cache with a re-download. Parked trees are now removed only once the target is a complete layout-2 install; otherwise they are kept as the backup and the next selection or successful install reclaims them.
- **The managed binary install was critically incomplete on every platform.** `installPinned()` extracted only the main executable, so the Windows `basemind.exe` could not load its statically imported `heif.dll` (`STATUS_DLL_NOT_FOUND`, `0xC0000135`; `heif.dll` itself needs `libde265.dll`), and the Linux/macOS binaries could not load their `lib/libheif.so*` / `lib/libheif.1.dylib` dependencies. The licence files and `THIRD_PARTY_LICENSES` were dropped as well, so a re-distributed tree lacked the notices the upstream `ATTRIBUTIONS.md` requires. The installer now extracts the complete release tree with pure Node (main binary, bundled `lib/` libraries, Windows root DLLs, `licenses/**`, `LICENSE`, `ATTRIBUTIONS.md`, `THIRD_PARTY_LICENSES`), verifies the main binary is a regular file at the archive root, applies POSIX modes, probes it, records the installed file list in `install.json` (layout 2: `binary`, `size`, `mtimeMs`, `files[]`) and only then swaps the directory into place atomically. Existing protections are kept (absolute/drive/UNC/`..` names, duplicates, links/devices, encrypted zip, zip64, entry-count and size limits, header checksums, declared-size checks) and every destination path is additionally resolved inside the staging directory.
- **CI test harness:** `test/index.test.mjs` no longer copies `fixtures/fake-basemind.sh` into `os.tmpdir()`. The script resolves its sibling `fake-mcp-server.mjs` / `fake-basemind-cli.mjs` from `$BASH_SOURCE`, so the copy answered `--version` but died with `MODULE_NOT_FOUND` on `serve`, which made three Ubuntu-only tests time out (three × 15 s). It runs in place from its git mode `100755`, and a POSIX preflight assertion now fails in milliseconds with an actionable message if the exec bit is ever lost.

### Changed

- **The managed cache moved to layout 2 and a layout-1 cache is re-downloaded once.** A cache hit now requires the recorded tree (binary plus bundled libraries and licence files) to exist with the recorded sizes and the main binary to pass the version probe: the file list is checked with `stat` only, and the binary is re-hashed — against its own `binarySha256`, never against the archive digest — only when its size or mtime differs from the record. A layout-1 cache (a single binary plus the old install record, or no record) is treated as incomplete and replaced atomically on the next start when `binaryDownload: true`; it is never patched in place, so upgrading costs one 75–102 MB download and about 230–320 MB of disk per platform. `binaryDownload: false`, `command`, `BASEMIND_BIN` and a complete official install on `PATH` remain the supported offline paths; a hand-placed single binary in the cache is no longer adopted.
- `/basemind-status` reports the managed cache layout, the recorded file count, whether the main binary is present and the first missing file when the tree is incomplete, within the existing width and redaction rules.

- **An interrupted cache swap no longer loses the cache or leaks a tree.** If the process stopped between parking the previous tree as `.old-<platform>-*` and moving the new one in, the next selection restores the parked tree before reading the cache (no download, works with `binaryDownload: false`) and removes superseded leftovers; a failed restore now logs the parked path at warning level instead of staying silent.
- **The managed cache's completeness rule is now one shared predicate.** `lib/binary/manager.js` gained one internal `managedCacheComplete()` (layout 2, main binary present, every recorded file at its recorded size) used by `/basemind-status` and the parked-tree cleanup; the selection keeps its equivalent async stat gate plus the probe, version and digest checks, so `valid` means "stat-complete before the probe".

## [0.2.0] - 2026-11-24

### Added

- **Official BaseMind skills.** The ten upstream skills (`basemind`, `basemind-cli`, `basemind-code-search`, `basemind-comms`, `basemind-doctor`, `basemind-documents`, `basemind-git-history`, `basemind-multi-agent-room`, `basemind-scan`, `basemind-stats`) ship inside the package and register through `ctx.skills.registerProvider()` at rank 1000, so a user's or project's own copy always wins, the catalog only carries name and description, and the body loads on demand. `scripts/sync-basemind-skills.mjs` regenerates them from a pinned tag; DSH-specific edits live in `skills/.dsh-adapt.json` and every rule must match exactly.
- **A managed, local-first binary manager.** `lib/binary/*` resolves `command` / `BASEMIND_BIN` / `PATH` / the managed cache / the official GitHub release for the pinned version, verifies the published SHA256, unpacks with pure Node (tar.gz and zip, single expected entry, traversal and link entries rejected), installs atomically under `$DSH_HOME/cache/dsh-basemind-plugin/managed-binaries/`, and shares one download across sessions and processes.
- **`lib/upstream.js`** is the single source of truth for the pinned BaseMind version, tag, commit, asset table, checksum file and skill list; CI, release and the compatibility workflow read it instead of hardcoding a version.
- **A bootstrap prompt section** (`lib/prompt/bootstrap.js`) that covers only what BaseMind's own MCP instructions do not: the CLI-only verbs, the fallback to native tools, and workspace semantics. It is empty until a verified binary is ready and contains no timestamp or workspace path.
- **`mcp__basemind__cli`**, an argv-only read-only CLI adapter (`lib/cli-tool.js`) that runs the same verified binary as the MCP relay, with a verb allowlist, a denylist that wins, no shell, no `cwd`/`env`/stdin input, and bounded output.
- **`/basemind-status`**, a human command (`lib/status.js`) that reports whether a BaseMind binary is present, its version, whether it matches, the source, the cache state and what to do next. It does not consume model tokens and does not claim to be a settings page.
- **Six settings** with validated defaults: `binaryDownload` (true), `binaryPolicy` (`exact`), `binaryFallback` (true), `skills` (true), `bootstrap` (true), `cliTool` (true).
- The result envelope now carries MCP `structuredContent` when BaseMind sends one (`{ text, content, isError, structuredContent? }`), so the machine-readable form of a result survives the bridge. BaseMind 0.34.0 sends it for every tool and answers `code_outline`, `code_grep`, `find_files` and `git_diff` with line-oriented text or TOON instead of JSON.
- BaseMind 0.34.0 contract fixtures (`fixtures/basemind-0.34.0-tools.json`, `fixtures/basemind-0.34.0-instructions.txt`) captured from an isolated real binary, plus schema tests that assert the 15 verb tools, the 3 agent tools, the absence of every retired name and lossless normalization of all 18 input schemas.
- `test/integration-legacy.test.mjs`: a version-agnostic smoke test for older binaries (selected with `BASEMIND_BIN`) that asserts only the handshake, dynamic discovery, one safe read and per-root routing.
- `BASEMIND_BIN` and `BASEMIND_REQUIRE_INTEGRATION=1` in both integration suites; with the flag set, a missing binary or an unavailable integration run fails instead of skipping.

### Changed

- **The plugin now downloads a managed binary by default when no local compatible BaseMind exists.** `binaryDownload: true` is declared explicitly in `cordis.patch.yml`, writes only to the plugin-owned cache under `$DSH_HOME/cache/dsh-basemind-plugin/`, never touches the BaseMind data home or the project, never runs an installer, and degrades to "no tools, diagnostic status" if it fails. Local hits and a valid cache hit still make **zero** network requests. Set `binaryDownload: false` to forbid the download entirely.
- A local BaseMind whose version does not match the pinned target (`exact` by default) is no longer used silently: it is reported, then the plugin continues through the remaining candidates. `binaryPolicy: 'minor' | 'any'` widens acceptance; `binaryFallback: false` stops at an incompatible explicit binary instead of falling through.
- `autoProvision` / `npxSpec` are now the last-resort legacy path and log one deprecation warning; `binaryDownload` covers the normal case with a pinned, checksum-verified version.
- Skills and the CLI adapter are gated on the same verified binary as the MCP tools, so a version mismatch never exposes text that teaches an unavailable verb; `binaryPolicy: 'any'` keeps the MCP bridge but disables both.
- The release and compatibility workflows resolve the BaseMind version from `lib/upstream.js` and CI additionally runs `npm run check:skills`.
- Verified against BaseMind **0.34.0** on Windows. 0.34.0 replaced the mode-dispatch tools with 15 verb tools plus 3 agent tools and removed `graph`, `web`, `shell`, `workspace` and the `agents` tool. Discovery and registration needed no change — the plugin still registers exactly what `tools/list` advertises — but the READMEs, their examples and the integration test were rewritten for the verb surface.
- A fixable failure now keeps its BaseMind code: an `isError` result whose `structuredContent` is `{ error, retryable }` appends `[error=<code>, retryable]` to the message, and a JSON-RPC failure appends `[jsonrpc=<code>]`.
- The READMEs record BaseMind `0.34.0` as the verified version, describe the 15 verb tools, the `basemind://outline/{path}` and `basemind://memory/{key}` resources (`basemind://repo/map` is gone), the repository-group scope of the index and memory stores, and the `comms stop` → `scan` → reopen-session upgrade path.
- The release workflow installs a pinned BaseMind 0.34.0 build and runs the real integration suites with `BASEMIND_REQUIRE_INTEGRATION=1`, so a release can no longer pass on a skipped integration run.
- The version-agnostic smoke test was run against the checksum-verified BaseMind **0.33.0** Windows release and passes, which exercises the `admin { mode: "status" }` fallback that 0.34.0 no longer needs. BaseMind 0.32.0 and every non-Windows run remain unverified.

### Fixed

- `test/integration.test.mjs` no longer pins the nine 0.29.3 tool names and the old `mode` calls (`admin { mode: status }`, `code { mode: files }`). It polls `index_status` until `indexing` clears before the read tools run, because a fresh `BASEMIND_DATA_HOME` starts with an empty index and `index_rescan {}` exceeds the tool timeout on a cold cache. It now also covers `code_read`, an unknown-argument error and a retired tool name.

## [0.1.6] - 2026-11-10

### Changed

- Verified against BaseMind **0.32.0** on Windows; no plugin change was required. The relay launches `basemind serve`, completes the MCP handshake (`2025-06-18`), registers the nine tools and both resources (`basemind://status`, `basemind://repo/map`) discovered at runtime, and resolves the workspace root from the session's working directory as before. BaseMind 0.32.0 raised its own Python floor to 3.11, upgraded dependencies (`rmcp` 3.9, `oxc_*` 0.157, `toml` 1.2, `crawlberg` 1.12.4, `tree-sitter-language-pack` 1.24) and bumped `RELEASE_MINOR` 31 → 32, so its next scan re-extracts every indexed file; the tool names, modes and resources the plugin consumes are unchanged.
- The compatibility table in both READMEs now records BaseMind 0.32.0 as the verified version.

## [0.1.5] - 2026-11-02

### Changed

- Verified against BaseMind **0.31.1** on Windows; no plugin change was required. The relay launches `basemind serve`, completes the MCP handshake, registers the nine tools and both resources (`basemind://status`, `basemind://repo/map`) discovered at runtime, and resolves the workspace root from the session's working directory as before. BaseMind 0.30.0–0.31.1 changed index, cache and storage internals only; the tool names, modes and resources the plugin consumes are unchanged.
- The compatibility table in both READMEs now records BaseMind 0.31.1 as the verified version.

### Added

- `CHANGELOG.md`, also included in the npm tarball.

## [0.1.4] - 2026-10-30

### Added

- One-command releases: `npm run release` / `release:minor` / `release:major` bump the version, tag it and push, and the `preversion` hook runs the full verification first.
- The GitHub Release body is generated from the tag range (commit list, npm link, compare link) instead of `--generate-notes`, and an existing Release is updated in place.

## [0.1.3] - 2026-10-30

### Fixed

- The release workflow's post-publish registry check is best effort: a registry edge that has not propagated yet no longer fails an otherwise successful `npm publish`.

## [0.1.2] - 2026-10-30

### Changed

- CI and release commands moved into npm scripts (`check`, `check:pack`, `verify`, `pack`, `test:watch`), with a dedicated `scripts/check-syntax.mjs` replacing the workflow's shell glob.
- Node.js requirement raised to `>= 24.20.0` and pinned with Volta.
- Package description and keywords updated to describe the bundle more accurately.

## [0.1.1] - 2026-10-30

### Added

- English and 繁體中文 READMEs, an MIT license and `.gitignore`.
- GitHub Actions CI (Ubuntu and Windows, Node 24.20.0) and a tag-driven release workflow: tests, bundle checks, `npm publish` with trusted publishing and provenance, then a GitHub Release with the tarball and `SHA256SUMS.txt`.
- Bundle manifest and tarball checks. DSH compatibility is now declared through `engines.dsh`, the field DSH actually reads.

## [0.1.0] - 2026-10-30

### Added

- Initial release: a workspace-aware BaseMind MCP bridge for DeepSeek Harness. One relay per workspace root, tools discovered from `tools/list`, BaseMind's server instructions exposed as a system-prompt section, its MCP resources re-exported as the `basemind` resource server, and a `cd` inside a session switching the active workspace without a restart.

[Unreleased]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.6...v0.2.0
[0.1.6]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zengjunlin2022/dsh-basemind-plugin/releases/tag/v0.1.0
