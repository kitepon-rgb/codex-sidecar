# CLI Version Flag Plan

Status: In Progress

## Goal

Complete the remaining P2 by making `codex-sidecar --version` report the
installed CLI package version reliably and publish it in the lockstep 0.3.4
patch release.

## Contract

- `codex-sidecar --version` prints exactly the semantic version plus one newline
  to stdout and exits zero.
- It does not load project config, inspect auth, or create cache state.
- `packages/cli/package.json` is the single version source; runtime code does
  not duplicate the release number.
- A missing or invalid packaged manifest fails explicitly with non-zero status.

## Non-goals

- Do not add `-v`, a `version` subcommand, or MCP version tools.
- Do not change other CLI parsing or runtime behavior.

## Verification

- Characterization first: the new test fails against the current parser's
  `Unknown option: --version` behavior.
- CLI tests, full workspace typecheck/test/build, 0.3.4 packed tarballs, and
  fresh installed-bin smoke pass.

## Tasks

- [x] Add a subprocess regression test for stdout, stderr, exit code, and no
  config/cache access.
- [x] Implement manifest-backed `--version` handling before normal parsing.
- [x] Update README, changelog, TODO, and docs indexes.
- [x] Remove the hard-coded MCP handshake version and verify it against the
  packaged MCP manifest.
- [x] Run targeted and full verification gates after the MCP correction.
- [x] Pack/install smoke the corrected distributed CLI and MCP bins.
- [ ] Commit, push, confirm CI, and publish lockstep 0.3.4 packages.
- [ ] Create and verify tag/GitHub release `v0.3.4`.
- [ ] Mark complete and archive this plan.
