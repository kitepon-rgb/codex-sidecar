# CLI Version Flag Plan

Status: Complete

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
- [x] Commit, push, confirm CI, and publish lockstep 0.3.4 packages.
- [x] Create and verify tag/GitHub release `v0.3.4`.
- [x] Mark complete and archive this plan.

## Completion Evidence

- Release commit: `44548ecb943fe08adeb1e2d96c57a2a693052ed9`.
- CI run `29196993545`: typecheck, test, and build passed.
- npm registry: `codex-sidecar-core`, `codex-sidecar-cli`, and
  `codex-sidecar-mcp` are published at `0.3.4`.
- Fresh registry install and global install both reported CLI `0.3.4` and MCP
  `serverInfo.version=0.3.4`.
- Docker image `codex-sidecar:0.3.4` passed an HTTP initialize smoke with MCP
  `serverInfo.version=0.3.4`.
- Annotated tag and GitHub Release `v0.3.4` resolve to the release commit.
