# Changelog

All notable changes to `dsh-basemind-plugin` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-24

### Added

- The result envelope now carries MCP `structuredContent` when BaseMind sends one (`{ text, content, isError, structuredContent? }`), so the machine-readable form of a result survives the bridge. BaseMind 0.34.0 sends it for every tool and answers `code_outline`, `code_grep`, `find_files` and `git_diff` with line-oriented text or TOON instead of JSON.
- BaseMind 0.34.0 contract fixtures (`fixtures/basemind-0.34.0-tools.json`, `fixtures/basemind-0.34.0-instructions.txt`) captured from an isolated real binary, plus schema tests that assert the 15 verb tools, the 3 agent tools, the absence of every retired name and lossless normalization of all 18 input schemas.
- `test/integration-legacy.test.mjs`: a version-agnostic smoke test for older binaries (selected with `BASEMIND_BIN`) that asserts only the handshake, dynamic discovery, one safe read and per-root routing.
- `BASEMIND_BIN` and `BASEMIND_REQUIRE_INTEGRATION=1` in both integration suites; with the flag set, a missing binary or an unavailable integration run fails instead of skipping.

### Changed

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
