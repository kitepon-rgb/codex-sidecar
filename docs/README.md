# Docs

This directory keeps the current operating docs for `codex-sidecar`.

## Current Docs

- [00_OVERVIEW.md](00_OVERVIEW.md): canonical overview and doc map for the current project.
- [USAGE.md](USAGE.md): CLI, MCP handler, worktree, raw log, and structured result examples.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
- [TODO.md](TODO.md): durable task list and linked GitHub issues.
- [CODEX_MODEL_POLICY_TODO.md](CODEX_MODEL_POLICY_TODO.md): explicit Codex model policy plan and task list.
- [LONG_RUNNING_WORK_RESILIENCE_PLAN.md](LONG_RUNNING_WORK_RESILIENCE_PLAN.md): durable detached execution and result recovery plan for long-running `codex_work` calls.

## Decisions

Architecture decision records live under [adr/](adr/). No decision records are
currently filed there.

## Archive

Historical plans and external handoff briefs live under [archive/](archive/).
Archived docs are useful context, but current behavior should be checked against
the docs above and the implementation before making changes.
