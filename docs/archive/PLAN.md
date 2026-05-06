# Archived Plan

This is the original phase roadmap for `codex-sidecar`. It is retained as
historical context. Current behavior and active work are tracked in
[../README.md](../README.md), [../ARCHITECTURE.md](../ARCHITECTURE.md),
[../PROTOCOL.md](../PROTOCOL.md), [../USAGE.md](../USAGE.md), and
[../TODO.md](../TODO.md). Active model-selection work is tracked in
[../CODEX_MODEL_POLICY_TODO.md](../CODEX_MODEL_POLICY_TODO.md).

## Goal

Build `codex-sidecar` as a reusable Codex sidecar execution layer.

It must satisfy two audiences at the same time:

- **Generic users** who want a safe CLI/MCP way to ask Codex for review,
  exploration, design pushback, risk checks, and small scoped edits.
- **kitepon-rgb's AI developer tooling ecosystem** where Claude Code is the
  primary agent and Codex is called as a second opinion by tools such as Relay,
  Throughline, Caveat, SmartClaude, CodeGraph, image-generator, and IP-MCP.

The implementation should therefore be layered:

- **Generic core**: project config, safety policy, Codex App Server protocol,
  worktree isolation, CLI/MCP commands, and JSON result contracts.
- **Ecosystem overlay**: presets, context adapters, risk profiles, and default
  deny rules informed by the existing kitepon-rgb repositories.

The generic layer must be useful outside this ecosystem. The overlay must make
it especially effective for the user's MCP/OAuth/hook/memory/cost tooling.

## Design Principles

- Claude Code remains the primary working agent; Codex is a sidecar.
- Every workflow returns machine-readable JSON plus optional human prose.
- `codex_work` never writes directly to the active working tree.
- Write workflows require `allowed_paths` and isolated git worktrees.
- Sensitive files are denied by default.
- No hidden fallback: failure must be explicit.
- Source boundaries must be represented in outputs when trust differs.
- CLI and MCP are thin wrappers over `packages/core`.
- Ecosystem integrations are adapters, not hard dependencies.

## MVP Spine

The first usable version should prove the shape without pretending the App
Server protocol is finished.

MVP means:

- config and preset loading work
- safety policy refuses unsafe write requests
- all five workflows can be normalized into `SidecarRequest`
- all five workflows can return stable `SidecarResult` JSON
- CLI can run in `--dry-run` mode and show the normalized request/result
- MCP tool descriptors and schemas exist
- Codex App Server read-only execution works behind the same request/result
  boundary without changing callers

The current MVP spine has reached real read-only App Server execution. It does
not require `codex_work` to complete real edits through Codex yet. It does
require the refusal and isolation rules to be real, tested behavior.

## Priority Order

1. Make the project itself buildable and testable.
2. Lock the generic request/result/config contracts.
3. Implement safety before App Server execution.
4. Implement CLI dry-run before MCP.
5. Implement MCP read-only tools before write-capable tools.
6. Integrate Codex App Server for read-only workflows.
7. Add worktree-backed `codex_work`.
8. Add ecosystem adapters after the generic contracts are stable.

This order is not about reducing work. It keeps the contracts honest: if the
generic core is solid, both generic users and the kitepon-rgb ecosystem can
consume it cleanly.

## Initial Workflows

### `codex_review`

Read-only review of a diff, branch, patch, or current working tree state.

Generic output:

- findings ordered by severity
- open questions
- missing tests
- residual risks
- short summary

Ecosystem emphasis:

- MCP schema regressions
- OAuth/token handling
- hook side effects
- Docker/reverse-proxy deployment drift
- no-fallback/source-boundary violations

### `codex_explore`

Read-only codebase investigation.

Generic output:

- answer
- file references
- confidence notes
- relevant risks

Ecosystem emphasis:

- find the actual tool boundary before answering
- distinguish docs, implementation, generated artifacts, and deployment config
- identify whether Caveat/Throughline/Relay context would materially change the
  answer

### `codex_work`

Scoped implementation in an isolated git worktree.

Safety requirements:

- never write directly to the active working tree
- require `allowed_paths`
- respect `deny_paths`
- do not auto-merge
- report changed files, tests, and risks

Ecosystem emphasis:

- default-deny secrets, OAuth DBs, `.env`, hook registration, deploy overrides,
  generated artifacts, and private memory stores
- prefer minimal patches that Claude can review and merge manually

### `codex_opinion`

Read-only second opinion on a design, plan, or implementation direction.

Output:

- strongest objection
- alternative approach
- hidden assumptions
- failure modes
- recommendation
- confidence

This is intentionally separate from `review`: it can be called before code
exists.

### `codex_risk_check`

Focused risk review for high-risk areas.

Default risk areas:

- MCP tool schemas and transport behavior
- OAuth 2.1, tokens, refresh rotation, and auth metadata
- secrets, `.env`, signing keys, SQLite token DBs
- Docker, reverse proxy, public endpoint configuration
- Claude Code hooks and transcript handling
- CI, release, package publishing, and generated artifacts
- official/unofficial source separation
- hidden fallback behavior

