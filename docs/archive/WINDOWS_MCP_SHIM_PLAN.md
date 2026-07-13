# Windows MCP Command-Shim Plan

Status: completed on 2026-07-14 with release `v0.3.7`.

## Goal

Make `factory-diagnostics` launch the installed `codex-sidecar-mcp` safely on
Windows when npm exposes it as a `.cmd` shim, so package-version readiness can
perform its bounded MCP initialize probe.

## Scope

- [x] Resolve only a regular `.exe` or a verified npm `.cmd` from `PATH` in a
  killable helper process; the parent validates its bounded result schema.
- [x] For `.cmd`, parse a fixed npm shim shape, realpath its JavaScript
  entrypoint, and require that it remains inside the shim's `node_modules`.
- [x] Preserve the fixed initialize request, one 3-second helper+initialize
  deadline, the 4 KiB helper / 64 KiB MCP output caps, and the 64 KiB
  output limit, and fail-closed diagnostics.
- [x] Add Linux-runnable unit coverage for Windows `.cmd` resolution and
  malformed/traversal rejection; preserve existing native diagnostics coverage.
- [x] Run focused and full tests, then complete the aligned package-version and
  release gate.

## Non-goals

- No shell invocation or argument re-interpretation.
- No general command runner, fallback executable, or changes outside factory
  diagnostics.
- No publish before the scoped commit, exact-SHA CI, package inspection, and
  independent P0/P1 refutation gates pass.

## Verification

- [x] The environment-tainted local runtime-error store is excluded from the
  baseline by using a fresh isolated state/config environment.
- [x] Focused CLI tests pass.
- [x] Full workspace typecheck, lint, build, and tests pass.
- [x] Package metadata and pack/install smoke are checked before release handoff.

## Release handoff

- [x] Align core, CLI, and MCP at `0.3.7`; packed CLI/MCP manifests depend on
  registry-safe `codex-sidecar-core@0.3.7`.
- [x] Verify unpublished registry coordinates, tarball contents, and a fresh
  local-prefix CLI/MCP/factory-diagnostics smoke.
- [x] Commit the scoped diff as `493d0cd`, push it, require exact-SHA CI run
  `29291350736`, and publish core → CLI → MCP at `0.3.7`.
- [x] Verify a temporary Docker HTTP initialize, fresh registry install,
  packaged `factory-diagnostics`, and this host's global CLI/MCP at `0.3.7`.
- [x] Create annotated tag and GitHub Release `v0.3.7` at `493d0cd`.

## Final refutation

The release was paused after independent review and a parent reproduction found
an unhandled helper `EPIPE`. The final implementation also closes late MCP
stdout collection and parent-directory reparse-to-UNC paths. The follow-up
independent audit found no remaining P0/P1 before publication.
