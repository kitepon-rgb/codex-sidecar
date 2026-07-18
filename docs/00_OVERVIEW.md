# Canonical Overview

`codex-sidecar` is a pnpm monorepo that runs Codex as a controlled sidecar for
reviews, codebase exploration, risk checks, structured generation, and scoped
work inside isolated git worktrees.

The completed 0.3.6 release added workflow-specific closed output schemas with
a Codex App Server 0.144.1 preflight while preserving `generate`'s
caller-owned object/array output contract. The completed 0.3.7 patch makes
factory diagnostics safely launch the npm-installed MCP command on Windows.
The completed 0.3.8 release repairs complete JSON-producing CLI stdout handling
for large diagnostics output and `EPIPE`.

The completed 0.3.5 release record is archived at
[RELEASE_0_3_5_PLAN.md](archive/RELEASE_0_3_5_PLAN.md). The completed 0.3.4
CLI/MCP version contract and release record is archived at
[CLI_VERSION_PLAN.md](archive/CLI_VERSION_PLAN.md).
The completed 0.3.7 Windows command-shim release record is archived at
[WINDOWS_MCP_SHIM_PLAN.md](archive/WINDOWS_MCP_SHIM_PLAN.md).
The completed 0.3.8 JSON stdout integrity and release record is archived at
[plan_factory-diagnostics-output-integrity.md](archive/plan_factory-diagnostics-output-integrity.md).

## Current Canonical Docs

- [../README.md](../README.md): human-facing overview, install examples, and repository layout.
- [../CLAUDE.md](../CLAUDE.md): Claude-specific agent entrypoint, commands, invariants, and local settings procedure.
- [../AGENTS.md](../AGENTS.md): shared agent contract, ecosystem context, and engineering rules.
- [USAGE.md](USAGE.md): CLI and MCP usage, async recovery controls, GPT-5.6 settings, release procedure, result contracts, and deployment examples.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and dependency direction.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server boundary, stable contracts, structured output, and transport notes.
- [TODO.md](TODO.md): durable project task list and external coordination.
- [adr/INDEX.md](adr/INDEX.md): architecture decision records and acceptance evidence.

## Layout Standard Status

This repository follows the PROJECT_LAYOUT A-monorepo shape: root agent docs,
`docs/`, `rag/`, `packages/`, `examples/`, `pnpm-workspace.yaml`, and shared
TypeScript config. Current generated and local-only state stays out of git via
`.gitignore`.
