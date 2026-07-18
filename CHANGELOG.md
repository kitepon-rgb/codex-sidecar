# Changelog

## [Unreleased]

## [0.3.8] — 2026-07-19

### Fixed
- All JSON-producing CLI paths now wait for stdout completion before exiting.
- Repaired truncated large `diagnostics` and `factory-diagnostics` JSON output.
- On `EPIPE`, the CLI exits non-zero without attempting to reprint corrupted JSON.
- Added regression coverage for the related stdout-completion and large-output paths.

## [0.3.6] — 2026-07-13

### Added
- Workflow-specific closed `outputSchema` generation for structured workflows,
  with Codex App Server 0.144.1 capability preflight and fail-closed handling.
- `generate` remains on its caller-supplied object/array output contract without
  changing its existing acceptance behavior.

### Verified
- Caveat advisory smoke completed 8/8 independent Luna low runs (Stop and
  tool-error, four each) with schema-valid structured results.

## [0.3.5] — 2026-07-13

### Fixed
- Isolated sidecar `CODEX_HOME` no longer inherits context-window or
  auto-compaction threshold overrides from the caller environment.
- Removed the repository-local override; updated documentation and regression
  tests for the isolated configuration contract.

## [0.3.4] — 2026-07-12

### Added
- `codex-sidecar --version` reads the installed CLI package manifest, prints
  exactly its semantic version, and exits without loading project config or
  touching auth/cache state.
- A subprocess regression test fixes stdout, stderr, exit code, and no-cache
  behavior for the distributed CLI contract.
- MCP initialize responses now read `serverInfo.version` from the installed MCP
  package manifest instead of duplicating a release number in runtime code.

## [0.3.3] — 2026-07-12

### Added
- Durable asynchronous `codex_work` controls for start, result retrieval,
  cancellation, quarantine recovery, and auth recovery across CLI and MCP.
- Caller-held idempotency keys and detached workers so a later CLI, stdio MCP,
  or HTTP MCP caller can retrieve a handed-off run after a disconnect.
- Global canonical-auth lease handling and explicit recovery paths for abnormal
  worker termination; no automatic patch or worktree salvage is performed.
- Schema-drift handling that returns `status: "partial"` with the raw report and
  disclosed normalization notes while preserving completed `codex_work`
  worktree metadata.
- Isolated `CODEX_HOME` propagation for allowed top-level model settings,
  including GPT-5.6 long-task context settings, without copying MCP/server or
  provider tables.
- `codex-sidecar-mcp` Streamable HTTP transport (selectable via
  `CODEX_SIDECAR_MCP_TRANSPORT=http`) so the MCP server can run as a LAN
  service. stdio remains the default transport.
- HTTP runtime configuration via env: `CODEX_SIDECAR_MCP_HOST`,
  `CODEX_SIDECAR_MCP_PORT`, `CODEX_SIDECAR_MCP_BEARER`, and
  `CODEX_SIDECAR_MCP_ALLOWED_HOSTS` (DNS rebinding protection).
- Optional bearer-token check on every HTTP request when
  `CODEX_SIDECAR_MCP_BEARER` is set.
- Stateful session handling (one `mcp-session-id` per client) over POST/GET/DELETE
  `/mcp`, modelled on the MCP Streamable HTTP spec.
- `Dockerfile`, `.dockerignore`, and `docker-compose.yml` for running the MCP
  server as a containerised LAN service alongside other docker-based MCPs.
- HTTP smoke test in `packages/mcp/src/server-http.test.ts` (initialize,
  tools/list, bearer rejection, missing-session rejection).
- Durable auth/session, detached-work recovery, schema-partial, HTTP transport,
  and npm-bin startup regression tests.

### Documentation
- LAN MCP deployment notes (Docker compose, UFW pattern, mount layout for
  `~/.codex` and consumer repos).
- New `CLAUDE.md` summarising commands, architecture, and invariants for
  Claude Code.
- Durable async work, recovery constraints, GPT-5.6 long-task settings, and a
  reproducible release procedure.

## [0.3.1] — 2026-05-08

### Fixed
- Start the MCP stdio server when `codex-sidecar-mcp` is invoked through an npm
  global `bin` symlink.
- Add a symlinked-bin regression test so distributed MCP installs keep listing
  all six sidecar tools.

### Documentation
- Document npm symlinked `bin` startup as part of the supported MCP
  distribution path.

## [0.3.0] — 2026-05-06

### Added
- Add explicit Codex model policy fields for CLI, MCP, config defaults, and presets.
- Pass resolved model and reasoning effort through Codex App Server startup.
- Report resolved model policy in diagnostics, lifecycle logs, and structured results.

### Verified
- Caveat hook advisory smoke verified `gpt-5.4-mini` with low reasoning effort in the raw App Server log.

## [0.2.2] — 2026-05-05

### Fixed
- Publish codex-sidecar-mcp with a registry-safe `codex-sidecar-core` dependency instead of `workspace:*`.

## [0.2.1] — 2026-05-05

### Fixed
- Publish codex-sidecar-cli with a registry-safe `codex-sidecar-core` dependency instead of `workspace:*`.
- Fix codex-sidecar-mcp npm bin path so global installs expose `codex-sidecar-mcp`.

## [0.2.0] — 2026-05-05

### Added
- Public npm package metadata for codex-sidecar-core, codex-sidecar-cli, and codex-sidecar-mcp.
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
