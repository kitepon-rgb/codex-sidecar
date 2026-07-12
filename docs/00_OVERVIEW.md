# Canonical Overview

`codex-sidecar` is a pnpm monorepo that runs Codex as a controlled sidecar for
reviews, codebase exploration, risk checks, structured generation, and scoped
work inside isolated git worktrees.

The 0.3.5 patch release keeps durable asynchronous `codex_work` control and
result recovery after caller disconnects, with explicit auth/kill recovery
constraints and schema-partial preservation. The isolated `CODEX_HOME` still
inherits permitted model, provider, and reasoning-effort settings, but no
longer inherits caller context-window or auto-compaction threshold overrides.

The active 0.3.5 patch-release plan is
[RELEASE_0_3_5_PLAN.md](RELEASE_0_3_5_PLAN.md). The completed 0.3.4 CLI/MCP
version contract and release record is archived at
[CLI_VERSION_PLAN.md](archive/CLI_VERSION_PLAN.md).

## Current Canonical Docs

- [../README.md](../README.md): human-facing overview, install examples, and repository layout.
- [../CLAUDE.md](../CLAUDE.md): Claude-specific agent entrypoint, commands, invariants, and local settings procedure.
- [../AGENTS.md](../AGENTS.md): shared agent contract, ecosystem context, and engineering rules.
- [USAGE.md](USAGE.md): CLI and MCP usage, async recovery controls, GPT-5.6 settings, release procedure, result contracts, and deployment examples.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and dependency direction.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server boundary, stable contracts, structured output, and transport notes.
- [TODO.md](TODO.md): durable project task list and external coordination.
- [adr/](adr/): architecture decision records. No ADR entries are filed yet.

## Layout Standard Status

This repository follows the PROJECT_LAYOUT A-monorepo shape: root agent docs,
`docs/`, `rag/`, `packages/`, `examples/`, `pnpm-workspace.yaml`, and shared
TypeScript config. Current generated and local-only state stays out of git via
`.gitignore`.
