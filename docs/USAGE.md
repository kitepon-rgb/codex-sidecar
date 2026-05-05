# Usage

This guide shows how to call `codex-sidecar` from the CLI, from MCP handlers,
and from ecosystem tools that want to reuse raw logs or structured results.

`codex-sidecar` always loads a project-local `.codex-sidecar.yml`, normalizes
the request, runs the relevant workflow, and returns one `SidecarResult` JSON
object. Read-only workflows run directly through Codex App Server. `codex_work`
runs Codex App Server inside an isolated git worktree.

## Install And Build

From this repository:

```bash
corepack pnpm install
corepack pnpm build
```

During local development, call the built CLI directly:

```bash
node packages/cli/dist/index.js diagnostics --project /path/to/project
```

If the repository is used through scripts or an MCP server, keep the same
package manager path. This project expects `corepack pnpm`, not a different
package manager.

## Project Config

Every consuming repository needs a `.codex-sidecar.yml` at its project root, or
the caller must pass another config filename with `--config` or `configFile`.

Minimal generic config:

```yaml
project: example-project

defaults:
  readonly: true
  result_format: json

safety_profile: generic

allowed_paths:
  - src/
  - docs/
  - tests/

deny_paths:
  - .env
  - .env.*
  - "**/*.key"
  - "**/*.pem"

presets:
  review:
    workflow: review
    readonly: true
    prompt: "Review this change for regressions and missing tests."
  explore:
    workflow: explore
    readonly: true
    prompt: "Answer with codebase evidence and file references."
  work:
    workflow: work
    readonly: false
    require_worktree: true
    prompt: "Implement a small scoped change within allowed_paths."
```

Use `diagnostics` before the first real run. It resolves presets, safety
profile deny patterns, path policies, timeouts, and worktree settings without
calling Codex:

```bash
node packages/cli/dist/index.js diagnostics \
  --project /path/to/project \
  --preset review
```

Example diagnostic output shape:

```json
{
  "status": "ok",
  "configFile": ".codex-sidecar.yml",
  "projectRoot": "/path/to/project",
  "normalizedRequest": {
    "workflow": "review",
    "projectRoot": "/path/to/project",
    "readonly": true,
    "requireWorktree": false,
    "allowedPaths": ["src/", "docs/", "tests/"],
    "denyPaths": [".env", ".env.*", "**/*.key", "**/*.pem"],
    "safetyProfile": "generic",
    "resultFormat": "json",
    "turnTimeoutMs": 600000,
    "interruptOnTimeout": true,
    "preserveWorktree": true,
    "dryRun": true
  }
}
```

## CLI Workflows

The CLI shape is:

```bash
codex-sidecar <review|explore|work|opinion|risk-check|diagnostics> [options] [prompt]
```

Current local development command:

```bash
node packages/cli/dist/index.js <workflow> [options] [prompt]
```

Options:

- `--project <dir>`: target project root. Defaults to the current directory.
- `--config <file>`: config filename relative to `projectRoot`. Defaults to
  `.codex-sidecar.yml`.
- `--preset <name>`: named preset from config.
- `--dry-run`: normalize and safety-check without calling Codex.
- `--turn-timeout-ms <ms>`: maximum App Server turn wait time.
- `--no-interrupt-on-timeout`: do not send `turn/interrupt` after timeout.
- `--remove-worktree`: delete the isolated worktree after `codex_work`.
- `--json`: accepted for explicitness; output is always JSON.

Read-only review:

```bash
node packages/cli/dist/index.js review \
  --project /path/to/project \
  --preset review \
  "Review the current diff for regression risks and missing tests."
```

Codebase exploration:

```bash
node packages/cli/dist/index.js explore \
  --project /path/to/project \
  --preset explore \
  "Find where OAuth callback errors are normalized and cite files."
```

Design second opinion:

```bash
node packages/cli/dist/index.js opinion \
  --project /path/to/project \
  "Challenge this plan before we wire the new MCP tool."
```

Focused risk check:

```bash
node packages/cli/dist/index.js risk-check \
  --project /path/to/project \
  "Focus on secrets, OAuth token storage, hooks, Docker, and CI."
```

Scoped work in an isolated worktree:

```bash
node packages/cli/dist/index.js work \
  --project /path/to/project \
  --preset work \
  --turn-timeout-ms 300000 \
  "Add a focused regression test for the parser. Only touch tests/parser.test.ts."
```

