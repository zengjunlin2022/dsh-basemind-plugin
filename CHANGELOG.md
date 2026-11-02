# Changelog

All notable changes to `dsh-basemind-plugin` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zengjunlin2022/dsh-basemind-plugin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zengjunlin2022/dsh-basemind-plugin/releases/tag/v0.1.0
