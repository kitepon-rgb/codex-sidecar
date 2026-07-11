# Protocol Notes

`codex-sidecar` talks to Codex App Server as a sidecar coding agent protocol,
not as a general OpenAI API gateway.

## Principles

- Keep App Server startup, shutdown, and session lifecycle in `packages/core`.
- Normalize Codex events into sidecar result types before exposing them through
  CLI or MCP.
- Preserve enough raw event data for debugging.
- Treat protocol changes as a core package concern.
- Keep generic request/result contracts independent from the App Server wire
  format.
- Keep ecosystem context adapters outside the wire protocol layer.

## Verified Local CLI Facts

Verified against the local `codex` CLI on 2026-05-05:

- `codex app-server --help` exposes the app server command directly; there is no
  `run` subcommand.
- `--listen` accepts `stdio://`, `unix://`, `unix://PATH`, `ws://IP:PORT`, and
  `off`.
- `codex app-server generate-ts --experimental --out <dir>` generates protocol
  TypeScript bindings.
- `codex app-server generate-json-schema --experimental --out <dir>` generates
  JSON Schema files.
- Generated `ClientRequest` includes at least these methods needed by the
  sidecar:
  - `initialize`
  - `thread/start`
  - `turn/start`
  - `review/start`
- `stdio://` uses newline-delimited JSON objects. It does not use
  `Content-Length` framing.
- A minimal initialize request keeps the process open and receives an `id`
  response followed by notifications:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-sidecar","title":"Codex Sidecar","version":"0.0.0"},"capabilities":{"experimentalApi":true,"optOutNotificationMethods":[]}}}
