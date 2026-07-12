import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectCurrentDurableAuthRecovery,
  recoverCurrentDurableAuthSessionForTarget,
  recoveryTargetFromInspection,
  type CurrentDurableAuthOptions,
  type DurableAuthRecoveryTarget,
  type DurableAuthRecoveryInspection,
  type HeldDurableAuthRecoveryInspection,
} from "./durable-auth-session.js";
import { RunStoreError, sha256, stableJson } from "./run-foundation.js";
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

/** 明示 recovery が完了したことを、再観測に依存せず返す耐久的な確認応答。 */
export interface WorkAuthRecoveryAck {
  kind: "work_auth_recovery_ack";
  outcome: "recovered";
  runId: string;
  runDirectory: string;
  expectedJournalPath: string;
  strategy: WorkAuthRecoverInput["strategy"];
  target: DurableAuthRecoveryTarget;
  operatorRecoveryRecordPath: string;
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
): Promise<WorkAuthRecoveryAck> {
  const inspection = await inspectWorkAuthRecovery(input, options);
  if (inspection.ownership !== "owned-by-run" || inspection.auth.state !== "held") {
    throw new RunStoreError("RUN_AUTH_UNCERTAIN", "the requested work run is not the current durable auth lease owner");
  }
  await __workAuthRecoveryTestHooks.afterInspectionBeforeRecovery?.(inspection);
  const target = recoveryTargetFromInspection(inspection.auth);
  await recoverCurrentDurableAuthSessionForTarget({
    ...options,
    strategy: input.strategy,
    confirmNoRunningProcesses: input.confirmNoRunningProcesses,
  }, target);
  const operatorRecoveryRecordPath = await verifyExactRecoveryRecord(target, input.strategy);
  return {
    kind: "work_auth_recovery_ack",
    outcome: "recovered",
    runId: inspection.runId,
    runDirectory: inspection.runDirectory,
    expectedJournalPath: inspection.expectedJournalPath,
    strategy: input.strategy,
    target,
    operatorRecoveryRecordPath,
  };
}

/**
 * global lease の現在値ではなく、対象run固有のcreate-only監査recordを検証する。
 * そのため成功後に別runがleaseを取得しても、ackの対象・strategyは変わらない。
 */
async function verifyExactRecoveryRecord(
  target: DurableAuthRecoveryTarget,
  strategy: WorkAuthRecoverInput["strategy"],
): Promise<string> {
  const path = join(target.journalPath, "operator-recovery.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
      throw new RunStoreError("RUN_AUTH_UNCERTAIN", "work auth recovery record is unsafe");
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isExactRecoveryRecord(value, target, strategy)) {
      throw new RunStoreError("RUN_AUTH_UNCERTAIN", "work auth recovery record does not bind the requested target and strategy");
    }
    return path;
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError(
      "RUN_AUTH_UNCERTAIN",
      `cannot verify durable work auth recovery record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isExactRecoveryRecord(
  value: unknown,
  target: DurableAuthRecoveryTarget,
  strategy: WorkAuthRecoverInput["strategy"],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    "version", "kind", "token", "canonicalAuthPath", "strategy", "generation", "mutexToken",
    "targetClaimDigest", "createdAt", "digest",
  ];
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys.sort()[index])) return false;
  const { digest, ...body } = value;
  return value.version === 1 && value.kind === "operator-recovery" && value.token === target.token &&
    value.canonicalAuthPath === target.canonicalAuthPath && value.strategy === strategy &&
    typeof value.generation === "string" && /^\d{20}$/.test(value.generation) &&
    typeof value.mutexToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.mutexToken) &&
    typeof value.targetClaimDigest === "string" && /^[a-f0-9]{64}$/.test(value.targetClaimDigest) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) && digest === sha256(stableJson(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
