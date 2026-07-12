import { join } from "node:path";
import { createDurableAuthSession, type DurableAuthSession } from "./durable-auth-session.js";
import { beginRunExecutionWithResource } from "./run-control.js";
import { RunStoreError, stableJson } from "./run-foundation.js";
import { publishRecord, promoteResultToTerminal, readRecord } from "./run-records.js";
import { errorResult, toSidecarError } from "./results.js";
import { readStoredRunDirectory } from "./run-store.js";
import { cleanupWorktreeExecution, executeWorktreeAppServerRequest, type WorktreeExecution } from "./worktree-runner.js";
import type { StoredRun } from "./run-types.js";
import type { SidecarResult, SidecarRunTerminal } from "./types.js";

const AUTH_RETRY_MS = 250;
const CANCEL_POLL_MS = 100;

/** Executes the durable work payload after `run-worker` crossed its permit gate. */
export async function executeDurableWorkRun(runDirectory: string, signal: AbortSignal): Promise<void> {
  const stored = await readStoredRunDirectory(runDirectory);
  const run: StoredRun = { ...stored, storeRoot: "", created: false };
  let authSession: DurableAuthSession | undefined;
  let execution: WorktreeExecution | undefined;
  try {
    const decision = await acquireExecutionAuth(run, signal);
    if (decision.state === "cancelled-before-start") {
      authSession = decision.resource;
      await authSession?.closeClean();
      await commitTerminalResult(run, cancelledResult(run), "cancelled");
      return;
    }
    if (decision.state === "already-started") {
      throw new RunStoreError("RUN_ORPHANED", "another worker already owns durable execution");
    }
    authSession = decision.resource;
    const cancellation = startCancellationWatcher(run, signal);
    try {
      if (await quarantineRequested(run)) {
        await authSession.closeClean();
        authSession = undefined;
        throw new RunStoreError("RUN_ORPHANED", "operator quarantined the run before worktree execution");
      }
      execution = await executeWorktreeAppServerRequest(run.manifest.normalizedRequest, {
        worktreeRoot: join(run.runDirectory, "worktree"),
        baseRef: run.manifest.baseCommit,
        abortSignal: cancellation.signal,
        appServer: {
          authSession,
          abortSignal: cancellation.signal,
          eventLogDir: join(run.runDirectory, "logs"),
        },
      });
    } finally {
      cancellation.stop();
    }

    let result = execution.result;
    try {
      await authSession.closeClean();
      authSession = undefined;
    } catch (error) {
      result = errorResult(run.manifest.normalizedRequest, toSidecarError(error));
    }

    if (await quarantineRequested(run)) {
      throw new RunStoreError("RUN_ORPHANED", "operator quarantined the run before terminal commit");
    }
    const cancelled = signal.aborted || await cancellationRequested(run);
    const terminal = await commitTerminalResult(run, result, cancelled ? "cancelled" : undefined);
    if (!cancelled && result.status !== "failed" && result.status !== "refused") {
      await commitCleanup(run, execution, terminal);
    }
  } catch (error) {
    if (authSession) {
      try { await authSession.closeClean(); } catch (closeError) { Object.assign(error as object, { closeError }); }
    }
    if (!await quarantineRequested(run) && await mayCommitForCurrentAttempt(run)) {
      const cancelled = signal.aborted || await cancellationRequested(run);
      try {
        await commitTerminalResult(
          run,
          cancelled ? cancelledResult(run) : errorResult(run.manifest.normalizedRequest, toSidecarError(error)),
          cancelled ? "cancelled" : undefined,
        );
      } catch (commitError) {
        Object.assign(error as object, { commitError });
      }
    }
    throw error;
  }
}

async function acquireExecutionAuth(run: StoredRun, signal: AbortSignal) {
  while (true) {
    if (signal.aborted || await cancellationRequested(run)) {
      return { state: "cancelled-before-start" as const, generation: run.claim.generation, token: run.claim.token };
    }
    try {
      return await beginRunExecutionWithResource(
        run,
        () => createDurableAuthSession({
          ownerKind: "work-run",
          ownerId: run.manifest.runId,
          sessionRoot: run.runDirectory,
          journalPath: join(run.runDirectory, "auth"),
          codexHomePath: join(run.runDirectory, "codex-home"),
        }),
        (session) => session.closeClean(),
      );
    } catch (error) {
      if (!isAuthLeaseBusy(error)) throw error;
      await sleepUntilRetry(signal);
    }
  }
}