`codex_work` preserves the isolated worktree by default so a human or caller can
inspect the diff. Use `--remove-worktree` for smoke tests or disposable runs:

```bash
node packages/cli/dist/index.js work \
  --project /path/to/project \
  --preset work \
  --remove-worktree \
  "Create docs/codex-work-smoke.md with one short smoke-test sentence."
```

## MCP Tools

`packages/mcp` exposes five tool descriptors backed by the same core execution
path as the CLI:

- `codex_review`
- `codex_explore`
- `codex_work`
- `codex_opinion`
- `codex_risk_check`

Common input fields:

```json
{
  "projectRoot": "/path/to/project",
  "configFile": ".codex-sidecar.yml",
  "preset": "review",
  "prompt": "Review this branch for missing tests.",
  "dryRun": false,
  "turnTimeoutMs": 600000,
  "interruptOnTimeout": true
}
```

`codex_work` requires explicit write opt-in:

```json
{
  "projectRoot": "/path/to/project",
  "preset": "work",
  "prompt": "Implement the smallest safe fix inside src/.",
  "allowWork": true,
  "preserveWorktree": true,
  "turnTimeoutMs": 300000
}
```

If `allowWork` is omitted or not `true`, the handler returns a structured
`SAFETY_REFUSAL` result. This is intentional: MCP clients must make
write-capable sidecar execution visible in their own UI or automation policy.

