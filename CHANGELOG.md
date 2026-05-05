# Changelog

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