```

Observed response shape:

```json
{"id":1,"result":{"userAgent":"codex_vscode/0.128.0-alpha.1 (Ubuntu 26.4.0; x86_64) xterm-256color (codex-sidecar; 0.0.0)","codexHome":"/path/to/home/.codex","platformFamily":"unix","platformOs":"linux"}}
{"method":"remoteControl/status/changed","params":{"status":"disabled","environmentId":null}}
```

- `thread/start` succeeds after initialize with `approvalPolicy: "never"` and
  `sandbox: "read-only"` for read-only sidecar requests. A local smoke returned
  a thread id, cwd, and `approvalPolicy: "never"` without starting a model turn.

`packages/core` now owns the minimal stdio client, line parser, request encoder,
initialize handshake, and typed helpers for `thread/start` and `turn/start`.
It also has pure notification helpers for assistant text deltas and
`turn/completed` state, plus a client-side notification wait primitive for
read-only execution.
Read-only sidecar workflows can start a real App Server turn and normalize the
assistant output into `SidecarResult`. `codex_work` also calls App Server, but
only after creating an isolated git worktree; it must never fall back to direct
active-tree editing.

Verified local read-only smoke:

```bash
node packages/cli/dist/index.js explore --project /path/to/codex-sidecar 'Reply exactly: OK'
```

This returned `status: "ok"`, `workflow: "explore"`, and `summary: "OK"` via a
real App Server turn.

## Expected Flow

1. Load `.codex-sidecar.yml` from the target project.
2. Resolve the requested preset or workflow.
3. Normalize optional context blocks from CLI, MCP, or ecosystem adapters.
4. Validate safety constraints.
5. For write workflows, create an isolated worktree.
6. Start or reuse a Codex App Server session.
7. Send the shaped prompt and context request.
8. Collect events until completion or failure.
9. Return a normalized result with findings, file references, changed files,
   tests, and risks as appropriate.

Current implementation note: read-only workflows perform steps 1-8. `codex_work`
performs the same App Server turn inside the isolated worktree, then validates
changed files against path policy before returning changed-file metadata. Richer
workflow-specific JSON fields remain an ongoing quality area.

## Contracts To Keep Stable

The following are sidecar contracts and should remain stable even if Codex App
Server changes:

- `SidecarRequest`
- `SidecarResult`
- workflow names
- safety policy errors
- finding/risk schemas
- file reference schema
- context block schema
- raw event log reference schema

## Structured App Server Output

App Server turns are prompted to return exactly one JSON object. The adapter
parses that object directly into `SidecarResult` fields. Validation is split into
a hard core and a soft layer:

- **Hard core** — the assistant output must be valid JSON with an object root and
  a non-empty `summary` and `recommendedNextAction`. A failure here is
  `PROTOCOL_ERROR` (`status: "failed"`); callers must not parse prose as a
  fallback. This is the load-bearing "no prose fallback" boundary and must not be
  softened.
- **Soft layer** — everything else, including all workflow-specific fields. When
  the hard core is intact but a soft field fails validation, the run returns
  `status: "partial"` instead of failing. The typed workflow fields are omitted
  (so no fabricated default is presented), the raw report is exposed verbatim in
  `unvalidatedReport`, the exact violations are listed in `error` (still
  `PROTOCOL_ERROR`), and any lossless coercions are disclosed in
  `normalizationNotes`. For `work`, `changedFiles`/`worktreePath` are still
  attached, so a completed worktree is never discarded because its report drifted.

Lossless coercions applied during the soft layer (each disclosed in
`normalizationNotes`):

- a bare confidence level string (`"high"`) → `{ level: "high" }`, at any position;
- a string element in `affectedFiles`/`fileReferences` (`"a.ts"`) → `{ path: "a.ts" }`.

Values that would require *guessing* a classification are never coerced —
a synonym `severity` (e.g. `"blocker"`) and a free-text `basis` are surfaced as
violations, not invented, to preserve the explicit-source-boundary invariant.

Common fields (hard core in **bold**):

- **`summary`**
- `confidence`
- **`recommendedNextAction`**
- `openQuestions`
- `fileReferences`
- `sourceBoundaries`

Workflow-specific fields (soft — a failure degrades to `partial`, not `failed`):

- `review`: `findings`, `missingTests`, `residualRisks`
- `risk-check`: `risks`
- `auditor`: `pass`, `missingTools`
- `opinion`: `recommendation`, `objections`, `assumptions`, `failureModes`
- `explore`: answer text in `summary`, citations in `fileReferences`
- `work`: `tests`, `risks`

## Raw Event Logs

App Server runs create one JSONL artifact under `.codex-sidecar/logs/app-server/`
by default. `SidecarResult.rawEventLogRef` contains the local path to that file
for both successful runs and protocol failures after log creation.

Each line is a JSON object with:

- `timestamp`
- `category`: `lifecycle | protocol | stderr | diagnostic`
- `event`
- optional `direction`: `inbound | outbound`
- optional `data`

The log captures App Server startup, initialize/thread/turn lifecycle markers,
raw inbound/outbound protocol lines, retained notifications, stderr chunks,
timeouts, process exits, and protocol errors. The default log directory is
git-ignored because entries can contain prompts, file paths, and raw local
diagnostics.

## Timeout And Interruption

`SidecarRequest.turnTimeoutMs` is the caller-selected App Server turn timeout in
milliseconds. It is visible in diagnostics output and raw event logs.

`SidecarRequest.interruptOnTimeout` controls timeout cancellation behavior. When
it is `true`, the adapter sends `turn/interrupt` with the active `threadId` and
`turnId` after the completion wait times out. The timeout result is returned as
`APP_SERVER_TIMEOUT`. If App Server reports a completed turn with status
`interrupted`, the adapter returns `APP_SERVER_CANCELLED`.

CLI callers can set these with `--turn-timeout-ms <ms>` and
`--no-interrupt-on-timeout`. MCP tool descriptors expose the same fields as
`turnTimeoutMs` and `interruptOnTimeout`.

## Model Policy

`SidecarRequest.model` and `SidecarRequest.modelReasoningEffort` are optional
sidecar-selected Codex App Server policy fields. They are populated only when
the caller, preset, or config defaults explicitly set policy. When both fields
are absent, sidecar does not pass model overrides and Codex may inherit model
configuration from the isolated `CODEX_HOME`.

Resolution order is:

1. CLI/MCP explicit input
2. preset-level config
3. `defaults` config

Diagnostics and `SidecarResult` include `modelPolicy.source` as `explicit` when
either field is resolved, otherwise `inherited`. Raw lifecycle logs record the
resolved fields and the same source label.

Allowed `modelReasoningEffort` values are `low`, `medium`, `high`, and `xhigh`.
No `none` value is accepted; omit the field when no explicit reasoning effort
should be selected.

## Transport Layer

The MCP server runs over two transports, selected at startup:

- stdio (default): MCP client launches `codex-sidecar-mcp` over stdio. Framing
  follows the MCP stdio spec; the contract is unchanged from previous releases.
- Streamable HTTP (`CODEX_SIDECAR_MCP_TRANSPORT=http`): single `/mcp`
  endpoint, `POST` for client→server messages, `GET` for the server-initiated
  SSE stream, `DELETE` for explicit session close. Sessions are stateful: the
  server generates an `mcp-session-id` on the first `initialize` POST and
  every subsequent request must echo that header.

Both transports use the same `McpServer` and tool registration code path. Tool
descriptors, input schemas, and the `SidecarResult` contract are identical
regardless of transport. The HTTP server holds one `StreamableHTTPServerTransport`
plus one `McpServer` per session in an in-memory map; a transport `onclose`
handler cleans the map when a session ends or the connection drops.

DNS rebinding protection is enabled by default for the HTTP transport. The
SDK matches the HTTP `Host` header verbatim, so the allowlist must include
both the bare host and `host:port` forms; the `defaultAllowedHosts` helper in
`packages/mcp/src/server-http.ts` derives both from the bind host and port.

Optional bearer-token enforcement is layered above the transport: when
`CODEX_SIDECAR_MCP_BEARER` is set, every request is rejected with HTTP 401
unless the `Authorization: Bearer <token>` header matches. This is a deploy-
time policy choice and is not represented in the wire schema, so clients see
an HTTP-level failure rather than an MCP-level one.

## Worktree-Backed Work

`codex_work` creates an isolated git worktree before calling Codex App Server
with workspace-write sandboxing. The active project root remains the policy
anchor, while the App Server turn runs with `projectRoot` set to the isolated
worktree path.

After the turn, the adapter collects `git status --porcelain=v1` from the
worktree, enforces `allowedPaths` and `denyPaths` against the changed files, and
returns `changedFiles`, `worktreePath`, and `worktreePreserved` in
`SidecarResult`. Worktrees are preserved by default for human review. CLI
callers can pass `--remove-worktree` to delete the isolated worktree after the
result is collected.

The following are adapter details and may change with App Server versions:

- process startup flags
- session creation messages
- event names
- streaming format
- cancellation behavior
- approval event shape

## Generic Context Blocks

Callers may pass optional context blocks. These should be plain JSON and should
not require direct imports from the source project.

Suggested block shape:

```json
{
  "kind": "throughline_handoff",
  "source": "throughline",
  "trust": "local",
  "summary": "...",
  "references": []
}
```

Known ecosystem block kinds:

- `relay_entry`
- `throughline_handoff`
- `caveat_entry`
- `smartclaude_cost_hint`
- `codegraph_context`
- `manual_note`

Generic users can pass `manual_note` or omit context entirely.

## Failure Behavior

The protocol adapter should fail explicitly.

- If App Server cannot start, return a startup error.
- If a session cannot be created, return a session error.
- If Codex requests an action outside policy, return a safety refusal.
- If event normalization fails, return a protocol error with raw log reference.
- Do not silently retry through another transport or substitute another source.

## Open Questions

- Whether long-lived App Server sessions should be shared across calls.
- Whether generic installs should enable App Server reuse by default.
- How much ecosystem context is too much for a second-opinion call.

## Related Docs

- [../README.md](../README.md): project overview and repository layout.
- [../AGENTS.md](../AGENTS.md): working instructions for Codex and future agents.
- [README.md](README.md): docs index and archive map.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [TODO.md](TODO.md): durable task list and linked GitHub issues.
- [CODEX_MODEL_POLICY_TODO.md](CODEX_MODEL_POLICY_TODO.md): explicit Codex model policy plan and task list.
