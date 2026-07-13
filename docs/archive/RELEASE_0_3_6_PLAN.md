# 0.3.6 Release Plan

Status: Complete — published and installed on 2026-07-13.

## Goal

Release the aligned `codex-sidecar-core`, `codex-sidecar-cli`, and
`codex-sidecar-mcp` 0.3.6 patch with workflow-specific closed output schemas,
Codex App Server 0.144.1 preflight, and unchanged caller-owned `generate`
object/array output contracts.

The upstream Caveat acceptance context is recorded in
[`Caveat/docs/11_precision_and_runtime_reliability.md`](../../Caveat/docs/11_precision_and_runtime_reliability.md),
Lane D. This plan does not change Caveat runtime behavior.

## Non-goals

- Do not change runtime/code beyond the already-reviewed feature diff.
- Do not commit, push, tag, publish, globally install, or alter a deployment
  without separate owner authorization.
- Do not introduce a prose or schema-less fallback for unsupported App Server
  versions.

## Release Gates

- [x] Confirm the intended runtime/code diff is scoped to the structured-output
  and preflight contract; review existing dirty changes without reverting them.
- [x] Run workspace build, typecheck, lint, and all package tests green.
- [x] Run schema/fake App Server coverage for valid output, schema rejection,
  trailing garbage, old-server preflight rejection, and unchanged `generate`
  object/array behavior.
- [x] Run the recorded Caveat Luna low advisory validation: Stop and tool-error
  each four independent runs, all schema-valid and `status: ok`; retain every
  attempted run in the denominator.
- [x] Inspect package dry-runs and manifests: all package versions are 0.3.6
  and CLI/MCP publish dependencies are registry-safe `codex-sidecar-core@0.3.6`.
- [x] Obtain independent final review of protocol compatibility, generate
  non-regression, and fail-closed behavior.
- [x] After explicit owner approval only: commit scoped paths, push, require CI,
  publish core before CLI/MCP, verify registry/fresh installs, then tag and
  release `v0.3.6`.

Owner authorization to commit, push, publish, release, and install was provided
in the Caveat implementation thread on 2026-07-13. Publication remains gated on
CI for the exact pushed commit.

Local evidence on 2026-07-13: typecheck and lint passed; core 268, CLI 10, and
MCP 19 tests passed; all packages built and packed as 0.3.6; CLI/MCP tarballs
referenced the registry-safe `codex-sidecar-core@0.3.6`; Luna low completed all
eight attempted Stop/tool-error runs with `status: ok`; the final independent
review had no surviving compatibility or fail-closed finding.

Release evidence: commit `581e81dd2bf9656adc71d2988ae089e1fb6b96a3` passed CI run
`29226366326`; all three npm packages were published and verified as 0.3.6 in
dependency order; the temporary Docker MCP initialize smoke returned 0.3.6;
fresh-prefix and global CLI/MCP installs returned 0.3.6; annotated tag and
GitHub Release `v0.3.6` resolve to the verified commit.

## Rollback

Before publication, revert the release metadata or feature changes in a new
scoped commit. After npm publication, versions are immutable: stop on partial
publication and issue a higher aligned corrective version; do not unpublish or
rewrite history.
