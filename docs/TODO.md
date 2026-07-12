# TODO

This file is the durable project task list. Keep it aligned with the current
docs and the GitHub issues linked below.

## Current Priority

Disconnect-safe long-running `codex_work` was completed in the 0.3.3 line:
durable run state, detached execution, and result retrieval after MCP client
restart are implemented and verified. The completed plan is archived at
[LONG_RUNNING_WORK_RESILIENCE_PLAN.md](archive/LONG_RUNNING_WORK_RESILIENCE_PLAN.md).
No repository-local P0 is currently marked Planned.

The 0.3.3 publication and Docker verification checklist is tracked in
[RELEASE_0_3_3_PLAN.md](RELEASE_0_3_3_PLAN.md).

The 0.3.3 release record also covers explicit kill/auth recovery constraints,
schema-partial preservation for completed worktrees, and isolated `CODEX_HOME`
inheritance of the GPT-5.6 long-task context settings. MCP/server and provider
tables remain excluded from that isolated configuration.

Explicit Codex model selection is implemented in `codex-sidecar`; the Caveat
advisory preset, hook routing, diagnostics, and real-model smoke were completed
in Caveat v0.14.7. The completed plan is archived at
[CODEX_MODEL_POLICY_TODO.md](archive/CODEX_MODEL_POLICY_TODO.md).

The MCP npm-bin symlink startup bug is fixed in the 0.3.1 line. Keep the
symlinked stdio-server regression test in place for future package and release
changes.

## Active Tasks

| Priority | Task | Status | Issue |
| --- | --- | --- | --- |
| P0 | Normalize read-only workflows into structured `SidecarResult` fields | Done | [#1](https://github.com/kitepon-rgb/codex-sidecar/issues/1) |
| P0 | Persist raw App Server event logs and diagnostics | Done | [#2](https://github.com/kitepon-rgb/codex-sidecar/issues/2) |
| P1 | Expose timeout and cancellation controls for App Server turns | Done | [#3](https://github.com/kitepon-rgb/codex-sidecar/issues/3) |
| P1 | Wire MCP tools to real sidecar execution | Done | [#4](https://github.com/kitepon-rgb/codex-sidecar/issues/4) |
| P0 | Implement worktree-backed `codex_work` execution | Done | [#5](https://github.com/kitepon-rgb/codex-sidecar/issues/5) |
| P2 | Add ecosystem adapters and fixture snapshots | Done | [#6](https://github.com/kitepon-rgb/codex-sidecar/issues/6) |
| P0 | Add explicit Codex model policy for sidecar presets | Done | [CODEX_MODEL_POLICY_TODO.md](archive/CODEX_MODEL_POLICY_TODO.md) |
| P0 | Fix npm symlinked `codex-sidecar-mcp` bin startup | Done | 0.3.1 |
| P0 | Degrade schema-drifted structured reports to `status: "partial"` (salvage completed `codex_work` worktrees) instead of hard-failing | Done | [STRUCTURED_OUTPUT_TOLERANCE_PLAN.md](STRUCTURED_OUTPUT_TOLERANCE_PLAN.md) |
| P0 | Make long-running `codex_work` survive MCP client restart and expose durable result retrieval | Done | [LONG_RUNNING_WORK_RESILIENCE_PLAN.md](archive/LONG_RUNNING_WORK_RESILIENCE_PLAN.md) |

## Local CodeGraph Setup

CodeGraph is installed globally for Codex as the `codegraph` MCP server, and
the CLI is available. The local graph for this repository was initialized on
2026-05-05 and `.codegraph/` is intentionally ignored as a local index.

Useful checks:

```bash
rtk codegraph status /path/to/codex-sidecar
```

Do not treat CodeGraph output as a replacement for direct file verification when
making final claims or edits.

## External Project Coordination

These tasks belong to other repositories, but `codex-sidecar` work should
actively trigger them when the integration boundary is reached.

| Project | Trigger From This Repo | Required External Work | Issue |
| --- | --- | --- | --- |
| Throughline | When `SidecarContextBlock kind: "throughline_handoff"` needs more than read-only DB/CLI import, or when Codex sessions themselves should be captured/resumed. | Add first-class Codex session memory support in Throughline. | [Throughline #1](https://github.com/kitepon-rgb/Throughline/issues/1) |
| Caveat | When `SidecarContextBlock kind: "caveat_entry"` needs automatic Codex prompt/error retrieval or Codex-origin record/update suggestions. | Add first-class Codex retrieval and recording support in Caveat. | [Caveat #10](https://github.com/kitepon-rgb/Caveat/issues/10) |

Coordination rule: when model policy, context adapters, or sidecar workflow
changes require upstream behavior, call out explicitly whether the next step
belongs in `codex-sidecar`, Throughline, Caveat, or another consuming
repository. Do not quietly implement cross-repo behavior in the wrong
repository.

## Rules

- Keep this file high-level; put implementation detail in linked issues or
  focused design docs.
- Do not close a TODO entry until tests or smoke checks prove the behavior.
- If a task cannot be completed as planned, record the explicit blocker instead
  of silently changing scope.
- `codex_work` must remain isolated in a git worktree; do not route it through
  the active working tree for convenience.

## Related Docs

- [../README.md](../README.md): project overview and repository layout.
- [../AGENTS.md](../AGENTS.md): working instructions for Codex and future agents.
- [README.md](README.md): docs index and archive map.
- [archive/CODEX_MODEL_POLICY_TODO.md](archive/CODEX_MODEL_POLICY_TODO.md): archived completed Codex model policy plan.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
- [archive/PLAN.md](archive/PLAN.md): archived original phase roadmap.
- [archive/LONG_RUNNING_WORK_RESILIENCE_PLAN.md](archive/LONG_RUNNING_WORK_RESILIENCE_PLAN.md): archived completed plan for disconnect-safe long-running work.