function startCancellationWatcher(run: StoredRun, outer: AbortSignal): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer.reason);
  outer.addEventListener("abort", onAbort, { once: true });
  const timer = setInterval(() => {
    void Promise.all([cancellationRequested(run), quarantineRequested(run)]).then(([cancelled, quarantined]) => {
      if (cancelled || quarantined) controller.abort(new Error(quarantined ? "durable work operator quarantine requested" : "durable work cancellation requested"));
    }, () => controller.abort(new Error("durable work cancellation state is unreadable")));
  }, CANCEL_POLL_MS);
  return {
    signal: controller.signal,
    stop() {
      clearInterval(timer);
      outer.removeEventListener("abort", onAbort);
    },
  };
}

async function commitTerminalResult(
  run: StoredRun,
  result: SidecarResult,
  requestedState?: "cancelled",
): Promise<SidecarRunTerminal> {
  const terminalState = requestedState ?? (result.status === "failed" || result.status === "refused" ? "failed" : "completed");
  await publishRecord(run.runDirectory, "result.json", {
    kind: "result",
    generation: run.claim.generation,
    token: run.claim.token,
    result,
    terminalState,
    createdAt: new Date().toISOString(),
  });
  const durableResult = await readRecord(run.runDirectory, "result.json");
  if (!durableResult || durableResult.kind !== "result") throw new RunStoreError("RUN_STORE_CORRUPT", "durable work result disappeared before terminal commit");
  const terminal = await promoteResultToTerminal(run.runDirectory, run.claim.generation, run.claim.token);
  if (terminal.resultDigest !== durableResult.digest || terminal.state !== terminalState) {
    throw new RunStoreError("RUN_STORE_CORRUPT", "durable work terminal does not bind its result");
  }
  return {
    kind: "run_terminal",
    runId: run.manifest.runId,
    state: terminal.state,
    result: durableResult.result as SidecarResult,
    cleanup: run.manifest.normalizedRequest.preserveWorktree ? "not-requested" : "pending",
  };
}

async function commitCleanup(run: StoredRun, execution: WorktreeExecution, terminal: SidecarRunTerminal): Promise<void> {
  if (terminal.cleanup !== "pending") {
    await publishRecord(run.runDirectory, "cleanup.json", {
      kind: "cleanup", generation: run.claim.generation, token: run.claim.token, state: "not-requested", createdAt: new Date().toISOString(),
    });
    return;
  }
  try {
    await cleanupWorktreeExecution(execution);
    await publishRecord(run.runDirectory, "cleanup.json", {
      kind: "cleanup", generation: run.claim.generation, token: run.claim.token, state: "completed", createdAt: new Date().toISOString(),
    });
  } catch (error) {
    await publishRecord(run.runDirectory, "cleanup.json", {
      kind: "cleanup", generation: run.claim.generation, token: run.claim.token, state: "failed", createdAt: new Date().toISOString(),
    });
  }
}

async function cancellationRequested(run: StoredRun): Promise<boolean> {
  return Boolean(await readRecord(run.runDirectory, "cancel.json"));
}

async function quarantineRequested(run: StoredRun): Promise<boolean> {
  return Boolean(await readRecord(run.runDirectory, "quarantine.json"));
}

async function mayCommitForCurrentAttempt(run: StoredRun): Promise<boolean> {
  try {
    const current = await readStoredRunDirectory(run.runDirectory);
    return stableJson(current.claim) === stableJson(run.claim);
  } catch {
    return false;
  }
}

function cancelledResult(run: StoredRun): SidecarResult {
  return errorResult(run.manifest.normalizedRequest, {
    code: "APP_SERVER_CANCELLED",
    message: "APP_SERVER_CANCELLED: durable work was cancelled before completion",
  });
}

function isAuthLeaseBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "AUTH_LEASE_BUSY");
}

function sleepUntilRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, AUTH_RETRY_MS);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
