import { join } from "node:path";
import { publishRecord, readClaim, readRecord, type ExecutionStartedRecord, type TerminalRecord } from "./run-records.js";
import { withRunTransition } from "./run-transition.js";
import { RunStoreError } from "./run-foundation.js";
import { stableJson } from "./run-foundation.js";
import type { SidecarRunCancelAck } from "./types.js";
import type { LaunchClaim, StoredRun } from "./run-types.js";

export type ExecutionStartDecision =
  | { state: "started"; generation: number; token: string }
  | { state: "cancelled-before-start"; generation: number; token: string };

export type ExecutionResourceDecision<T> =
  | { state: "started"; generation: number; token: string; resource: T }
  | { state: "cancelled-before-start"; generation: number; token: string; resource?: T }
  | { state: "already-started"; generation: number; token: string };

export async function beginRunExecution(run: StoredRun): Promise<ExecutionStartDecision> {
  return withRunTransition(run.runDirectory, async () => {
    const claim = await currentClaim(run);
    const terminal = await readRecord(run.runDirectory, "terminal.json");
    if (terminal) throw new RunStoreError("RUN_ORPHANED", "run is already terminal");
    if (await readRecord(run.runDirectory, "quarantine.json")) throw new RunStoreError("RUN_ORPHANED", "run is quarantined");
    const started = await readRecord(run.runDirectory, "execution-started.json") as ExecutionStartedRecord | undefined;
    if (started) {
      if (started.generation !== claim.generation || started.token !== claim.token) throw new RunStoreError("RUN_ORPHANED", "execution belongs to a fenced generation");
      return { state: "started", generation: claim.generation, token: claim.token };
    }
    if (await readRecord(run.runDirectory, "cancel.json")) return { state: "cancelled-before-start", generation: claim.generation, token: claim.token };
    await publishRecord(run.runDirectory, "execution-started.json", { kind: "execution-started", generation: claim.generation, token: claim.token, createdAt: new Date().toISOString() });
    return { state: "started", generation: claim.generation, token: claim.token };
  });
}

/**
 * Acquires a non-blocking external resource while holding the run transition
 * lease, then publishes execution-started. This fixes the ordering as
 * transition → resource (global auth) → execution marker, so pre-start cancel
 * cannot race a successful auth acquisition into an unmarked execution.
 */
export async function beginRunExecutionWithResource<T>(
  run: Pick<StoredRun, "runDirectory" | "claim">,
  acquire: () => Promise<T>,
  releaseOnPublishFailure: (resource: T) => Promise<void>,
): Promise<ExecutionResourceDecision<T>> {
  return withRunTransition(run.runDirectory, async () => {
    const claim = await currentClaim(run);
    const terminal = await readRecord(run.runDirectory, "terminal.json");
    if (terminal) throw new RunStoreError("RUN_ORPHANED", "run is already terminal");
    if (await readRecord(run.runDirectory, "quarantine.json")) throw new RunStoreError("RUN_ORPHANED", "run is quarantined");
    const started = await readRecord(run.runDirectory, "execution-started.json") as ExecutionStartedRecord | undefined;
    if (started) {
      if (started.generation !== claim.generation || started.token !== claim.token) throw new RunStoreError("RUN_ORPHANED", "execution belongs to a fenced generation");
      return { state: "already-started", generation: claim.generation, token: claim.token };
    }
    if (await readRecord(run.runDirectory, "cancel.json")) return { state: "cancelled-before-start", generation: claim.generation, token: claim.token };
    const resource = await acquire();
    if (await readRecord(run.runDirectory, "cancel.json")) return { state: "cancelled-before-start", generation: claim.generation, token: claim.token, resource };
    try {
      await publishRecord(run.runDirectory, "execution-started.json", { kind: "execution-started", generation: claim.generation, token: claim.token, createdAt: new Date().toISOString() });
      return { state: "started", generation: claim.generation, token: claim.token, resource };
    } catch (error) {
      try { await releaseOnPublishFailure(resource); } catch (releaseError) { Object.assign(error as object, { releaseError }); }
      throw error;
    }
  });
}

export async function requestRunCancellation(run: StoredRun): Promise<SidecarRunCancelAck> {
  return withRunTransition(run.runDirectory, async () => {
    const claim = await currentClaim(run);
    const terminal = await readRecord(run.runDirectory, "terminal.json") as TerminalRecord | undefined;
    if (terminal) return ack(run, false, true, "already_terminal", "terminal");
    const execution = await readRecord(run.runDirectory, "execution-started.json") as ExecutionStartedRecord | undefined;
    const existing = await readRecord(run.runDirectory, "cancel.json");
    const mode = execution ? "cooperative" : "pre_start_fenced";
    if (existing) return ack(run, true, false, "already_requested", mode);
    await publishRecord(run.runDirectory, "cancel.json", { kind: "cancel", observedGeneration: claim.generation, observedToken: claim.token, createdAt: new Date().toISOString() });
    return ack(run, true, false, "cancellation_requested", mode);
  });
}

async function currentClaim(run: Pick<StoredRun, "runDirectory" | "claim">): Promise<LaunchClaim> {
  const current = await readClaim(join(run.runDirectory, "launch.lock"));
  if (stableJson(current) !== stableJson(run.claim)) throw new RunStoreError("RUN_ORPHANED", "run generation is fenced");
  return current;
}

function ack(run: StoredRun, accepted: boolean, terminal: boolean, state: SidecarRunCancelAck["state"], mode: SidecarRunCancelAck["mode"]): SidecarRunCancelAck {
  return { kind: "run_cancel_ack", runId: run.manifest.runId, accepted, terminal, state, mode, pollAfterMs: 250 };
}
