# codex-sidecar

`codex-sidecar` is a shared execution layer for calling Codex as a sidecar
agent. It has a generic CLI/MCP core and an optional kitepon-rgb ecosystem
overlay.

It is meant for an environment where Claude Code is the primary working agent
and Codex is called for second opinions, reviews, codebase exploration, focused
risk checks, and small scoped implementation tasks. The generic core should
remain useful outside that ecosystem.

The project focuses on five initial workflows:

- `codex_review`: review the current diff, branch, or patch in read-only mode.
- `codex_explore`: answer codebase questions with file references.
- `codex_work`: implement small scoped changes in an isolated git worktree.
- `codex_opinion`: challenge a design or implementation plan.
- `codex_risk_check`: focus on MCP, OAuth, secrets, hooks, Docker, CI, and
  other high-risk surfaces.

It is intentionally not an OpenAI API gateway and does not replace image
generation APIs. Its job is to provide a shared, safety-conscious way to bring
Codex into an existing AI-assisted development environment.

The surrounding ecosystem matters:

- Relay stores and retrieves cross-device Claude conversation context.
- Throughline compresses Claude Code context and carries explicit handoffs.
- Caveat stores long-term trap memory and repo-specific gotchas.
- SmartClaude measures and optimizes token/context cost.
- CodeGraph provides local symbol graph context when a repository is initialized.
- image-generator and IP-MCP provide MCP/OAuth/deployment patterns and
  source-boundary lessons.

`codex-sidecar` should compose with those projects without requiring them. It
owns Codex App Server process/session handling, request shaping, safety checks,
worktree isolation, and normalized machine-readable results.

## Repository Layout

```text
codex-sidecar/
├─ docs/
│  ├─ PLAN.md
│  ├─ TODO.md
│  ├─ ARCHITECTURE.md
│  └─ PROTOCOL.md
├─ examples/
│  └─ .codex-sidecar.yml
├─ packages/
│  ├─ core/
│  ├─ cli/
│  └─ mcp/
├─ package.json
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

## Status

The project now has a working generic spine:

- ecosystem-aware config validation and preset/request normalization
- path safety, safety profiles, and structured refusal/errors
- stable `SidecarRequest` / `SidecarResult` types
- CLI commands for all workflows
- MCP tool descriptors and schemas
- Codex App Server stdio client, JSON-line protocol handling, initialize,
  `thread/start`, `turn/start`, completion waiting, and read-only turn execution
- structured read-only result normalization for review, explore, opinion, and
  risk-check workflows
- raw App Server JSONL event logs with inspectable `rawEventLogRef` artifacts
- caller-selected turn timeouts with optional App Server `turn/interrupt`
  cancellation on timeout
- local smoke coverage showing `codex_explore` can complete through the real
  App Server and return `status: "ok"`
- local CodeGraph index initialized for this repository
- worktree lifecycle helpers for future write workflows
- durable TODO tracking in [docs/TODO.md](docs/TODO.md) with linked GitHub issues

Current limitations:

- `codex_work` is intentionally unavailable until worktree-backed execution is
  wired end to end.
- MCP handlers are still descriptor/schema-only and are tracked in
  [issue #4](https://github.com/kitepon-rgb/codex-sidecar/issues/4).

## Related Docs

- [AGENTS.md](AGENTS.md): working instructions for Codex and future agents.
- [docs/PLAN.md](docs/PLAN.md): roadmap, phases, generic core, and ecosystem overlay.
- [docs/TODO.md](docs/TODO.md): durable task list and linked GitHub issues.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