Output:

- risk items ordered by severity
- affected files
- confidence
- suggested verification
- evidence classification: `observed`, `inferred`, or `hypothetical`

## Result Contract

All workflows should return a `SidecarResult` with stable JSON fields.

Required fields:

- `status`
- `workflow`
- `summary`
- `confidence`
- `recommendedNextAction`

Common optional fields:

- `findings`
- `risks`
- `openQuestions`
- `missingTests`
- `residualRisks`
- `fileReferences`
- `changedFiles`
- `tests`
- `sourceBoundaries`
- `costNotes`
- `rawEventLogRef`

Finding/risk records should include:

- `severity`
- `title`
- `detail`
- `evidence`
- `file`
- `line`
- `confidence`
- `basis`: `observed | inferred | hypothetical`

## Config Model

Generic project config lives in `.codex-sidecar.yml`.

It should support:

- project name
- defaults
- allowed/deny paths
- presets
- workflow-specific options
- result format options
- integration hints

Config has three layers:

- built-in defaults
- project config
- per-call overrides from CLI or MCP

Resolution must be explicit and inspectable. A diagnostics command should be
able to show the final normalized request without running Codex.

Example direction:

```yaml
project: image-generator

defaults:
  readonly: true
  result_format: json

safety_profile: mcp-oauth-service

allowed_paths:
  - server/
  - docs/

deny_paths:
  - .env
  - .env.*
  - "**/*.key"
  - "**/*.pem"
  - "**/*.sqlite"
  - "**/*.db"

presets:
  review:
    workflow: review
    readonly: true
  risk:
    workflow: risk-check
    focus: [mcp, oauth, secrets, docker]
  work:
    workflow: work
    readonly: false
    require_worktree: true
```

## Generic Features

These must work even outside the kitepon-rgb ecosystem:

- CLI commands for all workflows.
- MCP tools for all workflows.
- config loading and validation.
- preset resolution.
- path allow/deny matching.
- isolated worktree creation for write workflows.
- normalized JSON result schema.
- raw event logging for debugging.
- no hidden fallback behavior.
- diagnostics command that explains config, path policy, and environment state.

## Ecosystem Features

These make the tool especially useful for the user's repositories:

- safety profiles:
  - `mcp-oauth-service`
  - `claude-hook-package`
  - `markdown-memory-repo`
  - `python-mcp-service`
  - `node-mcp-service`
  - `dockerized-public-endpoint`
- context adapters:
  - Relay saved conversation snippets
  - Throughline handoff memo/session summary
  - Caveat trap entries
  - SmartClaude call-value/cost hints
  - CodeGraph local symbol graph snippets
- risk focus presets:
  - OAuth/token/source-boundary
  - MCP transport/schema
  - hooks/transcript/context injection
  - Docker/reverse proxy/public endpoint
  - generated docs/assets/release artifacts
- JSON fields that downstream tools can store or display without parsing prose.

Adapters should be optional input contracts first. Do not make `codex-sidecar`
depend on those projects at runtime until the contract is stable.

## Decisions

### Generic Tooling Is A First-Class Goal

The project must not become a private kitepon-rgb-only helper. Generic users
should be able to install it, create `.codex-sidecar.yml`, and call CLI/MCP
tools without Relay, Throughline, Caveat, SmartClaude, image-generator, or
IP-MCP.

### Ecosystem Awareness Is Also A First-Class Goal

The generic core is not an excuse to ignore the user's actual repository shapes.
Safety profiles, risk presets, and adapter contracts should be informed by the
MCP/OAuth/hook/memory/cost projects already visible in kitepon-rgb repositories.

### Safety Before Execution

Path policy, workflow policy, and result contracts come before App Server
execution. A tool that can correctly refuse unsafe work is more valuable than a
tool that can call Codex but cannot enforce boundaries.

### Adapters Before Hard Dependencies

Relay, Throughline, Caveat, SmartClaude, and CodeGraph should initially provide
context as plain JSON blocks. Direct imports or runtime coupling can come later
only if the contract proves stable.

### Errors Before Fallbacks

If a config, path policy, protocol message, source boundary, or worktree setup
cannot be validated, return a structured error. Do not silently continue with a
different source, transport, policy, or execution mode.

## Validation Matrix

The test suite should cover these axes:

- generic config vs ecosystem profile config
- read-only workflow vs write workflow
- allowed path vs denied path vs path traversal
- no config vs invalid config vs valid config
- CLI request vs MCP request
- prose output enabled vs JSON-only output
- App Server unavailable vs protocol error vs safety refusal
- observed vs inferred vs hypothetical findings

## Fixture Projects

Fixtures should mirror both generic and ecosystem use cases:

- minimal generic TypeScript repo
- minimal generic Python repo
- Node MCP server
- Python MCP server
- OAuth-protected Docker service
- Claude hook package
- markdown-in-git memory repo
- mixed official/unofficial source tool

