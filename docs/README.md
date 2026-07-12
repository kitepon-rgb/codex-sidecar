# Docs

This directory keeps the current operating docs for `codex-sidecar`.

## Current Docs

- [00_OVERVIEW.md](00_OVERVIEW.md): canonical overview and doc map for the current project.
- [USAGE.md](USAGE.md): CLI/MCP usage, durable async recovery controls, GPT-5.6 settings, release procedure, and structured result examples.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, isolated configuration, and result contract.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server protocol boundary, schema-partial behavior, and stable sidecar contracts.
- [TODO.md](TODO.md): durable task list and linked GitHub issues.
- [CLI_VERSION_PLAN.md](CLI_VERSION_PLAN.md): active `--version` implementation and 0.3.4 release checklist.

## Decisions

Architecture decision records live under [adr/](adr/). No decision records are
currently filed there.

## Archive

Historical plans and external handoff briefs live under [archive/](archive/).
Archived docs are useful context, but current behavior should be checked against
the docs above and the implementation before making changes.

- [archive/LONG_RUNNING_WORK_RESILIENCE_PLAN.md](archive/LONG_RUNNING_WORK_RESILIENCE_PLAN.md): completed durable detached execution and result recovery plan for long-running `codex_work` calls.
- [archive/CODEX_MODEL_POLICY_TODO.md](archive/CODEX_MODEL_POLICY_TODO.md): completed explicit Codex model policy plan and Caveat rollout record.
- [archive/RELEASE_0_3_3_PLAN.md](archive/RELEASE_0_3_3_PLAN.md): completed 0.3.3 publication and Docker verification record.
