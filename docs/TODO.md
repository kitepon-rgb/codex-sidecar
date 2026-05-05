# TODO

This file is the durable project task list. Keep it aligned with
[PLAN.md](PLAN.md) and the GitHub issues linked below.

## Current Priority

1. Implement write workflows only through isolated worktrees.
2. Add ecosystem adapters and fixture snapshots after the generic contracts are
   stable.

## Active Tasks

| Priority | Task | Status | Issue |
| --- | --- | --- | --- |
| P0 | Normalize read-only workflows into structured `SidecarResult` fields | Done | [#1](https://github.com/kitepon-rgb/codex-sidecar/issues/1) |
| P0 | Persist raw App Server event logs and diagnostics | Done | [#2](https://github.com/kitepon-rgb/codex-sidecar/issues/2) |
| P1 | Expose timeout and cancellation controls for App Server turns | Done | [#3](https://github.com/kitepon-rgb/codex-sidecar/issues/3) |
| P1 | Wire MCP tools to real sidecar execution | Done | [#4](https://github.com/kitepon-rgb/codex-sidecar/issues/4) |
| P0 | Implement worktree-backed `codex_work` execution | Open | [#5](https://github.com/kitepon-rgb/codex-sidecar/issues/5) |
| P2 | Add ecosystem adapters and fixture snapshots | Open | [#6](https://github.com/kitepon-rgb/codex-sidecar/issues/6) |

## Local CodeGraph Setup

CodeGraph is installed globally for Codex as the `codegraph` MCP server, and
the CLI is available. The local graph for this repository was initialized on
2026-05-05 and `.codegraph/` is intentionally ignored as a local index.

Useful checks:

```bash
rtk codegraph status /home/kite/projects/codex-sidecar
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

Coordination rule: during work on [#6](https://github.com/kitepon-rgb/codex-sidecar/issues/6),
call out explicitly whether the next step belongs in `codex-sidecar`,
Throughline, or Caveat. Do not quietly implement cross-repo behavior in the
wrong repository.

## Rules

- Keep this file high-level; put implementation detail in linked issues or
  focused design docs.
- Do not close a TODO entry until tests or smoke checks prove the behavior.
- If a task cannot be completed as planned, record the explicit blocker instead
  of silently changing scope.
- `codex_work` remains unavailable until isolated worktree execution is fully
  wired and verified.

## Related Docs

- [../README.md](../README.md): project overview and repository layout.
- [../AGENTS.md](../AGENTS.md): working instructions for Codex and future agents.
- [PLAN.md](PLAN.md): roadmap, phases, generic core, and ecosystem overlay.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
