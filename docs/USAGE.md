# Usage

This guide shows how to call `codex-sidecar` from the CLI, from MCP handlers,
and from ecosystem tools that want to reuse raw logs or structured results.

`codex-sidecar` always loads a project-local `.codex-sidecar.yml`, normalizes
the request, runs the relevant workflow, and returns one `SidecarResult` JSON
object. Read-only workflows run directly through Codex App Server. `codex_work`
runs Codex App Server inside an isolated git worktree. The `generate` workflow
is a read-only exception: instead of a code-review-shaped `SidecarResult`, it
returns the model's raw JSON value in the `generated` field (see
[Generate Workflow](#generate-workflow)).

## Install And Build

Install the CLI globally:

```bash
npm install -g codex-sidecar-cli
```

Install the MCP stdio server globally when a client should launch it by command:

```bash
npm install -g codex-sidecar-mcp
```

The installed `codex-sidecar-mcp` command is expected to be an npm `bin`
symlink. The server entrypoint resolves that symlink before deciding whether the
module was invoked as the executable, so distributed installs start the stdio
MCP server instead of exiting immediately.

From this repository:

```bash
corepack pnpm install
corepack pnpm build
```

After global install, call the CLI directly:

```bash
codex-sidecar diagnostics --project /path/to/project
```

During local development, the equivalent built path is:

```bash
node packages/cli/dist/index.js diagnostics --project /path/to/project
```

For MCP local development, verify the built stdio server through a symlinked
command path, not only by importing `packages/mcp/dist/server.js`. That mirrors
how npm global installs and MCP clients launch the package.

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
  # Optional: set these only when sidecar should explicitly choose Codex policy.
  # model: gpt-5.4-mini
  # model_reasoning_effort: medium

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
profile deny patterns, path policies, model policy, timeouts, and worktree
settings without calling Codex:

```bash
codex-sidecar diagnostics \
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
  },
  "modelPolicy": {
    "source": "inherited"
  }
}
```

## Model Policy

By default, `codex-sidecar` does not choose a model. The isolated `CODEX_HOME`
keeps inherited Codex model settings, while MCP servers and plugins are still
cleared for sidecar isolation.

For GPT-5.6 long-running tasks, put the following in the user-global Codex
config or in a trusted project's `.codex/config.toml`:

```toml
model_context_window = 272000
model_auto_compact_token_limit = 240000
```

From the user-global `$CODEX_HOME/config.toml`, the sidecar allowlist-copies
these two keys and the permitted top-level model keys (`model`,
`model_provider`, and `model_reasoning_effort`) into its isolated home. It
copies no TOML tables. A trusted project override follows a separate path: it
is not copied into the isolated home, and Codex discovers it from the thread
working directory. For asynchronous work, commit that override in the run's
base revision so it exists in the isolated worktree. App Server startup still
clears inherited MCP servers and plugins.

Set model policy only when the caller wants an explicit Codex App Server
override. Resolution order is CLI/MCP input, then preset, then `defaults`:

```yaml
defaults:
  model: gpt-5.4-mini
  model_reasoning_effort: medium

presets:
  risk:
    workflow: risk-check
    model: gpt-5.5
    model_reasoning_effort: high
```

CLI callers can override the resolved policy:

```bash
codex-sidecar diagnostics \
  --project /path/to/project \
  --preset risk \
  --model gpt-5.5 \
  --model-reasoning-effort high
```

When explicit policy is resolved, App Server startup receives `-c
model="<model>"` and/or `-c model_reasoning_effort="<effort>"`. When no policy
is resolved, those flags are omitted.

## CLI Workflows

The CLI shape is:

```bash
codex-sidecar <review|explore|work|opinion|risk-check|auditor|generate|diagnostics> [options] [prompt]
```

The local development equivalent is:

```bash
node packages/cli/dist/index.js <workflow> [options] [prompt]
```

Options:

- `--project <dir>`: target project root. Defaults to the current directory.
- `--config <file>`: config filename relative to `projectRoot`. Defaults to
  `.codex-sidecar.yml`.
- `--preset <name>`: named preset from config.
- `--output-contract <text>`: `generate` only. JSON output contract/schema the
  generated JSON must conform to. Injected verbatim into the generation prompt.
- `--output-contract-file <file>`: `generate` only. Read the output contract
  from a file instead of an inline string.
- `--model <model>`: explicit Codex model override for this request.
- `--model-reasoning-effort <effort>`: explicit reasoning effort override.
  Accepted values are `low`, `medium`, `high`, and `xhigh`.
- `--dry-run`: normalize and safety-check without calling Codex.
- `--turn-timeout-ms <ms>`: maximum App Server turn wait time.
- `--no-interrupt-on-timeout`: do not send `turn/interrupt` after timeout.
- `--remove-worktree`: delete the isolated worktree after `codex_work`.
- `--json`: accepted for explicitness; output is always JSON.

Read-only review:

```bash
codex-sidecar review \
  --project /path/to/project \
  --preset review \
  "Review the current diff for regression risks and missing tests."
```

Codebase exploration:

```bash
codex-sidecar explore \
  --project /path/to/project \
  --preset explore \
  "Find where OAuth callback errors are normalized and cite files."
```

Design second opinion:

```bash
codex-sidecar opinion \
  --project /path/to/project \
  "Challenge this plan before we wire the new MCP tool."
```

Focused risk check:

```bash
codex-sidecar risk-check \
  --project /path/to/project \
  "Focus on secrets, OAuth token storage, hooks, Docker, and CI."
```

Scoped work in an isolated worktree:

```bash
codex-sidecar work \
  --project /path/to/project \
  --preset work \
  --turn-timeout-ms 300000 \
  "Add a focused regression test for the parser. Only touch tests/parser.test.ts."
```

`codex_work` preserves the isolated worktree by default so a human or caller can
inspect the diff. Use `--remove-worktree` for smoke tests or disposable runs:

```bash
codex-sidecar work \
  --project /path/to/project \
  --preset work \
  --remove-worktree \
  "Create docs/codex-work-smoke.md with one short smoke-test sentence."
```

### Asynchronous Work

The existing synchronous `work` command remains available. For work that must
outlive a CLI, MCP stdio, or Claude Code process, use the durable controls:

```bash
codex-sidecar work-start --project /path/to/project --idempotency-key <caller-held-key> \
  "Implement the scoped change."
codex-sidecar work-result --project /path/to/project --idempotency-key <caller-held-key>
codex-sidecar work-cancel --project /path/to/project --idempotency-key <caller-held-key>
codex-sidecar work-recover --project /path/to/project --idempotency-key <caller-held-key>
codex-sidecar work-auth-recover --project /path/to/project --idempotency-key <caller-held-key>
```

`work-start` returns a run-control union: a `run_handle`, `run_terminal`,
`run_interrupted`, or `run_error`. `work-result` returns `run_pending`,
`run_terminal`, `run_interrupted`, or `run_error`. Keep the caller-generated
idempotency key and use it for every retry and control operation; it is the
recovery identity, not an optional label. A durable worker is detached after a
successful handoff, so a stdio disconnect or caller restart does not cancel it;
the same key can be queried later from a new CLI or MCP process.

`work-cancel` records an intent and returns an acknowledgement; read
`work-result` for the final terminal state. `work-recover --action quarantine`
and all `work-auth-recover --strategy ...` mutations require
`--confirm-no-running-processes`. Recovery never silently salvages a patch or
cleans a worktree. After an abnormal worker kill, inspect first: automatic
salvage and cleanup are disabled. If that run has no clean-shutdown evidence and
no run-local auth rotation, it can be released only after an external re-login
replaces canonical auth, using the explicit `keep-canonical-after-login`
auth-recovery strategy. A complete clean journal stranded before lease unlink
uses only the exact `release-clean` strategy.

### Generate Workflow

`generate` drives Codex App Server to produce arbitrary structured JSON for a
freeform task, instead of the code-review-shaped `SidecarResult` payload the
other workflows return. It is read-only and does not require a git worktree, but
it still loads the project `.codex-sidecar.yml` and runs with a `cwd` like every
other workflow.

```bash
codex-sidecar generate \
  --project /path/to/project \
  --output-contract '{ "items": [ { "en": "string", "ja": "string" } ] }' \
  "Write 5 short English example sentences for a beginner, each with a natural Japanese translation."
```

Contract and behavior:

- The prompt is required. A `generate` request with no prompt is refused with
  `SAFETY_REFUSAL`.
- `--output-contract` (or the `outputContract` MCP field) is optional and is
  injected verbatim into the prompt as the JSON shape the model must follow.
- codex-sidecar guarantees only that the model returned one valid JSON object or
  array, surfaced in `SidecarResult.generated`. If the model returns prose or a
  bare primitive, the result is `failed` with `error.code = "PROTOCOL_ERROR"` —
  there is no silent fallback or repair.
- Domain validation (languages, required fields, value ranges) is intentionally
  the caller's responsibility. codex-sidecar does not mutate or drop generated
  content.

Result excerpt:

```json
{
  "status": "ok",
  "workflow": "generate",
  "summary": "Codex App Server returned a JSON object with 1 top-level key(s).",
  "confidence": { "level": "medium" },
  "recommendedNextAction": "Validate the generated payload against your domain rules before persisting.",
  "generated": {
    "items": [
      { "en": "I walk to school every morning.", "ja": "私は毎朝歩いて学校に行きます。" }
    ]
  },
  "sourceBoundaries": [
    { "label": "Codex App Server", "source": "local codex app-server stdio", "trust": "generated" }
  ]
}
```

## HTTP Transport and LAN Deployment

`packages/mcp` selects its transport at startup. The default is stdio (so the
`codex-sidecar-mcp` npm bin keeps working unchanged). Setting
`CODEX_SIDECAR_MCP_TRANSPORT=http` switches to the MCP Streamable HTTP
transport so the same MCP server can run as a LAN service.

Environment variables (HTTP mode):

| Variable | Default | Notes |
|---|---|---|
| `CODEX_SIDECAR_MCP_TRANSPORT` | `stdio` | Set to `http` for the Streamable HTTP transport. |
| `CODEX_SIDECAR_MCP_HOST` | `127.0.0.1` | Bind address. Use a LAN IP for cross-host access. |
| `CODEX_SIDECAR_MCP_PORT` | `39201` | TCP port. |
| `CODEX_SIDECAR_MCP_BEARER` | unset | When set, every request must include `Authorization: Bearer <token>`. |
| `CODEX_SIDECAR_MCP_ALLOWED_HOSTS` | derived from host/port | Comma-separated DNS rebinding allowlist. **Must include both bare host and `host:port`.** |

The HTTP server exposes a single endpoint at `/mcp` and accepts `POST`
(initialize and tool calls), `GET` (server-initiated SSE stream), and `DELETE`
(session close). Sessions are stateful: the first POST without an
`mcp-session-id` header starts a session if the body is an `initialize`
request, and subsequent requests must echo the returned `mcp-session-id`
header. Non-initialize POSTs without a session id return 400.

### Docker compose (LAN sidecar)

The repository ships a `Dockerfile` and `docker-compose.yml` that build the
MCP package and bind it to a chosen LAN IP. From a clean clone on the host
that will run the sidecar:

```bash
docker compose up -d --build
docker compose logs -f --tail=50
```

The compose file parameterizes bind host, port, and host paths via env:

| Compose env | Default | Purpose |
|---|---|---|
| `CODEX_SIDECAR_BIND_HOST` | `192.168.1.2` | Host IP that the container's port is published on. Use a LAN IP, not `0.0.0.0`. |
| `CODEX_SIDECAR_PORT` | `39201` | Published TCP port. |
| `CODEX_HOME_HOST` | `/home/kite/.codex` | Host path mounted to `/root/.codex` inside the container, sharing Codex CLI auth and session state. |
| `PROJECTS_HOST` | `/home/kite/projects` | Host path mounted to `/projects`. LAN clients pass `projectRoot=/projects/<repo>` (server-side paths). |
| `CODEX_SIDECAR_MCP_ALLOWED_HOSTS` | LAN bind variants | Override when binding to a different host. |

Override via env or a sibling `.env` file:

```bash
CODEX_SIDECAR_BIND_HOST=10.0.0.5 \
PROJECTS_HOST=/srv/work \
docker compose up -d --build
```

Add a matching firewall rule. UFW example:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 39201 proto tcp \
  comment 'codex-sidecar-mcp LAN'
```

### MCP client configuration

```json
{
  "mcpServers": {
    "codex-sidecar-lan": {
      "type": "http",
      "url": "http://192.168.1.2:39201/mcp"
    }
  }
}
```

If a bearer token is enforced server-side, send it on every request:

```json
{
  "mcpServers": {
    "codex-sidecar-lan": {
      "type": "http",
      "url": "http://192.168.1.2:39201/mcp",
      "headers": {
        "authorization": "Bearer <token>"
      }
    }
  }
}
```

### Path conventions over LAN

`projectRoot` paths are interpreted by the MCP server, not the client.
With the default compose mount, LAN clients pass `projectRoot=/projects/<repo>`
to point at the host's `~/projects/<repo>`. The client machine's local path
is irrelevant. The same applies to `configFile` (relative to `projectRoot`).

### Session lifecycle (raw HTTP)

For debugging, the handshake from a shell looks like:

```bash
# Start a session.
curl -sS -D /tmp/h.txt -X POST http://192.168.1.2:39201/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"smoke","version":"0"},"capabilities":{}}}'
SESSION=$(grep -i '^mcp-session-id' /tmp/h.txt | awk '{print $2}' | tr -d '\r\n')

# Confirm the session is ready.
curl -sS -X POST http://192.168.1.2:39201/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# List tools.
curl -sS -X POST http://192.168.1.2:39201/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

### Operational commands

```bash
docker compose ps
docker compose logs -f --tail=100
docker compose restart
docker compose down                       # stop and remove container
docker compose up -d --build              # apply source changes
```

To remove every trace of the LAN deployment from a host:

```bash
docker compose down
sudo ufw delete allow from 192.168.1.0/24 to any port 39201 proto tcp
```

## MCP Tools

`packages/mcp` exposes read-only and synchronous work tools plus durable work
controls backed by the same core execution
path as the CLI:

- `codex_review`
- `codex_explore`
- `codex_work`
- `codex_opinion`
- `codex_risk_check`
- `codex_auditor`
- `codex_generate`
- `codex_work_start`
- `codex_work_result`
- `codex_work_cancel`
- `codex_work_recover`
- `codex_work_auth_recover`

The MCP server is a stdio process. Clients should launch the `codex-sidecar-mcp`
command from PATH; the package supports npm-style symlinked bin paths and does
not require clients to know the real `dist/server.js` location.

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

The async work tools use the same caller-held `idempotencyKey` as the CLI.
`codex_work_start` returns the run-control union; `codex_work_result` is the
polling endpoint; and cancel or recovery calls are explicit control operations.
Closing the stdio MCP client after `codex_work_start` does not cancel a handed-
off worker. A new stdio or HTTP MCP client can recover the run with the same
key. Quarantine and auth recovery retain the confirmation and no-auto-salvage
constraints described in [Asynchronous Work](#asynchronous-work).

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

Durable run records are stored below the repository's git common directory, not
the active working tree. For `preserveWorktree: false`, cleanup happens only
after a terminal result is durable. An abnormal worker exit never triggers
automatic cleanup, path-policy salvage, or patch adoption.

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
- `auditor`: `pass`, `missingTools`.
- `generate`: `generated` (the raw JSON object or array Codex returned).
- `work`: `changedFiles`, `tests`, `risks`, `worktreePath`,
  `worktreePreserved`.

### Degraded report (`status: "partial"`)

`status` is `ok`, `failed`, `refused`, `dry-run`, or `partial`. A `partial` run is
returned when the assistant turn completes and its report parses as JSON with a
valid core (`summary`, `recommendedNextAction`) but a workflow-specific field
drifts from the schema. Instead of discarding a completed turn, the sidecar:

- preserves the raw report verbatim in `unvalidatedReport`;
- lists the exact violations in `error` (still `PROTOCOL_ERROR`);
- discloses any lossless coercion in `normalizationNotes` — currently a bare
  confidence level string (`"high"` → `{ "level": "high" }`) and string
  `affectedFiles`/`fileReferences` elements (`"a.ts"` → `{ "path": "a.ts" }`);
- omits the typed workflow fields (`findings`/`risks`/`tests`/`pass`) so no
  fabricated default is presented — read `unvalidatedReport` for them;
- for `work`, still attaches `changedFiles`/`worktreePath`/`worktreePreserved`, so
  a completed worktree is never thrown away because its report drifted.

Un-coercible drift is never guessed: a synonym `severity` or a free-text `basis`
is surfaced as a violation, not invented. A non-JSON turn or a missing core stays
a hard `PROTOCOL_ERROR` (`status: "failed"`) — there is no prose fallback. See
[STRUCTURED_OUTPUT_TOLERANCE_PLAN.md](STRUCTURED_OUTPUT_TOLERANCE_PLAN.md).

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

## Release Procedure

Use this end-to-end procedure for an already version-aligned release. Run the
steps in one shell so `RELEASE_VERSION`, `pnpm_release`, and
`PACK_DIR` remain bound to the artifacts being published.

1. Confirm that no unrelated work would be released. A non-empty stash is also
   release state and must be examined, not ignored.

   ```bash
   git status --short --branch
   git stash list
   ```

2. Bind the release version and package-manager entrypoint. The normal entry is
   Corepack. If this host has no `corepack` executable, use an already installed
   pnpm only after its version matches `packageManager` exactly; do not install
   Corepack over an existing pnpm shim.

   ```bash
   RELEASE_VERSION=0.3.3
   if command -v corepack >/dev/null; then
     pnpm_release() { corepack pnpm "$@"; }
   else
     PNPM_BIN=$(command -v pnpm)
     test -n "$PNPM_BIN"
     pnpm_release() { "$PNPM_BIN" "$@"; }
   fi
   test "$(pnpm_release --version)" = "10.10.0"
   ```

3. Run the repository gates. These are the direct expansion of the root scripts
   and also work on a host where `corepack` is absent.

   ```bash
   pnpm_release --filter codex-sidecar-core build
   pnpm_release -r typecheck
   pnpm_release --filter codex-sidecar-core test
   pnpm_release --filter codex-sidecar-cli test
   pnpm_release --filter codex-sidecar-mcp test
   pnpm_release -r build
   ```

4. Inspect each package before publication. First inspect the dry-run file list,
   then inspect each produced tarball's `package.json` and confirm that CLI/MCP
   depend on the registry version of `codex-sidecar-core`, not `workspace:`.

   ```bash
   (cd packages/core && npm pack --dry-run)
   (cd packages/cli && npm pack --dry-run)
   (cd packages/mcp && npm pack --dry-run)
   PACK_DIR=$(mktemp -d)
   (cd packages/core && pnpm_release pack --pack-destination "$PACK_DIR")
   (cd packages/cli && pnpm_release pack --pack-destination "$PACK_DIR")
   (cd packages/mcp && pnpm_release pack --pack-destination "$PACK_DIR")
   tar -xOf "$PACK_DIR"/codex-sidecar-cli-*.tgz package/package.json
   tar -xOf "$PACK_DIR"/codex-sidecar-mcp-*.tgz package/package.json
   ```

5. Commit the release record with explicit pathspecs, require a clean tree,
   then bind and push the exact verified pre-publication commit before
   publishing immutable npm versions.

   ```bash
   git add CHANGELOG.md README.md README.ja.md docs
   git status --short
   git commit -m "docs: 0.3.3の公開文書を更新する" -- \
     CHANGELOG.md README.md README.ja.md docs
   test -z "$(git status --porcelain)"
   PUBLISH_SHA=$(git rev-parse HEAD)
   git push origin main
   test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$PUBLISH_SHA"
   ```

6. Publish only after the inspection passes, in dependency order: core, then
   CLI, then MCP. After each publish, query the registry for version `0.3.3`
   (or the release version being published).

   ```bash
   npm publish "$PACK_DIR"/codex-sidecar-core-"$RELEASE_VERSION".tgz
   npm view codex-sidecar-core@"$RELEASE_VERSION" version
   npm publish "$PACK_DIR"/codex-sidecar-cli-"$RELEASE_VERSION".tgz
   npm view codex-sidecar-cli@"$RELEASE_VERSION" version
   npm publish "$PACK_DIR"/codex-sidecar-mcp-"$RELEASE_VERSION".tgz
   npm view codex-sidecar-mcp@"$RELEASE_VERSION" version
   ```

7. Build and smoke the Docker image as a verification step. Do not deploy it to
   a persistent host when no deployment target has been specified.

   ```bash
   docker build -t codex-sidecar:"$RELEASE_VERSION" .
   ```

8. Record any final release evidence (for example, complete and archive an
   execution checklist) in a final commit, then bind `RELEASE_SHA`. Create the
   tag and GitHub release only after that commit is pushed and the registry
   versions are verified. Resolve the local tag and remote `main` back to the
   same commit, and verify that the GitHub release names that tag.

   ```bash
   git add docs
   git commit -m "docs: 0.3.3公開計画を完了する" -- docs
   test -z "$(git status --porcelain)"
   RELEASE_SHA=$(git rev-parse HEAD)
   git push origin main
   test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$RELEASE_SHA"
   git tag -a "v$RELEASE_VERSION" "$RELEASE_SHA" -m "codex-sidecar v$RELEASE_VERSION"
   git push origin "v$RELEASE_VERSION"
   gh release create "v$RELEASE_VERSION" --target "$RELEASE_SHA" \
     --title "codex-sidecar v$RELEASE_VERSION" --generate-notes
   git fetch origin "refs/tags/v$RELEASE_VERSION:refs/tags/v$RELEASE_VERSION"
   test "$(git rev-parse "v$RELEASE_VERSION^{commit}")" = "$RELEASE_SHA"
   test "$(git rev-parse origin/main)" = "$RELEASE_SHA"
   test "$(gh release view "v$RELEASE_VERSION" --json tagName --jq .tagName)" = "v$RELEASE_VERSION"
   ```

## Verification Commands

Before publishing changes to this repository:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

For MCP distribution changes, also keep the symlinked-bin regression test
passing. It proves that a globally installed `codex-sidecar-mcp` command starts
the stdio server and lists the expected tools.

For a consuming repository, start with:

```bash
codex-sidecar diagnostics \
  --project /path/to/consumer \
  --preset review
```

Then run the smallest read-only smoke:

```bash
codex-sidecar explore \
  --project /path/to/consumer \
  "Return a one-sentence summary of this repository using file references."
```

## Related Docs

- [../README.md](../README.md): project overview and repository layout.
- [../AGENTS.md](../AGENTS.md): working instructions for Codex and future agents.
- [README.md](README.md): docs index and archive map.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [PROTOCOL.md](PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
- [TODO.md](TODO.md): durable task list and linked GitHub issues.
- [archive/CODEX_MODEL_POLICY_TODO.md](archive/CODEX_MODEL_POLICY_TODO.md): archived completed Codex model policy plan.
