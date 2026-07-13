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

## Local Factory Runtime Errors

`codex-sidecar-core` owns a separate aggregate runtime-error store for the
private BugHub factory integration. Collection is fail-closed and starts only
when the canonical dotagents factory reporter config contains the JSON boolean
`collection.enabled: true`. The core never reads reporting credentials and
never sends these records over the network.

The capture boundary accepts only a closed set of existing Sidecar error codes.
Each code maps to a fixed component, severity, and message template before it
reaches storage. Raw exceptions, stderr/stdout, stacks, prompts, requests,
paths, raw event logs, and arbitrary context are not accepted. Repeated errors
increment one SHA-256 fingerprint aggregate. The owner-private atomic store has
a monotonic cursor, explicit acknowledgement and resolution/reopen operations,
and compaction never removes unacknowledged records.

Durable run failures use an opaque SHA-256 observation ID so terminal commit,
retry, and later poll reconciliation remain idempotent across crashes. The
store never persists the source run ID or lookup input. Capture executes in a
terminable worker; timeout ends that worker before the Sidecar result proceeds.

`factory-diagnostics` exposes only bounded `runtimeErrorStore` readiness and a
pending aggregate count. It does not expose the store/config path or record
payloads. Store failure cannot replace a Sidecar result and is reported only by
a fixed local stderr diagnostic.

The machine consumer surface is `codex-sidecar factory-errors`. Its default
action returns a bounded snapshot and cursor. `--action ack --cursor <n>` is
called only after the matching report is accepted, while `resolve`, `reopen`,
and `compact` are explicit local lifecycle operations. Resolved records carry
only canonical `resolved_at` and fixed `reason_code=operator_resolved`; reopening
or a new occurrence clears both fields. Command failures return the
fixed `FACTORY_RUNTIME_ERROR_STORE_UNAVAILABLE` code without reflecting a path
or storage exception.

Runtime store schema v2 adds explicit resolution metadata. A strict v1 reader
migrates old open records without changing their aggregate. Because v1 did not
store a resolution timestamp, old resolved records are conservatively reopened
at a new sequence instead of fabricating history; the next accepted factory
report can then establish their real lifecycle.

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

The isolated `CODEX_HOME` allowlist-copies only three top-level keys from the
user-global `$CODEX_HOME/config.toml`: `model`, `model_provider`, and
`model_reasoning_effort`. It deliberately excludes context-window and
auto-compaction threshold overrides and copies no TOML tables. A trusted project
override is not copied; Codex discovers `.codex/config.toml` from the thread
working directory. Async work therefore requires the override to exist in the
run's base commit so the isolated worktree contains it. App Server startup also
clears inherited MCP servers and plugins.

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

## Durable Asynchronous Work

The legacy synchronous `work` workflow remains stable. The async CLI controls
(`work-start`, `work-result`, `work-cancel`, `work-recover`, and
`work-auth-recover`) and MCP tools (`codex_work_start`, `codex_work_result`,
`codex_work_cancel`, `codex_work_recover`, and `codex_work_auth_recover`) are a
separate public contract.

The caller must retain an idempotency key. It identifies the durable run across
retries and transports; a same-key retry reopens the original run rather than
creating another one. Start returns `run_handle`, `run_terminal`,
`run_interrupted`, or `run_error`. Result returns `run_pending`,
`run_terminal`, `run_interrupted`, or `run_error`. Nonterminal states are not
encoded as `SidecarResult.status`.

After the coordinator publishes a valid launch handoff, the worker is detached
from the caller process. Closing stdio or restarting Claude Code therefore does
not cancel it; a later CLI, stdio MCP, or HTTP MCP caller can query the same key.
Run records are private durable files beneath the repository's git common
directory. For non-preserved worktrees, terminal commit precedes cleanup.

Cancellation is an explicit intent, not proof that side effects never began.
Quarantine and auth recovery are operator actions requiring confirmation. If a
worker is killed abnormally, the sidecar does not auto-salvage, evaluate a patch,
or clean its worktree. The global canonical-auth lease remains held until an
explicit safe recovery. For an abnormal started run with no clean-shutdown
evidence and no run-local auth rotation, an external re-login followed by
`keep-canonical-after-login` releases the exact run's lease; it does not adopt
or write back uncertain credentials. A complete clean journal stranded before
lease unlink is recoverable only by the exact `release-clean` strategy.

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
- [archive/CODEX_MODEL_POLICY_TODO.md](archive/CODEX_MODEL_POLICY_TODO.md): archived completed Codex model policy plan.
