import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { inspectProcessGroup } from "./process-group.js";
import { readClaim, publishRecord, readRecord, type OperatorRecoveryRecord, type SpawnRecord } from "./run-records.js";
import { RunStoreError, stableJson } from "./run-foundation.js";
import {
  captureDeadRunTransitionForOperator,
  releaseDeadRunTransitionForOperator,
  withRunTransition,
  type DeadRunTransitionTarget,
} from "./run-transition.js";
import { lookupStoredRun } from "./run-store.js";
import { inspectStoredWorkRun, type DurableRunStatusOptions } from "./run-status.js";
import type { StoredRun, WorkRecoverInput } from "./run-types.js";
import type { SidecarRunPollResult } from "./types.js";

export type WorkRecoveryOutcome = "inspection" | "quarantined" | "already-terminal" | "result-preserved";

/** Read-only durable evidence returned by `work-recover` before any mutation. */
export interface WorkRecoveryInspection {
  kind: "work_recovery_inspection";
  runId: string;
  runDirectory: string;
  status: SidecarRunPollResult;
  quarantinePublished: boolean;
  outcome: WorkRecoveryOutcome;
}

/**
 * Read-only recovery inspection.  It never creates a transition directory,
 * releases a worker/auth lease, scans a worktree, or changes durable records.
 */
export async function inspectWorkRecovery(
  input: Pick<WorkRecoverInput, "projectRoot" | "idempotencyKey">,
  options: DurableRunStatusOptions = {},
): Promise<WorkRecoveryInspection> {
  return inspectRun(await lookupStoredRun(input), options, "inspection");
}

/**
 * Operator-facing recovery.  The default is the read-only inspection above;
 * `action=quarantine` is accepted only with an explicit confirmation and
 * writes a create-only current-generation fence.  It never salvages, cleans
 * up, or applies a worktree patch.
 */
export async function recoverWorkRun(
  input: WorkRecoverInput,
  options: DurableRunStatusOptions = {},
): Promise<WorkRecoveryInspection> {
  const action = (input as { action?: unknown }).action;
  if (action === undefined) return inspectWorkRecovery(input, options);
  if (action !== "quarantine" || (input as { confirmNoRunningProcesses?: unknown }).confirmNoRunningProcesses !== true) {
    throw new RunStoreError("RUN_INVALID_INPUT", "work recovery mutation requires action=quarantine and confirmNoRunningProcesses=true");
  }
  const run = await lookupStoredRun(input);
  const outcome = await quarantineRun(run);
  return inspectRun(run, options, outcome);
}

async function inspectRun(
  run: StoredRun,
  options: DurableRunStatusOptions,
  outcome: WorkRecoveryOutcome,
): Promise<WorkRecoveryInspection> {
  const [status, quarantine] = await Promise.all([
    inspectStoredWorkRun(run, { ...options, repairDurableState: false }),
    readRecord(run.runDirectory, "quarantine.json"),
  ]);
  return {
    kind: "work_recovery_inspection",
    runId: run.manifest.runId,
    runDirectory: run.runDirectory,
    status,
    quarantinePublished: Boolean(quarantine),
    outcome,
  };
}

async function quarantineRun(run: StoredRun): Promise<Exclude<WorkRecoveryOutcome, "inspection">> {
  try {
    return await quarantineUnderTransition(run);
  } catch (error) {
    if (!(error instanceof RunStoreError) || error.code !== "RUN_ORPHANED") throw error;
    const target = await captureDeadRunTransitionForOperator(run.runDirectory);
    if (!target) throw error;
    await publishTransitionRecoveryAudit(run, target);
    await releaseDeadRunTransitionForOperator(target);
    return quarantineUnderTransition(run);
  }
}

