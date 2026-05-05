# Throughline: Claude And Codex Dual Support

This note is meant to be pasted into the Throughline repository as the implementation brief for making Throughline work well with both Claude Code and Codex.

## Goal

Throughline should become agent-neutral handoff and context compression infrastructure.

It should keep protecting Claude Code transcript and handoff behavior, while also producing compact context that Codex can consume through `codex-sidecar`.

The desired shape is:

- Throughline core remains independent of any single agent.
- Claude transcript support remains first-class and stable.
- Codex support is added through an adapter that emits `throughline_handoff` context blocks.
- Existing Claude handoff behavior must not be broken.

## Priority Order

1. Shift background Claude subagent work used by this project to Codex sidecar where appropriate.
2. Then make Throughline itself usable from both Claude and Codex.

Do not begin by replacing Claude transcript handling. Begin by identifying independent background tasks that can be delegated to Codex for review, risk-checking, or second-pass interpretation.

## Architecture Direction

Separate the project into these conceptual layers:

| Layer | Responsibility |
|---|---|
| Agent-neutral core | handoff records, compression outputs, references, persistence, validation |
| Claude adapter | Claude Code transcript parsing, tool I/O assumptions, Claude handoff commands |
| Codex adapter | `throughline_handoff` context blocks, `codex-sidecar` request shaping, result capture |
| Shared fixtures | handoff examples and expected outputs for Claude and Codex adapters |

Do not make the Codex path parse Claude internals unless that is explicitly the adapter's job. The core should deal in stable handoff objects.

## Codex Sidecar Integration

For Codex, Throughline should produce plain JSON context blocks that match the `codex-sidecar` contract:

```json
{
  "kind": "throughline_handoff",
  "source": "throughline",
  "trust": "local",
  "summary": "Compressed handoff summary for the next agent pass.",
  "references": [
    {
      "path": "docs/handoff.md",
      "line": 18,
      "label": "handoff source"
    }
  ],
  "data": {
    "sessionId": "optional-session-id",
    "intent": "continue implementation",
    "constraints": ["preserve Claude transcript contract"]
  }
}
```

Codex-facing workflows should use these blocks for:

- `codex_explore`: answer a repo question with previous handoff context.
- `codex_review`: review current changes using the last handoff as intent.
- `codex_opinion`: challenge a plan captured in a handoff.
- `codex_risk_check`: inspect risky areas mentioned by the handoff.
- `codex_work`: continue a small scoped task in an isolated worktree.

## Protect Claude Behavior

Before changing code, identify and document the current Claude contract:

- transcript file shape
- tool input/output parsing assumptions
- compaction format
- handoff markdown or JSON schema
- command names and arguments
- resume behavior
- tests or fixtures that prove Claude sessions still work

Do not rename existing Claude-facing fields just to make Codex cleaner. Add a Codex adapter projection instead.

## Background Subagent Shift

When Throughline currently uses background Claude subagents for summarization audit, handoff review, continuity checking, or risk analysis, prefer Codex sidecar if the task can be independent of Claude's active conversation.

Good Codex sidecar candidates:

- review whether a handoff is actionable
- identify missing assumptions in a handoff
- risk-check a handoff before continuing work
- explore referenced files and verify a handoff claim
- implement a tiny handoff fixture or docs fix in a worktree

Keep Claude as primary when the task requires live Claude transcript semantics that Codex should not infer.

## Concern: Codex Calling Codex

If the user is running Throughline from Claude, the shape is useful:

```text
Claude primary -> Throughline -> codex-sidecar -> Codex second opinion
```

If the user is running Throughline from Codex, avoid blindly doing this:

```text
Codex primary -> Throughline -> codex-sidecar -> Codex again
```

Codex-on-Codex is only useful when the sidecar has a different boundary:

- it runs from an isolated worktree
- it produces a durable `SidecarResult`
- it writes raw App Server logs needed for diagnosis
- it uses a critic/reviewer/risk-analyst prompt role
- it is explicitly requested as a second independent pass

If there is no distinct boundary, Throughline should let the current Codex session consume the handoff directly instead of delegating to another Codex.

Recommended policy:

| Host agent | Sidecar choice |
|---|---|
| Claude | Prefer Codex sidecar for independent review, risk, exploration, and scoped continuation |
| Codex | Use Codex sidecar only for isolation, structured result capture, or explicit second-pass review |
| Unknown / automation | Require explicit config, not implicit recursion |

## Implementation Checklist

- Audit existing Claude transcript and handoff contracts.
- Add tests that lock current Claude behavior before changing adapters.
- Add a stable handoff object if one does not already exist.
- Add a Throughline-to-`SidecarContextBlock` conversion path for `throughline_handoff`.
- Add fixture snapshots for Codex context blocks.
- Add docs showing Claude primary and Codex primary modes.
- Add host-agent detection or explicit config to avoid Codex-on-Codex recursion.
- Add a read-only `codex-sidecar` smoke using a sample handoff.

## Done Definition

Throughline is dual-supported when:

- existing Claude transcript/handoff behavior still passes
- Codex can receive `throughline_handoff` context blocks
- Codex can return structured results that Throughline can store or link
- Codex primary mode does not recursively delegate without a real boundary
- docs explain when to use Claude, current Codex, or Codex sidecar
