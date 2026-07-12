import { join } from "node:path";
import { inspectProcessGroup, type ProcessGroupState } from "./process-group.js";
import { RunStoreError, stableJson } from "./run-foundation.js";
import {
  promoteResultToTerminal,
  readRecord,
  type CleanupRecord,
  type ResultRecord,
  type SpawnRecord,
  type TerminalRecord,
  type WorkerHeartbeat,
} from "./run-records.js";
import type { StoredRun } from "./run-types.js";
import type { SidecarRunInterrupted, SidecarRunPending, SidecarRunPollResult, SidecarRunTerminal } from "./types.js";

export interface DurableRunStatusOptions {
  heartbeatStaleMs?: number;
  pollAfterMs?: number;
}

/**
 * Projects immutable run records into the public poll union. If a worker had
 * already committed `result.json`, this function safely completes the missing
 * terminal marker instead of downgrading that durable result to interruption.
 */
export async function inspectStoredWorkRun(
  run: StoredRun,
  options: DurableRunStatusOptions = {},
): Promise<SidecarRunPollResult> {
  const pollAfterMs = options.pollAfterMs ?? 250;
  const terminal = await readTerminal(run);
  const result = await readResult(run);
  if (terminal) {
    if (!result) throw new RunStoreError("RUN_STORE_CORRUPT", "terminal record exists without its durable result");
    return terminalResult(run, terminal, result, await readCleanup(run));
  }
  if (result) {
    try {
      const recovered = await promoteResultToTerminal(run.runDirectory, result.generation, result.token);
      return terminalResult(run, recovered, result, await readCleanup(run));
    } catch (error) {
      if (!(error instanceof RunStoreError) || error.code !== "RUN_ORPHANED") throw error;
      return terminalFromUnpromotedResult(run, result, await readCleanup(run));
    }
  }

  const quarantine = await readQuarantine(run);
  if (quarantine) {
    return quarantined(run, quarantine, pollAfterMs);
  }

  const [execution, cancellation, spawned, heartbeat] = await Promise.all([
    readRecord(run.runDirectory, "execution-started.json"),
    readRecord(run.runDirectory, "cancel.json"),
    readSpawn(run),
    readWorkerHeartbeat(run),
  ]);

  if (!spawned) {
    return pending(run, cancellation ? "cancellation-requested" : "launch", cancellation ? "queued" : "starting", pollAfterMs);
  }

  if (!heartbeat) {
    return interruptedForSpawn(run, spawned, "worker heartbeat is missing after spawn", pollAfterMs);
  }

  assertCurrentAttempt(run, heartbeat.generation, heartbeat.token, "worker heartbeat");
  if (heartbeat.pid !== spawned.pid || heartbeat.pgid !== spawned.pgid || stableJson(heartbeat.processIdentity) !== stableJson(spawned.processIdentity)) {
    throw new RunStoreError("RUN_STORE_CORRUPT", "worker heartbeat does not belong to the spawned worker");
  }
  if (isFresh(heartbeat.updatedAt, options.heartbeatStaleMs ?? 5_000)) {
    return pending(run, execution ? "execution" : "auth-queue", execution ? "running" : "queued", pollAfterMs, heartbeat.updatedAt);
  }
  return interruptedForSpawn(run, spawned, "worker heartbeat is stale", pollAfterMs);
}

async function readResult(run: StoredRun): Promise<ResultRecord | undefined> {
  const value = await readRecord(run.runDirectory, "result.json");
  if (!value) return undefined;
  if (value.kind !== "result") throw new RunStoreError("RUN_STORE_CORRUPT", "result record kind is invalid");
  assertCurrentAttempt(run, value.generation, value.token, "result");
  return value as ResultRecord;
}

async function readTerminal(run: StoredRun): Promise<TerminalRecord | undefined> {
  const value = await readRecord(run.runDirectory, "terminal.json");
  if (!value) return undefined;
  if (value.kind !== "terminal") throw new RunStoreError("RUN_STORE_CORRUPT", "terminal record kind is invalid");
  assertCurrentAttempt(run, value.generation, value.token, "terminal");
  return value as TerminalRecord;
}

async function readCleanup(run: StoredRun): Promise<CleanupRecord | undefined> {
  const value = await readRecord(run.runDirectory, "cleanup.json");
  if (!value) return undefined;
  if (value.kind !== "cleanup") throw new RunStoreError("RUN_STORE_CORRUPT", "cleanup record kind is invalid");
  assertCurrentAttempt(run, value.generation, value.token, "cleanup");
  return value as CleanupRecord;
}

