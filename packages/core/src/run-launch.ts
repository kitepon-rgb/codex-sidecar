import { spawn } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync } from "node:fs";
import { join } from "node:path";
import { matchesProcessIdentity, processStartIdentity } from "./process-identity.js";
import { attemptDirectory, publishRecord, readClaim, readRecord, type AttemptMarker, type SpawnRecord } from "./run-records.js";
import { stableJson } from "./run-foundation.js";
import type { LaunchClaim, StoredRun } from "./run-types.js";
import type { SidecarRunHandle } from "./types.js";

export interface LaunchOptions {
  timeoutMs?: number;
  terminationGraceMs?: number;
  spawnTimeoutMs?: number;
  /** Explicit worker runtime override for embedders that do not use the current Node executable. */
  executablePath?: string;
  faultAfterSpawnBeforeRecord?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function launchRunWorker(run: StoredRun, entrypoint: string, options: LaunchOptions = {}): Promise<SidecarRunHandle> {
  const lock = join(run.runDirectory, "launch.lock");
  const claim = await readClaim(lock);
  if (stableJson(claim) !== stableJson(run.claim) || !await matchesProcessIdentity(claim.owner)) throw runError("RUN_ORPHANED", "launch claim is not durably owned by this coordinator");
  const attempt = await attemptDirectory(run.runDirectory, claim.generation, claim.token);
  const privateAppend = constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  const graceMs = options.terminationGraceMs ?? 50;
  let stdout: number | undefined;
  let stderr: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let permit: NodeJS.WritableStream | null = null;
  let spawned: SpawnRecord | undefined;
  try {
    stdout = openPrivateLog(join(attempt, "stdout.log"), privateAppend);
    stderr = openPrivateLog(join(attempt, "stderr.log"), privateAppend);
    child = spawn(options.executablePath ?? process.execPath, [entrypoint, run.runDirectory], { detached: true, env: { ...process.env, ...options.env }, stdio: ["ignore", stdout, stderr, "pipe"] });
    permit = child.stdio[3] as NodeJS.WritableStream | null;
    closeFd(stdout); stdout = undefined;
    closeFd(stderr); stderr = undefined;
    await waitForSpawn(child, options.spawnTimeoutMs ?? 1_000);
    if (!child.pid) throw runError("RUN_READY_TIMEOUT", "worker did not receive a process ID");
    spawned = { version: 1, kind: "spawn", generation: claim.generation, token: claim.token, pid: child.pid, pgid: child.pid, processIdentity: { pid: child.pid, startIdentity: await processStartIdentity(child.pid) }, createdAt: new Date().toISOString(), digest: "" };
    if (options.faultAfterSpawnBeforeRecord) throw Object.assign(new Error("injected spawn-to-record fault"), { workerIdentity: spawned.processIdentity });
    await publishRecord(lock, "spawn.json", spawned);
  } catch (error) {
    permit?.end();
    let stopped = child === undefined;
    if (child) {
      try { await stopChild(child, graceMs, true); stopped = true; }
      catch (cleanupError) { Object.assign(error as object, { cleanupError }); }
    }
    if (spawned && stopped) {
      try { await publishFailure(attempt, claim, spawned, "spawn-publish-failed"); }
      catch (failureError) { Object.assign(error as object, { failureError }); }
    }
    throw error;
  } finally {
    closeFd(stdout);
    closeFd(stderr);
  }
  permit?.end();
  if (!child || !spawned) throw runError("RUN_READY_TIMEOUT", "worker was not spawned");
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    while (Date.now() < deadline) {
      if (stableJson(await readClaim(lock)) === stableJson(claim) && await validReady(attempt, claim, spawned)) {
        child.unref();
        return { kind: "run_handle", workflow: "work", runId: run.manifest.runId, state: "running", createdAt: run.manifest.createdAt, pollAfterMs: 250 };
      }
      if (!isAlive(child)) {
        await publishFailure(attempt, claim, spawned, "early-exit");
        throw runError("RUN_READY_TIMEOUT", "worker exited before ready");
      }
      await sleep(10);
    }
    await terminateWorker(child, attempt, claim, spawned, "ready-timeout", graceMs);
    throw runError("RUN_READY_TIMEOUT", "worker did not become ready");
  } catch (error) {
    if (isAlive(child)) {
      try { await terminateWorker(child, attempt, claim, spawned, "ready-invalid", graceMs); }
      catch (cleanupError) { Object.assign(error as object, { cleanupError }); }
    }
    throw error;
  }
}

