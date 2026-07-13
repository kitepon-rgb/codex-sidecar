# BugHub runtime error store plan

Status: complete

This plan is codex-sidecar's implementation TODO for a product-owned local
runtime error projection. The implementation belongs in core; CLI and MCP stay
thin and the public `SidecarResult` contract remains unchanged.

## Contract

- Collection is disabled unless the canonical dotagents factory reporter
  config contains the JSON boolean `collection.enabled: true`.
- Core performs no telemetry network I/O and never reads reporting credentials.
- Persist only allow-listed aggregates: product/version, component, stable
  error code, fixed message template, severity, SHA-256 fingerprint, count,
  first/last seen, state schema version, OS/arch, status, and sequence. Durable
  retries may additionally persist only opaque SHA-256 observation IDs bound to
  those aggregates; raw run IDs and inputs are never stored or projected. The
  ledger is capped at 1,024 entries and 1 MiB; overflow fails that observation
  closed without making the existing store unreadable.
- Reject exception objects, stderr/stdout, stacks, prompts, requests,
  `unvalidatedReport`, raw event logs/references, absolute paths, file contents,
  bearer/auth data, cookies, and arbitrary context.
- Observe a Sidecar failure once in core. CLI and MCP must not recount the same
  `SidecarError` or durable run failure.
- Store failure never replaces the Sidecar result. Emit only a fixed local
  diagnostic without reflected exception text. Capture runs in a terminable
  worker so timed-out filesystem or ACL work cannot outlive the result path.
- Use private mode/ACL, atomic replacement, monotonic cursor, acknowledgement,
  explicit resolve/reopen, and retention that preserves unacknowledged records.
  Mutations use a private SQLite `BEGIN IMMEDIATE` mutex. The OS releases the
  lock if a writer crashes, so no application-level stale-owner reclamation or
  PID/mtime guess is part of the contract. Capture workers are serialized behind
  a bounded in-process queue with an end-to-end enqueue deadline. Every capture
  receives an opaque receipt ID; after forced worker termination the parent
  checks the private ledger so a committed record is never reported as failed.

## TODO

- [x] Add disabled/missing/malformed config characterization tests in core.
- [x] Add privacy, aggregation, and duplicate-layer negative fixtures.
- [x] Add cursor/ack, resolve/reopen, retention, mode, and atomic-write tests.
- [x] Implement and export the product-owned aggregate store from core.
- [x] Extend factory diagnostics with bounded store status and no path/payload.
- [x] Connect stable existing core error codes at one ownership boundary while
      leaving CLI/MCP and `SidecarResult` byte-compatible.
- [x] Run typecheck/build/all package tests and update product documentation.
- [x] Commit and push this repository independently.