Each fixture should include a `.codex-sidecar.yml` and at least one expected
request/result snapshot.

## Roadmap

### Phase 0: Repository Baseline

Status: complete.

Tasks:

- root docs and package structure
- `AGENTS.md`
- `packages/core`, `packages/cli`, `packages/mcp`
- README/doc cross-links
- resolve local git/toolchain issue
- install package manager and run first typecheck

Exit criteria:

- `pnpm typecheck` can run
- repo is a valid git repository
- docs describe generic + ecosystem split

### Phase 1: Config And Presets

Status: complete.

Tasks:

- strict config schema
- preset resolution
- three-layer config merge: built-in defaults, project config, per-call overrides
- workflow option normalization
- config diagnostics with useful errors
- sample configs for generic and ecosystem projects

Exit criteria:

- invalid config fails clearly
- presets expand into normalized requests
- tests cover config edge cases

### Phase 2: Safety Policy

Status: complete.

Tasks:

- path allow/deny matcher
- default deny categories
- safety profiles
- read/write policy checks
- worktree requirement checks
- source-boundary metadata model
- structured safety refusal errors

Exit criteria:

- `codex_work` cannot run without allowed paths and worktree isolation
- secrets/token/deploy/hook-sensitive paths are denied by default
- tests cover path traversal and glob edge cases

### Phase 3: Result Contract

Status: complete.

Tasks:

- `SidecarResult` schema
- finding/risk/reference/test/cost types
- confidence and evidence basis model
- JSON contract tests
- prose summary generation boundary
- structured error schema

Exit criteria:

- every workflow can return stable JSON without App Server integration
- downstream tools can consume results without parsing text

### Phase 4: CLI

Status: complete for dry-run, diagnostics, and read-only App Server execution.

Tasks:

- `review`, `explore`, `work`, `opinion`, `risk-check`
- `--project`
- `--config`
- `--preset`
- `--json`
- `--dry-run`
- diagnostics command
- print normalized request in dry-run mode

Exit criteria:

- CLI can validate and shape requests locally
- read-only commands run without write permissions
- write command refuses unsafe state
- read-only commands can complete through Codex App Server

### Phase 5: MCP Server

Status: descriptor/schema scaffold complete.

Tasks:

- MCP tool descriptors
- input schemas
- output schemas
- read-only vs write-capable tool separation
- explicit opt-in for `codex_work`
- structured MCP errors for safety refusals

Exit criteria:

- Claude Code can call read-only tools safely
- `codex_work` requires explicit project config and allowed paths

### Phase 6: Codex App Server Integration

Status: read-only execution path started and locally smoke-tested. App Server
command, newline-delimited stdio framing, initialize, thread/start, turn/start,
completion waiting, and basic assistant-message normalization are implemented
in `packages/core`.

Tasks:

- process lifecycle: started
- initialize handshake: implemented
- session creation: implemented for local `thread/start`
- request/event protocol adapter: started
- read-only workflow execution: started and `explore` smoke passed
- cancellation/timeout handling
- raw event logging
- normalized completion result: final assistant text is captured as `summary`

Exit criteria:

- read-only workflows can complete through App Server
- failures preserve useful diagnostics
- protocol-specific code stays inside `packages/core`

### Phase 7: Worktree Execution

Status: lifecycle helpers started. Worktree planning, creation, status
collection, removal, and path-policy verification helpers exist; Codex execution
inside the worktree is not wired yet.

Tasks:

- create isolated worktree
- enforce path policy inside worktree
- collect changed files
- run configured tests
- return patch summary
- never auto-merge

Exit criteria:

- `codex_work` produces reviewable changes in a separate worktree
- active working tree is untouched

### Phase 8: Ecosystem Adapters

Tasks:

- define adapter input contracts
- add optional context blocks for Relay, Throughline, Caveat, SmartClaude, and
  CodeGraph
- add safety profiles based on existing repo families
- add fixture projects
- coordinate first-class Codex support in Throughline and Caveat in their own
  repositories when adapter limits are reached
- keep generic mode independent from adapter packages

Exit criteria:

- ecosystem context can enrich prompts without hard runtime coupling
- generic mode remains clean and useful

### Phase 9: Integration And Release

Tasks:

- integration tests
- JSON contract snapshots
- examples
- README quickstart
- publish/package strategy

Exit criteria:

- generic user can install and run
- kitepon-rgb projects can opt in with thin config
- docs explain both paths clearly

## Related Docs

- [../../README.md](../../README.md): project overview and repository layout.
- [../../AGENTS.md](../../AGENTS.md): working instructions for Codex and future agents.
- [../README.md](../README.md): current docs index.
- [../TODO.md](../TODO.md): durable task list and linked GitHub issues.
- [../CODEX_MODEL_POLICY_TODO.md](../CODEX_MODEL_POLICY_TODO.md): explicit Codex model policy plan and task list.
- [../ARCHITECTURE.md](../ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [../PROTOCOL.md](../PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
