import { join } from "node:path";
import {
  inspectCurrentDurableAuthRecovery,
  recoverCurrentDurableAuthSessionForTarget,
  recoveryTargetFromInspection,
  type CurrentDurableAuthOptions,
  type DurableAuthRecoveryInspection,
  type HeldDurableAuthRecoveryInspection,
} from "./durable-auth-session.js";
import { RunStoreError } from "./run-foundation.js";
import { lookupStoredRun } from "./run-store.js";
import type { LookupInput, WorkAuthRecoverInput } from "./run-types.js";

export type WorkAuthLeaseOwnership = "available" | "owned-by-run" | "owned-by-other";

/** Read-only diagnosis for the auth lease that an async work run may own. */
export interface WorkAuthRecoveryInspection {
  kind: "work_auth_inspection";
  runId: string;
  runDirectory: string;
  expectedJournalPath: string;
  ownership: WorkAuthLeaseOwnership;
  auth: DurableAuthRecoveryInspection;
}

/** @internal deterministic seam for the inspection-to-recovery race contract. */
export const __workAuthRecoveryTestHooks: {
  afterInspectionBeforeRecovery?: (inspection: WorkAuthRecoveryInspection) => Promise<void>;
} = {};

/**
 * Inspects a run and the current global auth lease without creating, releasing,
 * or writing any run/auth record.
 */
export async function inspectWorkAuthRecovery(
  input: LookupInput,
  options: CurrentDurableAuthOptions = {},
): Promise<WorkAuthRecoveryInspection> {
  const run = await lookupStoredRun(input);
  const expectedJournalPath = join(run.runDirectory, "auth");
  const auth = await inspectCurrentDurableAuthRecovery(options);
  return {
    kind: "work_auth_inspection",
    runId: run.manifest.runId,
    runDirectory: run.runDirectory,
    expectedJournalPath,
    ownership: ownershipForRun(auth, run.manifest.runId, expectedJournalPath),
    auth,
  };
}

/**
 * Executes an explicit recovery only when the currently held lease is still
 * owned by this exact run's immutable auth journal.
 */
export async function recoverWorkAuthSession(
  input: WorkAuthRecoverInput,
  options: CurrentDurableAuthOptions = {},
): Promise<void> {
  const inspection = await inspectWorkAuthRecovery(input, options);
  if (inspection.ownership !== "owned-by-run" || inspection.auth.state !== "held") {
    throw new RunStoreError("RUN_AUTH_UNCERTAIN", "the requested work run is not the current durable auth lease owner");
  }
  await __workAuthRecoveryTestHooks.afterInspectionBeforeRecovery?.(inspection);
  await recoverCurrentDurableAuthSessionForTarget({
    ...options,
    strategy: input.strategy,
    confirmNoRunningProcesses: input.confirmNoRunningProcesses,
  }, recoveryTargetFromInspection(inspection.auth));
}

function ownershipForRun(
  auth: DurableAuthRecoveryInspection,
  runId: string,
  expectedJournalPath: string,
): WorkAuthLeaseOwnership {
  if (auth.state === "available") return "available";
  return isExactRunOwner(auth, runId, expectedJournalPath) ? "owned-by-run" : "owned-by-other";
}

function isExactRunOwner(
  auth: HeldDurableAuthRecoveryInspection,
  runId: string,
  expectedJournalPath: string,
): boolean {
  return auth.ownerKind === "work-run" && auth.ownerId === runId && auth.journalPath === expectedJournalPath;
}
