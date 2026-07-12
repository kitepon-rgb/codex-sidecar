import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentProcessIdentity } from "./process-identity.js";
import { attemptDirectory, publishRecord, readRecord, replaceWorkerHeartbeat } from "./run-records.js";
import { stableJson } from "./run-foundation.js";
import { readStoredRunDirectory } from "./run-store.js";
import { executeDurableWorkRun } from "./work-run-worker.js";

export function workerEntrypoint(): string { return new URL("./run-worker.js", import.meta.url).pathname; }

export interface RunWorkerOptions { heartbeatIntervalMs?: number; }

export async function runWorker(
  runDirectory: string,
  action: (signal: AbortSignal) => Promise<void> = (signal) => executeDurableWorkRun(runDirectory, signal),
  options: RunWorkerOptions = {},
): Promise<void> {
  const intervalMs = options.heartbeatIntervalMs ?? 1_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 10) throw Object.assign(new Error("RUN_INVALID_INPUT: heartbeatIntervalMs must be at least 10"), { code: "RUN_INVALID_INPUT" });
  readFileSync(3); // No run filesystem read or write is allowed before permit EOF.
  const run = await readStoredRunDirectory(runDirectory);
  const lock = join(runDirectory, "launch.lock");
  const spawned = await readRecord(lock, "spawn.json");
  const identity = await currentProcessIdentity();
  if (!spawned || spawned.kind !== "spawn" || spawned.generation !== run.claim.generation || spawned.token !== run.claim.token || spawned.pid !== process.pid || spawned.pgid !== process.pid || stableJson(spawned.processIdentity) !== stableJson(identity)) return;
  const attempt = await attemptDirectory(runDirectory, run.claim.generation, run.claim.token);
  await publishRecord(attempt, "boot.json", { kind: "boot", generation: run.claim.generation, token: run.claim.token, pid: process.pid, pgid: process.pid, processIdentity: identity, createdAt: new Date().toISOString() });
  if (stableJson((await readStoredRunDirectory(runDirectory)).claim) !== stableJson(run.claim)) return;
  const cancellation = new AbortController();
  const onTerminate = () => cancellation.abort(new Error("worker termination requested"));
  process.once("SIGTERM", onTerminate);
  process.once("SIGINT", onTerminate);
  await replaceWorkerHeartbeat(runDirectory, run.claim, identity);
  await publishRecord(attempt, "ready.json", { kind: "ready", generation: run.claim.generation, token: run.claim.token, pid: process.pid, pgid: process.pid, processIdentity: identity, createdAt: new Date().toISOString() });
  let heartbeatFailure: unknown;
  let pulse: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pulse || heartbeatFailure) return;
    pulse = replaceWorkerHeartbeat(runDirectory, run.claim, identity)
      .catch((error) => { heartbeatFailure = error; cancellation.abort(error); })
      .finally(() => { pulse = undefined; });
  }, intervalMs);
  try {
    await action(cancellation.signal);
    if (pulse) await pulse;
    if (heartbeatFailure) throw heartbeatFailure;
  } finally {
    clearInterval(timer);
    process.off("SIGTERM", onTerminate);
    process.off("SIGINT", onTerminate);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) await runWorker(process.argv[2]!);