MCP call result shape:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"status\": \"ok\"\n}"
    }
  ],
  "structuredContent": {
    "status": "ok",
    "workflow": "explore",
    "summary": "..."
  },
  "isError": false
}
```

Downstream tools should consume `structuredContent`, not parse the text copy.

## Worktree Behavior

`codex_work` never lets Codex edit the active working tree directly. The runner:

1. Plans a temporary git worktree from the active project root.
2. Runs `git worktree add --detach <worktreePath> HEAD`.
3. Calls Codex App Server with `projectRoot` set to the isolated worktree.
4. Collects `git status --porcelain=v1` from the worktree.
5. Enforces `allowed_paths` and `deny_paths` against changed files.
6. Returns `changedFiles`, `worktreePath`, and `worktreePreserved`.
7. Removes the worktree only when `preserveWorktree` is `false`.

Successful `codex_work` result excerpt:

```json
{
  "status": "ok",
  "workflow": "work",
  "summary": "Added the requested regression test.",
  "changedFiles": ["tests/parser.test.ts"],
  "worktreePath": "/tmp/project-codex-sidecar-AbCd12",
  "worktreePreserved": true,
  "tests": [
    {
      "command": "corepack pnpm test -- tests/parser.test.ts",
      "status": "passed",
      "summary": "Parser regression test passed."
    }
  ],
  "risks": []
}
```

If Codex changes a denied path, the result is `failed` with
`error.code = "SAFETY_REFUSAL"` and includes `changedFiles` when available. The
worktree is preserved by default for inspection.

## Raw App Server Logs

Every App Server run creates one JSONL file. The default location is:

```text
<projectRoot>/.codex-sidecar/logs/app-server/
```

`SidecarResult.rawEventLogRef` points to the local file:

```json
{
  "status": "ok",
  "workflow": "explore",
  "rawEventLogRef": "/path/to/project/.codex-sidecar/logs/app-server/2026-05-05T100644502Z-explore-627b019b.jsonl"
}
```

Each JSONL line has this shape:

```json
{
  "timestamp": "2026-05-05T10:06:44.502Z",
  "category": "lifecycle",
  "event": "turn/wait-completion",
  "data": {
    "threadId": "thread-id",
    "turnId": "turn-id",
    "turnTimeoutMs": 600000
  }
}
```

Categories:

- `lifecycle`: runner startup, initialize, thread, turn, wait, interruption.
- `protocol`: raw inbound/outbound App Server messages and retained
  notifications.
- `stderr`: App Server stderr chunks.
- `diagnostic`: timeout, wait errors, retained state, process exits, run errors.

The log directory is git-ignored because logs can include prompts, local paths,
and raw diagnostics. Treat `rawEventLogRef` as a local debugging artifact, not a
portable public report.

## Structured Result Contract

All workflows return `SidecarResult` JSON. Common fields:

```json
{
  "status": "ok",
  "workflow": "review",
  "summary": "No blocking regressions found.",
  "confidence": {
    "level": "medium",
    "rationale": "The review inspected the changed files but did not run tests."
  },
  "recommendedNextAction": "Run the relevant package tests before merging.",
  "openQuestions": [],
  "fileReferences": [
    {
      "path": "packages/core/src/requests.ts",
      "line": 42,
      "label": "request execution boundary"
    }
  ],
  "sourceBoundaries": [
    {
      "label": "local repository",
      "source": "/path/to/project",
      "trust": "local"
    }
  ],
  "rawEventLogRef": "/path/to/project/.codex-sidecar/logs/app-server/..."
}
```

Workflow-specific fields:

- `review`: `findings`, `missingTests`, `residualRisks`.
- `explore`: answer in `summary`, citations in `fileReferences`.
- `opinion`: `recommendation`, `objections`, `assumptions`, `failureModes`.
- `risk-check`: `risks`.
- `work`: `changedFiles`, `tests`, `risks`, `worktreePath`,
  `worktreePreserved`.

Finding example:

```json
{
  "severity": "medium",
  "title": "Timeout path lacks regression coverage",
  "detail": "The new timeout branch returns APP_SERVER_TIMEOUT, but no test covers interruptOnTimeout=false.",
  "file": "packages/core/src/app-server-runner.ts",
  "line": 72,
  "confidence": {
    "level": "medium"
  },
  "basis": "observed"
}
```

Risk example:

```json
{
  "severity": "high",
  "title": "Token store path is reachable",
  "detail": "The requested work would touch an OAuth token store unless deny_paths blocks it.",
  "affectedFiles": [
    {
      "path": ".oauth/tokens.sqlite"
    }
  ],
  "suggestedVerification": "Confirm the safety profile denies SQLite auth/token stores.",
  "confidence": {
    "level": "high"
  },
  "basis": "observed"
}
```

Failure result excerpt:

```json
{
  "status": "failed",
  "workflow": "explore",
  "summary": "APP_SERVER_TIMEOUT: App Server turn timed out after 300000ms",
  "confidence": {
    "level": "unknown"
  },
  "recommendedNextAction": "Inspect rawEventLogRef and retry with a narrower prompt or longer timeout.",
  "error": {
    "code": "APP_SERVER_TIMEOUT",
    "message": "APP_SERVER_TIMEOUT: App Server turn timed out after 300000ms for thread=... turn=...",
    "data": {
      "rawEventLogRef": "/path/to/project/.codex-sidecar/logs/app-server/..."
    }
  }
}
```

Callers should branch on `status` and `error.code`, then use workflow-specific
fields. They should not infer success from prose.

## Ecosystem Adapter Notes

Tools such as Caveat, Throughline, Spotter, Relay, or SmartClaude can call the
CLI or MCP handlers without importing their internal project models. Use plain
JSON context blocks when passing external memory or handoff data into core:

```json
{
  "kind": "throughline_handoff",
  "source": "Throughline issue #1",
  "trust": "local",
  "summary": "The previous Claude Code session identified the parser boundary as the next review target.",
  "references": [
    {
      "path": "docs/handoff.md",
      "line": 12,
      "label": "handoff summary"
    }
  ]
}
```

Known context block kinds:

- `relay_entry`
- `throughline_handoff`
- `caveat_entry`
- `smartclaude_cost_hint`
- `codegraph_context`
- `manual_note`

Practical integration pattern:

1. The consuming tool selects a workflow and prompt.
2. It passes a project root, preset, and optional context blocks.
3. `codex-sidecar` returns `SidecarResult`.
4. The consuming tool stores `summary`, structured findings/risks, file
   references, changed files, and `rawEventLogRef`.
5. For `codex_work`, the consuming tool reviews the preserved worktree before
   applying or cherry-picking changes.

## Verification Commands

Before publishing changes to this repository:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

For a consuming repository, start with:

```bash
node /path/to/codex-sidecar/packages/cli/dist/index.js diagnostics \
  --project /path/to/consumer \
  --preset review
```

Then run the smallest read-only smoke:

```bash
node /path/to/codex-sidecar/packages/cli/dist/index.js explore \
  --project /path/to/consumer \
  "Return a one-sentence summary of this repository using file references."
```
