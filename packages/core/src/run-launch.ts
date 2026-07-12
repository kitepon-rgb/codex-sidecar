import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, openSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { currentProcessIdentity, matchesProcessIdentity, processStartIdentity } from "./process-identity.js";
import { attemptDirectory, publishRecord, readClaim, readHeartbeat, readRecord, type AttemptMarker, type SpawnRecord } from "./run-records.js";
import { sha256, stableJson } from "./run-foundation.js";
import type { LaunchClaim, StoredRun } from "./run-types.js";
import type { SidecarRunHandle } from "./types.js";
import { withRunTransition } from "./run-transition.js";

export interface LaunchOptions {
  timeoutMs?: number;
  terminationGraceMs?: number;
  spawnTimeoutMs?: number;
  /** Explicit worker runtime override for embedders that do not use the current Node executable. */
  executablePath?: string;
  faultAfterSpawnBeforeRecord?: boolean;
  env?: NodeJS.ProcessEnv;
  bootGraceMs?: number;
  faultAfterTombstone?: boolean;
}

/** Returns the live claim, or atomically fences a pre-spawn dead publisher. */
export async function acquireOrReclaimLaunchClaim(run: StoredRun, options: Pick<LaunchOptions, "bootGraceMs" | "faultAfterTombstone"> = {}): Promise<StoredRun> {
  const lock = join(run.runDirectory, "launch.lock");
  const current = await optionalLaunchClaim(lock);
  if (current && await matchesProcessIdentity(current.owner)) return { ...run, claim: current };
  return withRunTransition(run.runDirectory, async () => {
    const observed = await optionalLaunchClaim(lock);
    if (observed) {
      if (await matchesProcessIdentity(observed.owner)) return { ...run, claim: observed };
      if (await reclaimBlocked(run, observed, options.bootGraceMs ?? 5_000, lock)) throw runError("RUN_ORPHANED", "stale launch claim has durable worker evidence");
      const tombstone = join(run.runDirectory, `launch.lock.tombstone-${observed.generation}-${observed.token}`);
      await rename(lock, tombstone);
      const moved = await readClaim(tombstone);
      if (stableJson(moved) !== stableJson(observed)) throw runError("RUN_ORPHANED", "launch claim changed during reclaim");
      if (options.faultAfterTombstone) throw new Error("injected launch tombstone fault");
      return publishFreshLaunch(run, await maxGeneration(run.runDirectory, observed.generation) + 1);
    }
    const tombstone = await latestLaunchTombstone(run.runDirectory);
    if (!tombstone) throw runError("RUN_ORPHANED", "launch lock is missing without a reclaim tombstone");
    if (await reclaimBlocked(run, tombstone.claim, options.bootGraceMs ?? 5_000, tombstone.path)) throw runError("RUN_ORPHANED", "tombstoned launch has durable worker evidence");
    return publishFreshLaunch(run, await maxGeneration(run.runDirectory, tombstone.claim.generation) + 1);
  });
}

async function reclaimBlocked(run: StoredRun, claim: LaunchClaim, bootGraceMs: number, lock: string): Promise<boolean> {
  if (await readRecord(lock, "spawn.json")) return true;
  const attempt = join(run.runDirectory, "attempts", `${claim.generation}-${claim.token}`);
  try {
    const info = await lstat(attempt);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw runError("RUN_ORPHANED", "attempt path is unsafe for launch reclaim");
    if (await readRecord(attempt, "boot.json")) return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (await readRecord(run.runDirectory, "execution-started.json")) return true;
  const heartbeat = await readHeartbeat(lock, claim);
  if (Date.now() - Date.parse(heartbeat.updatedAt) < bootGraceMs) return true;
  return false;
}
async function optionalLaunchClaim(lock: string): Promise<LaunchClaim | undefined> { try { await lstat(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } return readClaim(lock); }
async function latestLaunchTombstone(runDirectory: string): Promise<{ path: string; claim: LaunchClaim } | undefined> {
  const names = (await readdir(runDirectory)).filter((name) => name.startsWith("launch.lock.tombstone-"));
  const records: Array<{ path: string; claim: LaunchClaim }> = [];
  for (const name of names) {
    const match = name.match(/^launch\.lock\.tombstone-(\d+)-([A-Za-z0-9_-]{43})$/);
    if (!match) throw runError("RUN_ORPHANED", "invalid launch tombstone identity");
    const path = join(runDirectory, name); const claim = await readClaim(path);
    if (claim.generation !== Number(match[1]) || claim.token !== match[2]) throw runError("RUN_ORPHANED", "launch tombstone does not bind its claim");
    records.push({ path, claim });
  }
  records.sort((a, b) => b.claim.generation - a.claim.generation);
  return records[0];
}
async function publishFreshLaunch(run: StoredRun, generation: number): Promise<StoredRun> {
  const lock = join(run.runDirectory, "launch.lock"); const temp = join(run.runDirectory, `.launch-next-${randomToken()}`);
  await mkdir(temp, { mode: 0o700 });
  try {
    const owner = await currentProcessIdentity();
    const body = { version: 1 as const, kind: "claim" as const, generation, token: randomToken(), owner, createdAt: new Date().toISOString() };
    const claim: LaunchClaim = { ...body, digest: sha256(stableJson(body)) };
    await publishRecord(temp, "claim.json", claim); await publishRecord(temp, "heartbeat.json", { kind: "heartbeat", generation, token: claim.token, owner, updatedAt: claim.createdAt });
    await rename(temp, lock);
    return { ...run, claim };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
async function maxGeneration(runDirectory: string, current: number): Promise<number> {
  let names: string[];
  try { names = await readdir(join(runDirectory, "attempts")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return current; throw error; }
  const generations = names.map((name) => {
    const match = name.match(/^(\d+)-([A-Za-z0-9_-]{43})$/);
    if (!match) throw runError("RUN_ORPHANED", "attempt directory has an invalid generation identity");
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation < 1) throw runError("RUN_ORPHANED", "attempt generation is invalid");
    return generation;
  });
  const maximum = Math.max(current, ...generations);
  if (!Number.isSafeInteger(maximum) || maximum >= Number.MAX_SAFE_INTEGER) throw runError("RUN_ORPHANED", "launch generation cannot be incremented safely");
  return maximum;
}
function randomToken(): string { return randomBytes(32).toString("base64url"); }

export async function launchRunWorker(run: StoredRun, entrypoint: string, options: LaunchOptions = {}): Promise<SidecarRunHandle> {
  const lock = join(run.runDirectory, "launch.lock");
  const claim = await readClaim(lock);
  const caller = await currentProcessIdentity();
  if (stableJson(claim) !== stableJson(run.claim) || stableJson(claim.owner) !== stableJson(caller)) throw runError("RUN_ORPHANED", "launch claim is not durably owned by this coordinator");
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
