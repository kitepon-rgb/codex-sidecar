import assert from "node:assert/strict";
import test from "node:test";
import { WorkAuthRecoveryStrategy } from "./run-types.js";
import type {
  CancelInput, LookupInput, SidecarRunCancelAck, SidecarRunInterrupted, SidecarRunOperationError,
  SidecarRunPending, SidecarRunStartResult, SidecarRunTerminal, StartInput, WorkAuthRecoverInput, WorkRecoverInput,
} from "./run-types.js";

test("public long-running work inputs retain the caller retry identity and read-only recovery default", () => {
  const start = {
    projectRoot: "/repo", idempotencyKey: "A".repeat(22), prompt: "fix", workflow: "work", baseRef: "HEAD", dryRun: true,
  } satisfies StartInput;
  const lookup = { projectRoot: start.projectRoot, idempotencyKey: start.idempotencyKey } satisfies LookupInput;
  const cancel = lookup satisfies CancelInput;
  const inspect: WorkRecoverInput = lookup;
  const quarantine = { ...lookup, action: "quarantine", confirmNoRunningProcesses: true } satisfies WorkRecoverInput;
  const authRecovery = { ...lookup, strategy: WorkAuthRecoveryStrategy.ReleaseClean, confirmNoRunningProcesses: true } satisfies WorkAuthRecoverInput;
  assert.equal(inspect.action, undefined);
  assert.equal(quarantine.confirmNoRunningProcesses, true);
  assert.equal(cancel.idempotencyKey, start.idempotencyKey);
  assert.equal(authRecovery.strategy, "release-clean");
});

test("public run result union keeps terminal, pending, interrupted, cancel, and operation error shapes distinct", () => {
  const terminal = { kind: "run_terminal", runId: "r", state: "completed", result: { status: "dry-run", workflow: "work", summary: "", confidence: { level: "high" }, recommendedNextAction: "" }, cleanup: "not-requested" } satisfies SidecarRunTerminal;
  const pending = { kind: "run_pending", runId: "r", state: "running", phase: "turn", pollAfterMs: 1000 } satisfies SidecarRunPending;
  const interrupted = { kind: "run_interrupted", runId: "r", state: "orphaned", error: { code: "RUN_ORPHANED", message: "stale" }, processGroup: "unknown", salvageAllowed: false, terminal: false, pollAfterMs: 1000 } satisfies SidecarRunInterrupted;
  const cancel = { kind: "run_cancel_ack", runId: "r", accepted: true, terminal: false, state: "cancellation_requested", mode: "cooperative", pollAfterMs: 1000 } satisfies SidecarRunCancelAck;
  const error = { kind: "run_error", error: { code: "RUN_NOT_FOUND", message: "missing" }, retryable: false } satisfies SidecarRunOperationError;
  const start: SidecarRunStartResult = terminal;
  assert.equal(start.kind, "run_terminal"); assert.equal(pending.kind, "run_pending"); assert.equal(interrupted.salvageAllowed, false); assert.equal(cancel.kind, "run_cancel_ack"); assert.equal(error.kind, "run_error");
});

test("auth recovery strategies expose exactly the four durable contract values", () => {
  assert.deepEqual(Object.values(WorkAuthRecoveryStrategy).sort(), ["keep-canonical-after-login", "release-clean", "release-never-started", "write-back-run-local"]);
});
