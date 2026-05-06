# Codex Model Policy TODO

This document is the implementation plan and task list for explicit model
selection in `codex-sidecar` and its consuming repositories, especially Caveat.

## Goal

`codex-sidecar` should stop relying only on the caller's global Codex default
model when the consuming project has a clear workload policy. A repository
should be able to declare which Codex model and reasoning effort each sidecar
preset uses, and CLI/MCP callers should be able to override that policy
explicitly.

The first target consumer is Caveat:

- automatic hook advisory should be cheap and responsive;
- explicit review, risk, opinion, and work sessions should preserve quality;
- diagnostics should show the resolved model so hidden fallback cannot happen.

## Proposed Defaults

Use these as the initial Caveat policy unless newer measurement disproves them:

| Workload | Model | Reasoning effort | Rationale |
| --- | --- | --- | --- |
| automatic hook advisory | `gpt-5.4-mini` | `low` or `medium` | Short structured second opinion; hook path should be responsive and cost-aware. |
| smoke turns | `gpt-5.4-mini` | `low` | Proves App Server wiring, not deep reasoning. Diagnostics should display policy without starting a model turn. |
| manual explore | `gpt-5.4-mini` | `medium` | Codebase evidence lookup and concise answers. |
| review / risk-check / opinion | `gpt-5.5` | `medium` or `high` | Higher judgment value and lower frequency. |
| isolated work | `gpt-5.5` | `high` | Small edits still need robust planning, tests, and safety. |
| long-horizon agentic coding | explicit `gpt-5.3-codex` | caller-chosen | Use only when the caller intentionally wants Codex-specialized long-running coding behavior. |

Do not hardcode these in generic core. They belong in consuming repo config,
presets, or caller options.

## Configuration Shape

Extend `.codex-sidecar.yml` with optional model policy fields at both defaults
and preset level:

```yaml
defaults:
  model: gpt-5.4-mini
  model_reasoning_effort: medium

presets:
  advisory:
    workflow: explore
    readonly: true
    model: gpt-5.4-mini
    model_reasoning_effort: low
    prompt: "Return concise Caveat next-step advice."

  risk:
    workflow: risk-check
    readonly: true
    model: gpt-5.5
    model_reasoning_effort: high
```

Resolution order:

1. CLI/MCP explicit option
2. preset-level value
3. `defaults` value

Only explicit sidecar policy participates in request normalization. If no model
is resolved from CLI/MCP, preset, or defaults, `SidecarRequest.model` stays
undefined and Codex may inherit config from the isolated `CODEX_HOME` as it does
today. Diagnostics must distinguish explicit sidecar policy from inherited Codex
configuration so callers can tell whether sidecar actually selected a model.

## Sidecar Tasks

- [x] Add `model?: string` and `modelReasoningEffort?: string` to
  `SidecarRequest`.
- [x] Add `model?: string` and `model_reasoning_effort?: string` to
  `SidecarDefaults` and `SidecarPreset`.
- [x] Validate model policy fields in `packages/core/src/config.ts`.
  - `model` must be a non-empty string when present.
  - `model_reasoning_effort` should initially accept `low`, `medium`, `high`,
    and `xhigh`; omit it when no explicit effort should be set.
- [x] Resolve model policy in `normalizeSidecarRequest`.
- [x] Preserve model fields in error-path `SidecarRequest` construction.
- [x] Add CLI flags:
  - `--model <model>`
  - `--model-reasoning-effort <effort>`
- [x] Add MCP schema fields for the same options.
- [x] Pass resolved values to Codex App Server startup with config overrides:
  - `-c model="<model>"`
  - `-c model_reasoning_effort="<effort>"`
- [x] Include resolved model policy in lifecycle logs and `normalizedRequest`.
- [x] Add diagnostics metadata that reports whether the model policy is
  `explicit` or inherited from Codex config.
- [x] Keep isolated `CODEX_HOME` passthrough for inherited config, but ensure
  explicit sidecar config wins over inherited config.
- [x] Update README / USAGE examples once behavior is implemented.

## Caveat Tasks

- [ ] Add a Caveat-specific `advisory` preset to `.codex-sidecar.yml`.
- [ ] Set Caveat automatic hook advisory to use `--preset advisory` instead of
  sharing the human `explore` preset.
- [ ] Set Caveat manual presets approximately as:
  - `explore`: `gpt-5.4-mini`, `medium`
  - `review`: `gpt-5.5`, `medium`
  - `opinion`: `gpt-5.5`, `medium`
  - `risk`: `gpt-5.5`, `high`
  - `work`: `gpt-5.5`, `high`
- [ ] Update `caveat codex-sidecar diagnostics` output expectations if
  normalized request snapshots include model policy.
- [ ] Add a smoke note that verifies the App Server log reports the intended
  model for the advisory preset.

## Tests

- [x] Config parser accepts defaults and preset model policy.
- [x] Config parser rejects empty model and invalid effort.
- [x] Request normalization applies CLI > preset > defaults for explicit policy,
  and leaves model fields undefined when policy is inherited.
- [x] `buildAppServerCommand` appends model config only when explicit policy is
  resolved.
- [x] CLI dry-run / diagnostics includes `model`, `modelReasoningEffort`, and
  model policy source.
- [x] MCP request path preserves model overrides.
- [x] Worktree runner preserves model policy when rewriting `projectRoot` to the
  isolated worktree path.
- [x] Existing behavior remains unchanged when no model policy is configured.

## Decisions And Open Questions

- Resolved: sidecar config uses Codex config spelling
  `model_reasoning_effort`; TypeScript request objects use
  `modelReasoningEffort`.
- Should `advisory` become a first-class workflow, or remain an `explore`
  preset? Initial plan: keep it as an `explore` preset to avoid widening the
  stable workflow enum.
- Should sidecar record the actually reported model from `thread/start` in
  `SidecarResult`? Initial plan: yes, but as a follow-up field after the config
  path is working.

## Done Criteria

- [x] A consuming repo can select model per preset without editing global
  `~/.codex/config.toml`.
- [x] `codex-sidecar diagnostics` shows explicit resolved model policy for a
  configured preset or CLI override.
- [x] Real App Server logs prove the intended model was used.
- [x] Caveat automatic hook advisory uses `gpt-5.4-mini` through an explicit sidecar
  preset, not by relying on global Codex defaults.

Verified on 2026-05-06 with Caveat hook advisory smoke:
`rawEventLogRef` recorded App Server startup args containing
`model="gpt-5.4-mini"` and `model_reasoning_effort="low"`, and the
`thread/start` response reported `model: "gpt-5.4-mini"` and
`reasoningEffort: "low"`.

## Related Docs

- [../README.md](../README.md): project overview and repository layout.
- [../AGENTS.md](../AGENTS.md): working instructions for Codex and future agents.
- [README.md](README.md): docs index and archive map.
- [TODO.md](TODO.md): durable task list and linked GitHub issues.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
- [USAGE.md](USAGE.md): CLI, MCP handler, worktree, raw log, and structured result examples.
