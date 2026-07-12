# 0.3.5 Release Plan

Status: In Progress

## Goal

Release the removal of sidecar-specific context-window and auto-compaction
threshold overrides as the aligned `codex-sidecar-core`,
`codex-sidecar-cli`, and `codex-sidecar-mcp` 0.3.5 patch release.

## Scope

- Stop copying `model_context_window` and
  `model_auto_compact_token_limit` from the user-global Codex config into the
  isolated sidecar `CODEX_HOME`.
- Remove the repository-local threshold override and document that Codex's
  tuned defaults apply unless a trusted consuming project explicitly overrides
  them.
- Publish all three npm packages at 0.3.5, verify packed and installed
  artifacts, build and smoke the Docker image, and update this host's global
  CLI/MCP installation.
- Tag the exact publication commit and create the GitHub `v0.3.5` release.

## Non-goals

- Do not create a new push-to-production workflow, SSH key, GitHub Secret, or
  persistent-host deployment without a separately identified deployment
  target.
- Do not change Codex model, provider, or reasoning-effort inheritance.
- Do not fix unrelated test behavior unless it prevents the release gate from
  becoming green and the owner explicitly expands scope.
- Do not rewrite history, force-push, or move an existing release tag.

## Known Traps

- The default shell exposes Node 26 and pnpm 10.10.0 but not a `corepack`
  executable. Release verification must use the existing Node 24/Corepack shim
  and confirm pnpm 10.10.0; installing or replacing package-manager shims is out
  of scope.
- The process-group descendant test has produced `ENOENT` under both Node 26
  and Node 24 full-suite load because it reads a child-created PID file without
  waiting for publication. The test-only race must be stabilized and the full
  publication gate rerun; a red gate is not accepted as success.
- npm versions are immutable. Tarballs and registry-safe dependencies must be
  inspected before publishing, and core must be published before CLI and MCP.
- The GitHub tag and release must point to the exact pushed and CI-verified
  publication commit.

## Verification

- Node 24/pnpm 10.10.0 core, CLI, and MCP tests pass with workspace typecheck
  and build.
- `npm pack --dry-run` and packed manifests contain the intended files and
  registry-safe `codex-sidecar-core` 0.3.5 dependencies.
- GitHub Actions for the publication commit is green before npm publication.
- npm reports 0.3.5 for all three packages, and fresh/global installed CLI and
  MCP version smokes report 0.3.5.
- `codex-sidecar:0.3.5` builds and passes a temporary HTTP initialize smoke; no
  persistent Docker host is changed.
- Annotated tag and GitHub Release `v0.3.5` resolve to the publication commit.

## Rollback

- Before push: amend the local release changes or abandon the release commit.
- After push but before npm publication: revert with a new commit; do not
  rewrite public history.
- After npm publication: 0.3.5 is immutable. If publication stops after only
  some packages succeed, record the partial state, stop the release, and align
  all three packages at the same higher corrective patch version. Do not
  unpublish or continue through a different route.
- The Docker verification image is local-only and may be removed without
  affecting a persistent service. Restore the global install to 0.3.4 if the
  0.3.5 installed smoke fails.

## Tasks

- [x] Confirm remote synchronization, stash state, release tooling, npm auth,
  registry versions, Docker availability, and absence of an existing automatic
  deployment workflow.
- [x] Run the Node 24/pnpm 10.10.0 pre-publication gate.
- [x] Stabilize the process-group PID-file publication race and rerun the full
  Node 24 gate reproducibly.
- [x] Align package versions, workspace dependencies, changelog, and release
  documentation at 0.3.5.
- [x] Inspect package dry-runs and packed tarball manifests.
- [ ] Commit with explicit pathspecs, push `main`, and require green GitHub CI.
- [ ] Publish core, CLI, and MCP 0.3.5 in dependency order and verify registry
  availability.
- [ ] Build and smoke the Docker image and update the local global install.
- [ ] Create and verify the `v0.3.5` tag and GitHub Release.
- [ ] Record completion evidence, archive this plan, and push the bookkeeping
  commit.

## Completion Evidence

- Local final gate used Node 24.18.0 and pnpm 10.10.0. Core passed 247 tests in
  two consecutive full runs; CLI passed 6 tests; MCP passed 19 tests;
  workspace typecheck and build passed.
- Independent refutation confirmed that the threshold-inheritance removal and
  0.3.5 manifest alignment are complete, and identified release-procedure
  blockers that were corrected before publication.
- Final packed manifests report 0.3.5 for all packages and registry-safe
  `codex-sidecar-core: 0.3.5` dependencies for CLI and MCP. SHA-256 digests are
  recorded in the release session before publication.
- Publication, registry, Docker, install, tag, and GitHub evidence remain
  pending.