function openPrivateLog(path: string, flags: number): number { const fd = openSync(path, flags, 0o600); try { fchmodSync(fd, 0o600); return fd; } catch (error) { closeSync(fd); throw error; } }
function closeFd(fd: number | undefined): void { if (fd !== undefined) closeSync(fd); }
async function validReady(attempt: string, claim: LaunchClaim, spawned: SpawnRecord): Promise<boolean> { const ready = await readRecord(attempt, "ready.json"); return Boolean(ready && ready.kind === "ready" && ready.generation === claim.generation && ready.token === claim.token && sameChild(ready as AttemptMarker, spawned)); }
function sameChild(record: AttemptMarker, spawned: SpawnRecord): boolean { return record.pid === spawned.pid && record.pgid === spawned.pgid && stableJson(record.processIdentity) === stableJson(spawned.processIdentity); }
function isAlive(child: ReturnType<typeof spawn>): boolean { return child.exitCode === null && child.signalCode === null; }
async function terminateWorker(child: ReturnType<typeof spawn>, attempt: string, claim: LaunchClaim, spawned: SpawnRecord, reason: "ready-timeout" | "ready-invalid", graceMs: number): Promise<void> { await stopChild(child, graceMs, false); await publishFailure(attempt, claim, spawned, reason); }
async function publishFailure(attempt: string, claim: LaunchClaim, spawned: SpawnRecord, reason: "early-exit" | "ready-timeout" | "ready-invalid" | "spawn-publish-failed"): Promise<void> { await publishRecord(attempt, "failure.json", { kind: "failure", generation: claim.generation, token: claim.token, pid: spawned.pid, pgid: spawned.pgid, processIdentity: spawned.processIdentity, reason, createdAt: new Date().toISOString() }); }

/** Bounded process-group stop; direct child exit/close/error is always observed before returning. */
async function stopChild(child: ReturnType<typeof spawn>, graceMs: number, allowPermitGrace: boolean): Promise<void> {
  if (!isAlive(child)) return;
  if (allowPermitGrace && await waitForChildState(child, graceMs)) return;
  if (child.pid && isAlive(child)) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* state raced */ } }
  if (await waitForChildState(child, graceMs)) return;
  if (child.pid && isAlive(child)) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* state raced */ } }
  if (await waitForChildState(child, graceMs)) return;
  throw new Error("worker did not stop within bounded termination grace");
}

function waitForSpawn(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(() => reject(new Error("worker spawn timed out"))), timeoutMs);
    const done = (finish: () => void) => { clearTimeout(timer); child.off("spawn", onSpawn); child.off("error", onError); child.off("close", onClose); finish(); };
    const onSpawn = () => done(resolve);
    const onError = (error: Error) => done(() => reject(error));
    const onClose = () => done(() => reject(new Error("worker closed before spawn")));
    child.once("spawn", onSpawn); child.once("error", onError); child.once("close", onClose);
  });
}

function waitForChildState(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    const done = (stopped: boolean) => { clearTimeout(timer); child.off("exit", onStopped); child.off("close", onStopped); child.off("error", onError); resolve(stopped); };
    const onStopped = () => done(true);
    const onError = () => done(!isAlive(child));
    child.once("exit", onStopped); child.once("close", onStopped); child.once("error", onError);
  });
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function runError(code: "RUN_ORPHANED" | "RUN_READY_TIMEOUT", message: string): Error & { code: string } { return Object.assign(new Error(`${code}: ${message}`), { code }); }
