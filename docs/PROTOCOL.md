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
{"id":1,"result":{"userAgent":"codex_vscode/0.128.0-alpha.1 (Ubuntu 26.4.0; x86_64) xterm-256color (codex-sidecar; 0.0.0)","codexHome":"/home/kite/.codex","platformFamily":"unix","platformOs":"linux"}}
{"method":"remoteControl/status/changed","params":{"status":"disabled","environmentId":null}}
```

- `thread/start` succeeds after initialize with `approvalPolicy: "never"` and
  `sandbox: "read-only"` for read-only sidecar requests. A local smoke returned
  a thread id, cwd, and `approvalPolicy: "never"` without starting a model turn.

`packages/core` now owns the minimal stdio client, line parser, request encoder,
initialize handshake, and typed helpers for `thread/start` and `turn/start`.
It also has pure notification helpers for assistant text deltas and
`turn/completed` state.
Until thread/turn event normalization is implemented, real sidecar execution
must still return a structured `APP_SERVER_UNIMPLEMENTED` result instead of
silently falling back to another Codex command.

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
- How much raw protocol output should be stored in logs by default.
- How MCP clients should opt into write-capable `codex_work` calls.
- Whether generic installs should enable App Server reuse by default.
- How much ecosystem context is too much for a second-opinion call.

## Related Docs

- [../README.md](../README.md): project overview and repository layout.
- [../AGENTS.md](../AGENTS.md): working instructions for Codex and future agents.
- [PLAN.md](PLAN.md): roadmap, phases, generic core, and ecosystem overlay.
- [ARCHITECTURE.md](ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
