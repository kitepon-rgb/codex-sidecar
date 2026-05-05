# Spotter: Claude And Codex Dual Support

This note is meant to be pasted into the Spotter repository as the implementation brief for making Spotter work well with both Claude Code and Codex.

## Goal

Spotter should become agent-neutral detection and reporting infrastructure.

It should keep working in Claude-oriented workflows, while also letting Codex consume Spotter findings as structured context and return machine-readable risk or review results through `codex-sidecar`.

The desired shape is:

- Spotter core remains independent of any single agent.
- Claude integration remains first-class.
- Codex integration is added as an adapter and execution option.
- Existing Claude commands, report formats, hooks, and prompts must not be broken.

## Priority Order

1. Shift background Claude subagent work used by this project to Codex sidecar where appropriate.
2. Then make Spotter itself usable from both Claude and Codex.

This means the first task is to identify background agent roles that are naturally independent: audit, risk-check, second-pass review, or scoped verification. Those are good Codex sidecar candidates.

If the runtime environment does not have usable Codex support, keep the current Claude subagent behavior unchanged. Do not remove or degrade the existing Claude path just because a Codex adapter exists.

## Architecture Direction

Separate the project into these conceptual layers:

| Layer | Responsibility |
|---|---|
| Agent-neutral core | scan inputs, detectors, findings, severity, references, reports |
| Claude adapter | Claude-facing commands, hooks, prompts, report rendering |
| Codex adapter | context blocks for `codex_risk_check`, `codex_review`, and `codex_explore`; structured result handling |
| Shared fixtures | scan fixtures and expected reports consumed by both adapters |

Do not fork Spotter into separate Claude and Codex implementations. Keep one detector/reporting core with multiple agent adapters.

## Codex Sidecar Integration

Spotter can pass findings to Codex as plain JSON context blocks. If no more specific kind exists, use `manual_note` or `codegraph_context` until a dedicated Spotter context kind is introduced.

Example:

```json
{
  "kind": "manual_note",
  "source": "spotter",
  "trust": "local",
  "summary": "Spotter found a high-risk OAuth callback surface and missing regression coverage.",
  "references": [
    {
      "path": "src/oauth/callback.ts",
      "line": 42,
      "label": "callback handler"
    }
  ],
  "data": {
    "detector": "oauth-callback-risk",
    "severity": "high",
    "ruleId": "SPOTTER-OAUTH-001"
  }
}
```

Codex-facing workflows should use Spotter findings for:

- `codex_risk_check`: turn Spotter signals into deeper risk analysis.
- `codex_review`: review a diff with Spotter findings in context.
- `codex_explore`: investigate why a detector triggered.
- `codex_opinion`: challenge a remediation plan.
- `codex_work`: make a small scoped fix in an isolated worktree when explicitly allowed.

## Protect Claude Behavior

Before changing code, identify and document the current Claude contract:

- command names and arguments
- report formats
- detector output schema
- hook behavior
- prompt templates
- markdown or JSON field names
- tests or fixtures that represent Claude behavior

Do not change Claude report shapes to satisfy Codex. Add a Codex projection.

## Background Subagent Shift

When Spotter currently asks a background Claude subagent to inspect findings, validate a detector, classify risk, or propose remediation, prefer Codex sidecar when the task is independent.

Good Codex sidecar candidates:

- second-pass risk analysis of Spotter findings
- review of detector changes
- exploration of files referenced by a finding
- small worktree-backed fixture/test fixes
- independent critique of a remediation plan

Keep Claude primary when the task depends on Claude-specific command flow or active conversation state.

## Concern: Codex Calling Codex

If the user is running Spotter from Claude, the shape is useful:

```text
Claude primary -> Spotter -> codex-sidecar -> Codex second opinion
```

If the user is running Spotter from Codex, avoid blindly doing this:

```text
Codex primary -> Spotter -> codex-sidecar -> Codex again
```

Codex-on-Codex should be used only when there is a concrete boundary:

- isolated worktree execution
- structured `SidecarResult` required by Spotter
- raw App Server logs needed for diagnostics
- a deliberately different prompt role, such as risk analyst or critic
- explicit user request for an independent second pass

If none of these apply, Spotter should expose findings to the current Codex session directly.

Recommended policy:

| Host agent | Sidecar choice |
|---|---|
| Claude | Prefer Codex sidecar for independent review, risk, exploration, and scoped fixes |
| Codex | Use Codex sidecar only for isolation, durable structured results, or explicit second-pass analysis |
| Unknown / automation | Require explicit config and do not infer recursive delegation |

Availability policy:

| Codex availability | Behavior |
|---|---|
| `unavailable` | `codex-sidecar` is not present, not executable, not configured for this repo, or fails diagnostics. Keep the existing Claude subagent path |
| `configured` | `codex-sidecar diagnostics --project <repo>` succeeds. It is safe to use request shaping, dry-runs, docs, and planned read-only integration |
| `operational` | A read-only smoke such as `codex_explore` succeeds. Use it for approved review, explore, opinion, and risk-check sidecar tasks |
| `work-capable` | `codex_work` smoke succeeds and allowed paths are configured. Use worktree-backed scoped edits |
| explicitly disabled | Keep the existing Claude subagent path |

This is not a hidden fallback to a different behavior. It is the compatibility mode: the current Claude-backed behavior remains the baseline when Codex cannot be used.

The minimum practical definition of "Codex is available" is not merely that a `codex` binary exists. It is that `codex-sidecar` exists and can successfully run diagnostics for the target repository. If `codex-sidecar` is absent, Spotter must treat Codex as unavailable.

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

- Audit existing Claude commands, reports, hooks, and fixtures.
- Add tests that lock current Claude behavior.
- Identify the stable Spotter finding schema.
- Add a Spotter-to-`SidecarContextBlock` conversion path.
- Add fixture snapshots for Codex context blocks and `SidecarResult` consumption.
- Add docs for Claude primary, Codex primary, and automation modes.
- Add execution policy to prevent unnecessary Codex-on-Codex recursion.
- Add a Codex availability check before shifting any background Claude subagent task: absent sidecar or failed diagnostics means Claude subagent compatibility mode.
- Add a `codex-sidecar` read-only smoke, ideally `codex_risk_check`.

## Done Definition

Spotter is dual-supported when:

- existing Claude workflows still pass
- Spotter findings can be consumed by Codex as structured context
- Codex risk/review results can be stored without prose scraping
- Codex primary mode avoids pointless recursive Codex delegation
- Codex-unavailable environments still use the existing Claude subagent behavior
- docs explain when Codex sidecar is useful and when direct current-agent handling is better
