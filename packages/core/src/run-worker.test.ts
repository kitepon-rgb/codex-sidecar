import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { processStartIdentity } from "./process-identity.js";
import { attemptDirectory, publishRecord, readHeartbeat, readRecord, replaceWorkerHeartbeat } from "./run-records.js";
import { openOrCreateRun } from "./run-store.js";
import type { StoredRun } from "./run-types.js";
import type { SidecarRequest } from "./types.js";

const exec = promisify(execFile);
const key = "worker-handshake-key-01";
const fixture = new URL("./run-worker-fixture.js", import.meta.url).pathname;

test("permit EOF前はrun directoryを読まず書かず、解放後にboot→readyをpublishする", async (t) => {
  const run = await makeRun(t);
  const claimPath = join(run.runDirectory, "launch.lock", "claim.json");
  const child = await spawnBlocked(run);
  await chmod(claimPath, 0o000);
  await delay(80);
  assert.equal(child.exitCode, null, "worker must not read the unreadable claim before permit EOF");
  const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
  assert.equal(await readRecord(attempt, "boot.json"), undefined);
  assert.equal(await readRecord(attempt, "ready.json"), undefined);
  await chmod(claimPath, 0o600);
  await publishValidSpawn(run, child);
  closePermit(child);
  await waitForClose(child);
  const boot = await readRecord(attempt, "boot.json");
  const ready = await readRecord(attempt, "ready.json");
  assert.equal(boot?.kind, "boot");
  assert.equal(ready?.kind, "ready");
  assert.equal(boot?.token, run.claim.token);
  assert.equal(ready?.token, run.claim.token);
  assert.equal(boot?.generation, run.claim.generation);
  assert.equal(ready?.generation, run.claim.generation);
});

for (const mismatch of ["token", "generation", "pid"] as const) {
  test(`spawn ${mismatch} mismatchはboot前に終了する`, async (t) => {
    const run = await makeRun(t);
    const child = await spawnBlocked(run);
    assert.ok(child.pid);
    const identity = { pid: child.pid, startIdentity: await processStartIdentity(child.pid) };
    await publishRecord(join(run.runDirectory, "launch.lock"), "spawn.json", {
      kind: "spawn",
      generation: mismatch === "generation" ? run.claim.generation + 1 : run.claim.generation,
      token: mismatch === "token" ? "Z".repeat(43) : run.claim.token,
      pid: mismatch === "pid" ? child.pid + 1 : child.pid,
      pgid: child.pid,
      processIdentity: identity,
      createdAt: new Date().toISOString(),
    });
    closePermit(child);
    await waitForClose(child);
    const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
    assert.equal(await readRecord(attempt, "boot.json"), undefined);
    assert.equal(await readRecord(attempt, "ready.json"), undefined);
  });
}

test("spawn recordなしのpermit EOFは副作用なしで終了する", async (t) => {
  const run = await makeRun(t);
  const child = await spawnBlocked(run);
  closePermit(child);
  await waitForClose(child);
  const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
  assert.equal(await readRecord(attempt, "boot.json"), undefined);
  assert.equal(await readRecord(attempt, "ready.json"), undefined);
  assert.equal(await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json"), undefined);
});

test("foreign process cannot forge the spawned worker heartbeat", async (t) => {
  const run = await makeRun(t); const child = await spawnBlocked(run); assert.ok(child.pid);
  await publishValidSpawn(run, child);
  const identity = { pid: child.pid, startIdentity: await processStartIdentity(child.pid) };
  await assert.rejects(() => replaceWorkerHeartbeat(run.runDirectory, run.claim, identity), { code: "RUN_STORE_CORRUPT" });
  assert.equal(await readRecord(run.runDirectory, "worker-heartbeat.json"), undefined);
  closePermit(child); await waitForClose(child);
});

test("worker heartbeatはrun-level単一writerで更新しlauncher heartbeatを変更しない", async (t) => {
  const run = await makeRun(t);
  const child = await spawnBlocked(run, { FIXTURE_HANG: "1", FIXTURE_HEARTBEAT_MS: "20" });
  await publishValidSpawn(run, child); closePermit(child);
  const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
  await waitForRecord(attempt, "ready.json");
  const launcherBefore = await readHeartbeat(join(run.runDirectory, "launch.lock"), run.claim);
  const workerBefore = await readRecord(run.runDirectory, "worker-heartbeat.json");
  assert.equal(workerBefore?.kind, "worker-heartbeat");
  await delay(80);
  const workerAfter = await readRecord(run.runDirectory, "worker-heartbeat.json");
  assert.equal(workerAfter?.kind, "worker-heartbeat");
  assert.ok(Date.parse(String(workerAfter?.updatedAt)) > Date.parse(String(workerBefore?.updatedAt)));
  assert.deepEqual(await readHeartbeat(join(run.runDirectory, "launch.lock"), run.claim), launcherBefore);
  process.kill(-child.pid!, "SIGTERM"); await waitForClose(child);
});

async function spawnBlocked(run: StoredRun, env: NodeJS.ProcessEnv = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, [fixture, run.runDirectory], { detached: true, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker spawn timed out")), 1_000);
    child.once("spawn", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  return child;
}

async function publishValidSpawn(run: StoredRun, child: ChildProcess): Promise<void> {
  assert.ok(child.pid);
  await publishRecord(join(run.runDirectory, "launch.lock"), "spawn.json", {
    kind: "spawn", generation: run.claim.generation, token: run.claim.token,
    pid: child.pid, pgid: child.pid,
    processIdentity: { pid: child.pid, startIdentity: await processStartIdentity(child.pid) },
    createdAt: new Date().toISOString(),
  });
}

function closePermit(child: ChildProcess): void { (child.stdio[3] as NodeJS.WritableStream | null)?.end(); }
function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } reject(new Error("worker close timed out")); }, 2_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForRecord(directory: string, name: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { if (await readRecord(directory, name)) return; await delay(10); }
  throw new Error(`record timed out: ${name}`);
}

async function makeRun(t: test.TestContext): Promise<StoredRun> {
  const repo = await mkdtemp(join(tmpdir(), "worker-handshake-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "worker@example.test"], { cwd: repo });
  await exec("git", ["config", "user.name", "worker-test"], { cwd: repo });
  await writeFile(join(repo, "a"), "x");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repo });
  return openOrCreateRun({ projectRoot: repo, idempotencyKey: key, rawInput: { prompt: "worker" } }, () => Promise.resolve({ normalizedRequest: request(repo) }));
}

function request(projectRoot: string): SidecarRequest {
  return { workflow: "work", projectRoot, readonly: false, requireWorktree: true, focus: [], allowedPaths: ["a"], denyPaths: [], safetyProfile: "generic", resultFormat: "json", turnTimeoutMs: 1, interruptOnTimeout: true, preserveWorktree: true, context: [], dryRun: false };
}
