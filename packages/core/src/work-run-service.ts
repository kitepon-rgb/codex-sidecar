import { currentProcessIdentity } from "./process-identity.js";
import { buildSidecarRequest } from "./requests.js";
import { dryRunResult } from "./results.js";
import { SIDECAR_RUN_ERROR_CODES, type SidecarConfig, type SidecarRunCancelResult, type SidecarRunErrorCode, type SidecarRunHandle, type SidecarRunOperationError, type SidecarRunPollResult, type SidecarRunStartResult } from "./types.js";
import { acquireOrReclaimLaunchClaim, launchRunWorker, type LaunchOptions } from "./run-launch.js";
import { publishRecord, promoteResultToTerminal } from "./run-records.js";
import { stableJson } from "./run-foundation.js";
import { lookupStoredRun, openOrCreateRun } from "./run-store.js";
import { inspectStoredWorkRun, type DurableRunStatusOptions } from "./run-status.js";
import { requestRunCancellation } from "./run-control.js";
import type { LookupInput, StartInput, StoredRun } from "./run-types.js";
import { workerEntrypoint } from "./run-worker.js";

export interface WorkRunStartOptions {
  /** @internal Test/embedded runtime override. Production uses core's own worker entrypoint. */
  workerEntrypoint?: string;
  /** @internal Worker launch seam; it does not alter the durable public contract. */
  launch?: LaunchOptions;
  status?: DurableRunStatusOptions;
}

/**
 * A start caller may defer configuration loading until it wins creation of a
 * new durable run.  Retrying an existing idempotency key must not depend on
 * the current config file still being present or valid.
 */
export type WorkRunConfigSource = SidecarConfig | (() => Promise<SidecarConfig>);

/**
 * Creates or rediscovers a deterministic async work run. Configuration is
 * normalized only for a new winner; retries use its immutable manifest.
 */
export async function startWorkRun(
  configSource: WorkRunConfigSource,
  input: StartInput,
  options: WorkRunStartOptions = {},
): Promise<SidecarRunStartResult> {
  try {
    if (process.platform === "win32") {
      return operationError(Object.assign(new Error("async work workers require POSIX process groups"), { code: "RUN_UNSUPPORTED_PLATFORM" }));
    }
    const { projectRoot, idempotencyKey, baseRef, ...rawInput } = input;
    const run = await openOrCreateRun(
      { projectRoot, idempotencyKey, baseRef, rawInput },
      async () => {
        const config = typeof configSource === "function" ? await configSource() : configSource;
        return { normalizedRequest: buildSidecarRequest(config, { ...rawInput, workflow: "work", projectRoot }) };
      },
    );

    if (run.manifest.normalizedRequest.dryRun) {
      if (run.created) await commitDryRun(run);
      return startProjection(await inspectStoredWorkRun(run, options.status));
    }

    const projection = await inspectStoredWorkRun(run, options.status);
    if (projection.kind === "run_terminal" || projection.kind === "run_interrupted" || projection.kind === "run_error") return projection;
    if (projection.phase !== "launch") return handleForPending(run, projection);

    const claimed = await acquireOrReclaimLaunchClaim(run);
    if (!await callerOwnsClaim(claimed)) return handleForPending(claimed, projection);
    return launchRunWorker(claimed, options.workerEntrypoint ?? workerEntrypoint(), options.launch);
  } catch (error) {
    return operationError(error);
  }
}

/** Reads a durable run without loading config or starting a worker. */
export async function getWorkRunResult(
  input: LookupInput,
  options: DurableRunStatusOptions = {},
): Promise<SidecarRunPollResult> {
  try {
    return await inspectStoredWorkRun(await lookupStoredRun(input), options);
  } catch (error) {
    return operationError(error);
  }
}

/** Publishes an idempotent cancel intent; terminal state is read through result. */
export async function cancelWorkRun(input: LookupInput): Promise<SidecarRunCancelResult> {
  try {
    return await requestRunCancellation(await lookupStoredRun(input));
  } catch (error) {
    return operationError(error);
  }
}

async function commitDryRun(run: StoredRun): Promise<void> {
  const result = dryRunResult(run.manifest.normalizedRequest);
  await publishRecord(run.runDirectory, "result.json", {
    kind: "result",
    generation: run.claim.generation,
    token: run.claim.token,
    result,
    terminalState: "completed",
    createdAt: new Date().toISOString(),
  });
  await promoteResultToTerminal(run.runDirectory, run.claim.generation, run.claim.token);
}

function startProjection(projection: SidecarRunPollResult): SidecarRunStartResult {
  if (projection.kind === "run_terminal" || projection.kind === "run_interrupted" || projection.kind === "run_error") return projection;
  return {
    kind: "run_handle",
    workflow: "work",
    runId: projection.runId,
    state: projection.state,
    createdAt: new Date().toISOString(),
    pollAfterMs: projection.pollAfterMs,
  };
}

function handleForPending(run: StoredRun, pending: Extract<SidecarRunPollResult, { kind: "run_pending" }>): SidecarRunHandle {
  return {
    kind: "run_handle",
    workflow: "work",
    runId: run.manifest.runId,
    state: pending.state,
    createdAt: run.manifest.createdAt,
    pollAfterMs: pending.pollAfterMs,
  };
}

async function callerOwnsClaim(run: StoredRun): Promise<boolean> {
  return stableJson(run.claim.owner) === stableJson(await currentProcessIdentity());
}

function operationError(error: unknown): SidecarRunOperationError {
  const suppliedCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const code = isRunErrorCode(suppliedCode)
    ? suppliedCode
    : message.startsWith("CONFIG_") || message.startsWith("PRESET_") || message.startsWith("SAFETY_REFUSAL")
      ? "RUN_INVALID_INPUT"
      : "RUN_INTERNAL_ERROR";
  return {
    kind: "run_error",
    error: { code, message },
    retryable: code !== "RUN_INVALID_INPUT" && code !== "RUN_KEY_CONFLICT" && code !== "RUN_UNSUPPORTED_PLATFORM",
  };
}

function isRunErrorCode(value: string | undefined): value is SidecarRunErrorCode {
  return SIDECAR_RUN_ERROR_CODES.some((code) => code === value);
}
