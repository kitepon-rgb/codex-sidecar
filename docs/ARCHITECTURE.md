# Architecture

## Overview

`codex-sidecar` keeps Codex orchestration in one independent project instead of
scattering protocol handling across every consuming repository.

The project is both a generic tool and part of kitepon-rgb's AI developer
tooling ecosystem. Claude Code remains the primary working agent in that
ecosystem; Codex is invoked as a sidecar for a second opinion, codebase
investigation, risk analysis, and scoped work that should happen inside an
isolated worktree.

Consuming projects should only need a small `.codex-sidecar.yml` file that
declares default behavior, path boundaries, and named presets.

Callers may be humans, CLI scripts, Claude Code MCP tools, hooks, or other
automation such as memory/context/cost tools. For that reason, every workflow
must return a stable machine-readable result, with human prose treated as one
field rather than the only output.

## Ecosystem Fit

`codex-sidecar` should compose with nearby projects instead of duplicating them:

- Relay can provide saved cross-device conversation context.
- Throughline can provide compressed session context and handoff memos.
- Caveat can provide trap memories and repo-specific gotchas.
- SmartClaude can decide whether a Codex call is worth the context/cost.
- image-generator contributes OAuth/MCP hub deployment patterns.
- IP-MCP contributes source-boundary discipline and no-hidden-fallback rules.

The sidecar receives relevant context from those systems, shapes it for Codex,
runs the session safely, and returns normalized results they can store, display,
or act on.

## Layering

The architecture has two layers.

### Generic Core

This layer must be useful for any repository:

- config loading
- preset resolution
- path safety
- App Server protocol handling
- worktree isolation
- CLI/MCP request handling
- normalized JSON result contracts

### Ecosystem Overlay

This layer adds defaults and optional context for kitepon-rgb projects:

- safety profiles for MCP/OAuth/hooks/Docker/memory repos
- context adapters for Relay, Throughline, Caveat, and SmartClaude
- risk presets for source boundaries, token stores, hooks, and public endpoints
- fixture projects that mirror the user's recurring repo shapes

Overlay code must not leak into generic behavior. A project without ecosystem
options should get a clean generic sidecar.

## Packages

### `packages/core`

Owns shared behavior:

- project config loading
- preset resolution
- safety policy normalization
- path allow/deny matching
- prompt shaping
- ecosystem context adapters
- Codex App Server process lifecycle
- session/event normalization
- worktree isolation for write operations
- result schemas and JSON contract normalization
- diagnostics and raw event log references

### `packages/cli`

Provides local commands:

- `codex-sidecar review`
- `codex-sidecar explore`
- `codex-sidecar work`
- `codex-sidecar opinion`
- `codex-sidecar risk-check`

The CLI should stay thin and delegate policy decisions to `core`.

The CLI is also the generic user-facing entrypoint. It should not require Relay,
Throughline, Caveat, SmartClaude, or any other ecosystem project.

### `packages/mcp`

Provides an MCP server for Claude Code:

- `codex_review`
- `codex_explore`
- `codex_work`
- `codex_opinion`
- `codex_risk_check`

The MCP layer should expose stable tool schemas and translate calls into the
same `core` request types used by the CLI.

Read-only tools should be easy to call. Write-capable tools must require an
explicit project config and must surface safety refusals as structured errors.

## Suggested Core Modules

Inside `packages/core/src`:

- `config`: load and validate `.codex-sidecar.yml`
- `presets`: expand preset names into normalized requests
- `safety`: read/write policy checks
- `paths`: glob matching, path normalization, traversal defense
- `profiles`: generic and ecosystem safety profiles
- `results`: JSON schemas and result builders
- `context`: optional context block contracts
- `prompts`: workflow-specific prompt shaping
- `app-server`: Codex App Server process/session adapter
- `worktree`: isolated worktree lifecycle
- `diagnostics`: environment and config checks

## Safety Model

Read-only workflows may inspect files and git state inside the target project.
Write workflows must use an isolated git worktree and must be constrained by
`allowed_paths` and `deny_paths`.

Default deny categories should include secrets, `.env`, private keys, OAuth
token stores, SQLite auth databases, hook registration files, deployment
overrides, and generated artifacts unless a consuming project explicitly allows
safe read-only inspection.

Approval prompts, dangerous operations, and Codex App Server policy decisions
must remain visible to the user. The sidecar should normalize outputs, not hide
important control-flow decisions.

No hidden fallback rule: if a requested source, protocol, transport, or tool path
fails, return an explicit error. Do not silently substitute another source or
implementation path, especially where official/unofficial data boundaries,
secrets, auth, deploy, or CI behavior are involved.

## Result Contract

Every workflow should return a JSON object that can be consumed by other tools.
Human-readable prose is allowed, but it must not be the only interface.

Common fields:

- `status`
- `summary`
- `findings`
- `risks`
- `openQuestions`
- `fileReferences`
- `changedFiles`
- `tests`
- `confidence`
- `sourceBoundaries`
- `recommendedNextAction`
- `costNotes`

Risk and finding records should distinguish observed evidence from inference.

## Dependency Direction

Allowed:

- CLI imports core.
- MCP imports core.
- ecosystem adapters import generic core types.
- core may expose adapter interfaces.

Avoid:

- core importing CLI or MCP.
- generic safety logic importing ecosystem projects directly.
- App Server protocol code leaking into CLI or MCP.
- downstream tools parsing prose instead of JSON fields.

## Related Docs

- [../README.md](../README.md): project overview and repository layout.
- [../AGENTS.md](../AGENTS.md): working instructions for Codex and future agents.
- [PLAN.md](PLAN.md): roadmap, phases, generic core, and ecosystem overlay.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
