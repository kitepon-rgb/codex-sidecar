# Caveat: Claude And Codex Dual Support

This note is meant to be pasted into the Caveat repository as the implementation brief for making Caveat work well with both Claude Code and Codex.

## Goal

Caveat should become agent-neutral memory infrastructure.

It should keep working for Claude exactly as it does today, while also exposing repo-specific gotchas, traps, caveats, and verification hints to Codex through `codex-sidecar`.

The desired shape is:

- Caveat core remains independent of any single agent.
- Claude integration remains first-class.
- Codex integration is added as an adapter, not as a rewrite.
- Existing Claude commands, hooks, markdown formats, and workflows must not be broken.

## Priority Order

1. Shift background Claude subagent work used by this project to Codex sidecar where appropriate.
2. Then make Caveat itself usable from both Claude and Codex.

This means the first step is not "rewrite Caveat for Codex." The first step is to identify background agent tasks currently delegated to Claude and route suitable second-opinion, review, risk-check, and scoped-work tasks through `codex-sidecar`.

If the runtime environment does not have usable Codex support, keep the current Claude subagent behavior unchanged. Do not remove or degrade the existing Claude path just because a Codex adapter exists.

## Architecture Direction

Separate the project into these conceptual layers:

| Layer | Responsibility |
|---|---|
| Agent-neutral core | Caveat entries, markdown-in-git storage, parsing, lookup, indexing, validation |
| Claude adapter | Claude Code commands, hooks, transcript assumptions, Claude-facing prompts |
| Codex adapter | `caveat_entry` context blocks, `codex-sidecar` request shaping, structured result handling |
| Shared fixtures | Example caveat entries and expected outputs consumed by both adapters |

Do not fork the whole app into "Claude Caveat" and "Codex Caveat." Keep one Caveat core with multiple agent adapters.

## Codex Sidecar Integration

For Codex, Caveat should produce plain JSON context blocks that match the `codex-sidecar` contract:

```json
{
  "kind": "caveat_entry",
  "source": "caveat",
  "trust": "local",
  "summary": "Short gotcha or repository-specific warning.",
  "references": [
    {
      "path": "docs/caveats/example.md",
      "line": 12,
      "label": "source caveat"
    }
  ],
  "data": {
    "tags": ["oauth", "mcp", "secrets"],
    "severity": "high"
  }
}
```

Codex-facing workflows should use these blocks for:

- `codex_review`: include relevant caveats before reviewing a diff.
- `codex_explore`: include caveats as local memory while answering codebase questions.
- `codex_risk_check`: include high-severity caveats for OAuth, MCP, secrets, hooks, Docker, CI, and deploy surfaces.
- `codex_work`: include caveats but keep writes inside the sidecar worktree.

## Protect Claude Behavior

Before changing code, identify and document the current Claude contract:

- command names and command arguments
- hook inputs and outputs
- markdown entry format
- file naming conventions
- expected frontmatter fields
- transcript or tool-output assumptions
- tests or fixtures that represent Claude behavior

Any Codex work must be additive unless there is an explicit migration plan.

If a field name is currently read by Claude, do not rename it for Codex. Add a new adapter output instead.

## Background Subagent Shift

When Caveat currently asks a background Claude subagent to inspect memory, audit entries, review changes, or risk-check a repo, prefer routing that task through `codex-sidecar` when the task is naturally independent.

Good Codex sidecar candidates:

- second opinion on a proposed caveat
- risk check against known caveats
- read-only review of caveat entry changes
- worktree-backed cleanup of small formatting or fixture issues
- structured extraction of caveats into context blocks

Keep Claude as the primary orchestrator when the task depends on Claude-specific transcript context or active conversation state.

## Concern: Codex Calling Codex

If the user is running Caveat from Claude, the shape is useful:

```text
Claude primary -> Caveat -> codex-sidecar -> Codex second opinion
```

If the user is running Caveat from Codex, avoid blindly doing this:

```text
Codex primary -> Caveat -> codex-sidecar -> Codex again
```

Codex-on-Codex is only useful when the sidecar has a clearly different boundary:

- isolated git worktree for `codex_work`
- read-only review or risk check with structured output
- different prompt role, such as critic, reviewer, or risk analyst
- different model/profile/cost policy
- durable raw event log and `SidecarResult` needed by the app

If there is no distinct boundary, Caveat should not call Codex sidecar just to get "another Codex." In that case, use the current Codex session directly and record results through the normal Caveat flow.

Recommended policy:

| Host agent | Sidecar choice |
|---|---|
| Claude | Prefer Codex sidecar for independent review, risk, exploration, and scoped work |
| Codex | Use Codex sidecar only for isolation, structured result, worktree execution, or explicit second-pass review |
| Unknown / automation | Require explicit config: `sidecar_agent: codex`, `disabled`, or future `auto` |

Availability policy:

| Codex availability | Behavior |
|---|---|
| `unavailable` | `codex-sidecar` is not present, not executable, not configured for this repo, or fails diagnostics. Keep the existing Claude subagent path |
| `configured` | `codex-sidecar diagnostics --project <repo>` succeeds. It is safe to use request shaping, dry-runs, docs, and planned read-only integration |
| `operational` | A read-only smoke such as `codex_explore` succeeds. Use it for approved review, explore, opinion, and risk-check sidecar tasks |
| `work-capable` | `codex_work` smoke succeeds and allowed paths are configured. Use worktree-backed scoped edits |
| explicitly disabled | Keep the existing Claude subagent path |

This is not a hidden fallback to a different behavior. It is the compatibility mode: the current Claude-backed behavior remains the baseline when Codex cannot be used.

The minimum practical definition of "Codex is available" is not merely that a `codex` binary exists. It is that `codex-sidecar` exists and can successfully run diagnostics for the target repository. If `codex-sidecar` is absent, Caveat must treat Codex as unavailable.

Preferred health check:

```bash
codex-sidecar diagnostics --project <repo> --preset review
```

Development-path health check:

```bash
node /home/kite/projects/codex-sidecar/packages/cli/dist/index.js diagnostics \
  --project <repo> \
  --preset review
```

## Implementation Checklist

- Audit existing Claude commands, hooks, schemas, and fixtures.
- Add tests that lock current Claude behavior before changing adapters.
- Add a Caveat-to-`SidecarContextBlock` conversion path for `caveat_entry`.
- Add fixture snapshots for Codex context blocks.
- Add docs showing how Claude and Codex consume the same Caveat entry.
- Add an execution policy that avoids unnecessary Codex-on-Codex recursion.
- Add a Codex availability check before shifting any background Claude subagent task: absent sidecar or failed diagnostics means Claude subagent compatibility mode.
- Add a smoke path using `codex-sidecar` read-only workflow.
- Keep `codex_work` changes inside isolated worktrees and require allowed paths.

## Done Definition

Caveat is dual-supported when:

- existing Claude workflows still pass unchanged
- Codex can receive relevant `caveat_entry` context blocks
- Codex results can be stored or referenced without prose scraping
- host-agent policy prevents accidental recursive Codex delegation
- Codex-unavailable environments still use the existing Claude subagent behavior
- docs explain Claude primary, Codex primary, and automation modes
