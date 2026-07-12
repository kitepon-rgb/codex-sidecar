# Wave 4 Native Factory Diagnostics Plan

## Goal

Add a read-only `factory-diagnostics` CLI command with a machine-readable
native factory readiness report while preserving the existing `diagnostics`
contract byte-for-byte for current consumers. It must validate package-version alignment and the
configuration-derived readiness of the supported workflow/preset/model-policy
surface without launching Codex or exposing sensitive request content.

## Contract decisions

- The report derives CLI/core versions from their installed package locations
  and the separately installed MCP version from a bounded stdio initialize
  handshake. It also reads parsed sidecar config and `buildSidecarRequest`; it
  never starts an App Server turn.
- Each check reports `ready`, `not_applicable`, or `unverified`. A detected
  inconsistency is never promoted to ready. `overall` is ready only when every
  applicable check is ready.
- Output is a compact allowlisted summary. It excludes prompts, context blocks,
  file contents, absolute project paths, environment values, token data, raw
  logs, and full `SidecarResult` bodies.
- Existing `diagnostics` remains the request-resolution compatibility surface.
  Native readiness is additive under the distinct `factory-diagnostics` command.
- Configured preset names are not emitted. Only aggregate counts and readiness
  state cross the factory diagnostics privacy boundary.

## Checklist

- [x] Add characterization tests preserving the existing diagnostics payload.
- [x] Add a separate privacy-boundary test for `factory-diagnostics`.
- [x] Implement manifest version alignment and diagnostic result schema in
  `packages/cli`.
- [x] Verify package discovery in an isolated packed installation rather than
  relying on monorepo sibling paths.
- [x] Evaluate workflows/presets/model policy through read-only dry-run request
  construction, including explicit `not_applicable` and `unverified` states.
- [x] Document the additive JSON contract and refresh fixtures/tests.
- [x] Run typecheck, test, build, diff check, and the full repository gate.

## Verification record

- `corepack` was unavailable in the host PATH. The installed `pnpm 10.10.0`
  exactly matches the repository `packageManager` pin, so the root scripts'
  underlying commands were run directly.
- Core, CLI, and MCP tests passed; recursive typecheck, lint, and build passed;
  `git diff --check` passed.