async function quarantineUnderTransition(run: StoredRun): Promise<Exclude<WorkRecoveryOutcome, "inspection">> {
  return withRunTransition(run.runDirectory, async () => {
    const current = await readClaim(join(run.runDirectory, "launch.lock"));
    if (stableJson(current) !== stableJson(run.claim)) {
      throw new RunStoreError("RUN_ORPHANED", "work recovery launch generation is fenced");
    }
    if (await readRecord(run.runDirectory, "terminal.json")) return "already-terminal";
    // A valid result is never downgraded.  Recovery inspection projects it
    // without repairing any missing terminal record.
    if (await readRecord(run.runDirectory, "result.json")) return "result-preserved";
    if (await readRecord(run.runDirectory, "quarantine.json")) return "quarantined";
    if (await hasAppServerStartEvidence(run)) {
      throw new RunStoreError(
        "RUN_AUTH_UNCERTAIN",
        "manual quarantine refused because auth/app-server-started.json exists; inspect and recover the exact work auth lease first",
      );
    }

    const spawned = await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json");
    if (spawned) await refuseKnownLiveWorker(spawned as SpawnRecord);
    await publishRecord(run.runDirectory, "quarantine.json", {
      kind: "quarantine",
      generation: current.generation,
      token: current.token,
      createdAt: new Date().toISOString(),
    });
    return "quarantined";
  });
}

async function refuseKnownLiveWorker(spawned: SpawnRecord): Promise<void> {
  try {
    const observed = await inspectProcessGroup(spawned.processIdentity, spawned.pgid);
    if (observed.state === "alive") {
      throw new RunStoreError("RUN_ORPHANED", "manual quarantine refused because the recorded worker process group is still alive");
    }
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    // An observation failure is deliberately left to the operator's explicit
    // confirmation; no PID/PGID is signalled from recovery code.
  }
}

/**
 * The auth journal's App Server marker is a write-ahead boundary, not proof
 * that the process exited. Any safe-looking marker therefore blocks terminal
 * quarantine; malformed ownership/mode also fails closed into manual auth
 * inspection rather than being treated as absence.
 */
async function hasAppServerStartEvidence(run: StoredRun): Promise<boolean> {
  const authDirectory = join(run.runDirectory, "auth");
  let directory: Awaited<ReturnType<typeof lstat>>;
  try {
    directory = await lstat(authDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new RunStoreError("RUN_AUTH_UNCERTAIN", `cannot inspect auth journal: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) {
    throw new RunStoreError("RUN_AUTH_UNCERTAIN", "auth journal is unsafe; manual auth inspection is required");
  }
  const markerPath = join(authDirectory, "app-server-started.json");
  try {
    const marker = await lstat(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink() || (marker.mode & 0o777) !== 0o600) {
      throw new RunStoreError("RUN_AUTH_UNCERTAIN", "auth App Server marker is unsafe; manual auth inspection is required");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError("RUN_AUTH_UNCERTAIN", `cannot inspect auth App Server marker: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function publishTransitionRecoveryAudit(run: StoredRun, target: DeadRunTransitionTarget): Promise<void> {
  const body = {
    kind: "operator-recovery" as const,
    generation: run.claim.generation,
    token: run.claim.token,
    action: "release-dead-transition" as const,
    transitionToken: target.claim.token,
    transitionOwner: target.claim.owner,
    createdAt: new Date().toISOString(),
  };
  const recordName = `operator-recovery-${target.claim.token}.json`;
  try {
    await publishRecord(run.runDirectory, recordName, body);
  } catch (error) {
    if (!(error instanceof RunStoreError) || error.code !== "RUN_STORE_CORRUPT") throw error;
    const existing = await readRecord(run.runDirectory, recordName);
    if (!matchesAudit(existing, body)) throw error;
  }
}

function matchesAudit(existing: Record<string, unknown> | undefined, expected: Omit<OperatorRecoveryRecord, "version" | "digest">): boolean {
  return Boolean(existing && existing.kind === "operator-recovery" &&
    existing.generation === expected.generation && existing.token === expected.token &&
    existing.action === expected.action && existing.transitionToken === expected.transitionToken &&
    stableJson(existing.transitionOwner) === stableJson(expected.transitionOwner));
}
