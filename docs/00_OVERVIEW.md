# Canonical Overview

`codex-sidecar` is a pnpm monorepo that runs Codex as a controlled sidecar for
reviews, codebase exploration, risk checks, structured generation, and scoped
work inside isolated git worktrees.

## Current Canonical Docs

- [../README.md](../README.md): human-facing overview, install examples, and repository layout.
- [../CLAUDE.md](../CLAUDE.md): Claude-specific agent entrypoint, commands, invariants, and local settings procedure.
- [../AGENTS.md](../AGENTS.md): shared agent contract, ecosystem context, and engineering rules.
- [USAGE.md](USAGE.md): CLI and MCP usage, result contracts, worktree behavior, raw logs, and deployment examples.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and dependency direction.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server boundary, stable contracts, structured output, and transport notes.
- [TODO.md](TODO.md): durable project task list and external coordination.
- [CODEX_MODEL_POLICY_TODO.md](CODEX_MODEL_POLICY_TODO.md): model-policy implementation plan and remaining upstream follow-up.
- [adr/](adr/): architecture decision records. No ADR entries are filed yet.

## Layout Standard Status

This repository follows the PROJECT_LAYOUT A-monorepo shape: root agent docs,
`docs/`, `rag/`, `packages/`, `examples/`, `pnpm-workspace.yaml`, and shared
TypeScript config. Current generated and local-only state stays out of git via
`.gitignore`.