async function readQuarantine(run: StoredRun): Promise<Record<string, unknown> | undefined> {
  const value = await readRecord(run.runDirectory, "quarantine.json");
  if (!value) return undefined;
  if (value.kind !== "quarantine") throw new RunStoreError("RUN_STORE_CORRUPT", "quarantine record kind is invalid");
  assertCurrentAttempt(run, value.generation, value.token, "quarantine");
  return value;
}

async function readSpawn(run: StoredRun): Promise<SpawnRecord | undefined> {
  const value = await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json");
  if (!value) return undefined;
  if (value.kind !== "spawn") throw new RunStoreError("RUN_STORE_CORRUPT", "spawn record kind is invalid");
  assertCurrentAttempt(run, value.generation, value.token, "spawn");
  return value as SpawnRecord;
}

async function readWorkerHeartbeat(run: StoredRun): Promise<WorkerHeartbeat | undefined> {
  const value = await readRecord(run.runDirectory, "worker-heartbeat.json");
  if (!value) return undefined;
  if (value.kind !== "worker-heartbeat") throw new RunStoreError("RUN_STORE_CORRUPT", "worker heartbeat record kind is invalid");
  return value as WorkerHeartbeat;
}

function terminalResult(
  run: StoredRun,
  terminal: TerminalRecord,
  result: ResultRecord,
  cleanup: CleanupRecord | undefined,
): SidecarRunTerminal {
  if (terminal.resultDigest !== result.digest || terminal.generation !== result.generation || terminal.token !== result.token) {
    throw new RunStoreError("RUN_STORE_CORRUPT", "terminal record does not bind the durable result");
  }
  return {
    kind: "run_terminal",
    runId: run.manifest.runId,
    state: terminal.state,
    result: result.result,
    cleanup: cleanup?.state ?? (run.manifest.normalizedRequest.preserveWorktree ? "not-requested" : "pending"),
  };
}

function terminalFromUnpromotedResult(run: StoredRun, result: ResultRecord, cleanup: CleanupRecord | undefined): SidecarRunTerminal {
  return {
    kind: "run_terminal",
    runId: run.manifest.runId,
    state: result.result.status === "failed" || result.result.status === "refused" ? "failed" : "completed",
    result: result.result,
    cleanup: cleanup?.state ?? (run.manifest.normalizedRequest.preserveWorktree ? "not-requested" : "pending"),
  };
}

function pending(
  run: StoredRun,
  phase: string,
  state: SidecarRunPending["state"],
  pollAfterMs: number,
  heartbeatAt?: string,
): SidecarRunPending {
  return { kind: "run_pending", runId: run.manifest.runId, state, phase, heartbeatAt, pollAfterMs };
}

async function interruptedForSpawn(
  run: StoredRun,
  spawned: SpawnRecord,
  message: string,
  pollAfterMs: number,
): Promise<SidecarRunInterrupted> {
  let processGroup: ProcessGroupState = "unknown";
  try {
    processGroup = (await inspectProcessGroup(spawned.processIdentity, spawned.pgid)).state;
  } catch {
    processGroup = "unknown";
  }
  return {
    kind: "run_interrupted",
    runId: run.manifest.runId,
    state: processGroup === "stopped" ? "interrupted" : "orphaned",
    error: { code: "RUN_ORPHANED", message },
    processGroup,
    salvageAllowed: false,
    terminal: false,
    pollAfterMs,
  };
}

async function quarantined(
  run: StoredRun,
  quarantine: Record<string, unknown>,
  pollAfterMs: number,
): Promise<SidecarRunInterrupted> {
  const spawned = await readSpawn(run);
  let processGroup: ProcessGroupState = "stopped";
  if (spawned) {
    try {
      processGroup = (await inspectProcessGroup(spawned.processIdentity, spawned.pgid)).state;
    } catch {
      processGroup = "unknown";
    }
  }
  return {
    kind: "run_interrupted",
    runId: run.manifest.runId,
    state: "interrupted",
    error: {
      code: "RUN_ORPHANED",
      message: `operator quarantine was published at ${String(quarantine.createdAt)}`,
    },
    processGroup,
    salvageAllowed: false,
    terminal: true,
    pollAfterMs,
  };
}

function assertCurrentAttempt(run: StoredRun, generation: number, token: string, label: string): void {
  if (generation !== run.claim.generation || token !== run.claim.token) {
    throw new RunStoreError("RUN_STORE_CORRUPT", `${label} belongs to a fenced launch generation`);
  }
}

function isFresh(updatedAt: string, staleMs: number): boolean {
  return Date.now() - Date.parse(updatedAt) <= staleMs;
}
