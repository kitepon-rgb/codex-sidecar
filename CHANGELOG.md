# Changelog

## [0.2.0] — 2026-05-05

### Added
- Public npm package metadata for @codex-sidecar/core, @codex-sidecar/cli, and @codex-sidecar/mcp.
- Global install documentation for the codex-sidecar CLI and codex-sidecar-mcp stdio server.
- Real MCP stdio server entrypoint and Caveat-compatible context input support.

### Fixed
- App Server isolation and final-answer parsing are hardened for Claude/Caveat sidecar use.
- codex_work smoke can remove its temporary worktree while preserving caller-project raw event logs.

## v0.1.0 - 2026-05-05

Initial functional release of the Codex sidecar execution spine.

- Added generic core config loading, preset resolution, safety profiles, and path policy checks.
- Added stable `SidecarRequest` and `SidecarResult` types.
- Added CLI workflows for review, explore, work, opinion, risk-check, and diagnostics.
- Added MCP tool descriptors, schemas, and core-backed handlers.
- Added Codex App Server stdio execution for read-only workflows.
- Added structured output normalization for review, explore, opinion, and risk-check.
- Added raw App Server JSONL event logs and `rawEventLogRef`.
- Added turn timeouts and optional App Server interruption on timeout.
- Added worktree-backed `codex_work` execution with changed-file reporting.
- Added ecosystem context fixtures for generic, MCP/OAuth, hook, and memory-doc repository shapes.
- Added usage documentation for CLI, MCP handlers, worktrees, raw logs, and structured results.
