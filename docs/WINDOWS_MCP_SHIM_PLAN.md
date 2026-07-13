# Windows MCP Command-Shim Plan

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
- [x] Run focused and full tests, then prepare aligned package-version/release
  evidence without publishing.

## Non-goals

- No shell invocation or argument re-interpretation.
- No general command runner, fallback executable, or changes outside factory
  diagnostics.
- No registry publish, tag, push, or commit in this wave.

## Verification

- [ ] Baseline status is recorded. (Existing CLI fixture is environment-tainted
  by a local runtime-error store and requires an isolated test environment.)
- [x] Focused CLI tests pass.
- [x] Full workspace typecheck, lint, build, and tests pass.
- [x] Package metadata and pack/install smoke are checked before release handoff.

## Release handoff

- [x] Align core, CLI, and MCP at `0.3.7`; packed CLI/MCP manifests depend on
  registry-safe `codex-sidecar-core@0.3.7`.
- [x] Verify unpublished registry coordinates, tarball contents, and a fresh
  local-prefix CLI/MCP/factory-diagnostics smoke.
- [ ] Commit the scoped diff, push, require CI, and publish core → CLI → MCP.
  This is an approval boundary and is intentionally not executed here.
