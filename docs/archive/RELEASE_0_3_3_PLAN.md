# 0.3.3 Release Plan

Status: Complete

## Goal

Publish the completed disconnect-safe long-running work implementation as the
aligned `codex-sidecar-core`, `codex-sidecar-cli`, and `codex-sidecar-mcp`
0.3.3 release, with current public documentation and reproducible release
evidence.

## Scope

- Document durable asynchronous work and recovery consistently in both READMEs
  and the canonical docs.
- Document the GPT-5.6 long-task context settings, distinguishing allowlist
  copy from user-global config and cwd-based trusted project discovery, without
  copying unrelated TOML tables into the isolated `CODEX_HOME`.
- Update the changelog and release procedure for 0.3.3.
- Verify source, packed packages, Docker image, installed packages, and public
  registry artifacts.
- Commit, push `main`, publish all three npm packages at 0.3.3, tag the exact
  commit, and create the GitHub v0.3.3 release.

## Non-goals

- Do not deploy the Docker service to an unspecified LAN host.
- Do not change runtime behavior or package versions beyond the already aligned
  0.3.3 manifests.
- Do not rewrite existing history or force-push.

## Known Traps

- This shell has pnpm 10.10.0 but no `corepack` executable. Release verification
  must expand the existing `corepack pnpm` scripts explicitly with that exact
  pnpm binary; installing Corepack globally can collide with the existing pnpm
  shim.
- Workspace dependencies must be converted to registry-safe versions in packed
  tarballs; publish core before CLI and MCP.
- npm publication is immutable. Inspect `npm pack --dry-run` and tarball
  manifests before publishing.
- A git tag and GitHub release must point at the exact pushed, verified commit.

## Verification

- Core typecheck/build and 247 tests pass.
- CLI typecheck/build and 5 tests pass.
- MCP typecheck/build and 19 tests pass, including symlinked-bin and disconnect
  recovery integration tests.
- Tracked Markdown links resolve, excluding verbatim external links in
  `rag/**/raw/` snapshots.
- `npm pack --dry-run` and packed tarball inspection show the intended files and
  registry-safe dependency metadata.
- Docker image builds successfully; no host deployment is attempted without a
  target.
- npm registry reports 0.3.3 for all three packages and a fresh installed smoke
  lists the expected MCP tools.
- Tag `v0.3.3` and the GitHub release resolve to the verified publication
  commit. Any post-release archive commit on `origin/main` retains that tagged
  commit as an ancestor.

## Rollback

- Before push: revert the release-doc commit locally.
- After push but before publish: revert with a new commit; do not rewrite public
  history.
- After npm publish: publish a corrective higher version because npm versions
  are immutable. Move no existing tag silently.
- Docker verification creates no persistent deployment; remove only the local
  image if cleanup is needed.

## Tasks

- [x] Confirm clean worktree, empty stash, non-shallow clone, remote delta, npm
  versions, and GitHub authentication.
- [x] Run the pre-change typecheck, test, and build baseline.
- [x] Update all release-relevant public and canonical documentation.
- [x] Run documentation link and consistency checks.
- [x] Run the full post-change verification gate.
- [x] Inspect package tarballs, build the Docker image, and smoke its HTTP
  initialize endpoint.
- [x] Commit the documentation/release record with explicit pathspecs.
- [x] Push the pre-publication `main` commit and confirm CI.
- [x] Publish core, CLI, and MCP 0.3.3 and run installed-package smoke tests.
- [x] Create and verify tag/release `v0.3.3` at the verified publication
  commit.
- [x] Mark this plan complete and archive it as the post-release record.

## Completion Evidence

- Local and GitHub Actions gates passed: core 247 tests, CLI 5 tests, MCP 19
  tests, typecheck, and build.
- `codex-sidecar-core`, `codex-sidecar-cli`, and `codex-sidecar-mcp` 0.3.3 are
  public on npm with exact `codex-sidecar-core: 0.3.3` consumer dependencies.
- A fresh registry install returned `auth-status.state = "available"` and the
  MCP server listed 12 tools, including all five durable work controls.
- Docker image `codex-sidecar:0.3.3` built and its temporary HTTP smoke returned
  `serverInfo.version = "0.3.3"`; no persistent host deployment was attempted.
- GitHub Actions runs `29196064957` and `29196222342` completed successfully.
- Tag and release `v0.3.3` resolve to publication commit
  `167156ce7f5c88a760d5ba1a04defaa3e2ad4134`.
- The optional `codex-sidecar --version` smoke remains unsupported and is
  tracked separately in the current TODO; it was not reported as a passing
  0.3.3 release gate.
