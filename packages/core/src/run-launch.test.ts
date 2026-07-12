import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acquireOrReclaimLaunchClaim, launchRunWorker } from "./run-launch.js";
import { matchesProcessIdentity } from "./process-identity.js";
import { attemptDirectory, publishRecord, readRecord, type SpawnRecord } from "./run-records.js";
import { sha256, stableJson } from "./run-foundation.js";
import { openOrCreateRun } from "./run-store.js";
import type { StoredRun } from "./run-types.js";
import type { SidecarRequest } from "./types.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";
const fixture = new URL("./run-launch-fixture.js", import.meta.url).pathname;

test("spawn後ready前のearly exitはhandleを返さずfailureを永続化し、孤児を残さない", async (t) => {
  const run = await make(t);
  await assert.rejects(() => launchRunWorker(run, fixture, { env: { FIXTURE_EARLY_EXIT: "1" } }), { code: "RUN_READY_TIMEOUT" });
  const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
  const failure = await readRecord(attempt, "failure.json");
  assert.equal(failure?.kind, "failure");
  assert.equal(failure?.reason, "early-exit");
  const spawned = await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json");
  assert.equal(spawned?.kind, "spawn");
  assert.equal(await matchesProcessIdentity(spawned!.processIdentity as never), false);
});

test("spawn record publish失敗はpermitを読まないTERM無視workerを回収しfailureを残す", async (t) => {
  const run = await make(t);
  let workerIdentity: unknown;
  await assert.rejects(() => launchRunWorker(run, fixture, { faultAfterSpawnBeforeRecord: true, terminationGraceMs: 10, env: { FIXTURE_NEVER_READ_PERMIT: "1" } }), (error: { workerIdentity?: unknown }) => { workerIdentity = error.workerIdentity; return true; });
  const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
  assert.equal(await readRecord(attempt, "boot.json"), undefined);
  assert.equal(await readRecord(attempt, "ready.json"), undefined);
  assert.equal(await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json"), undefined);
  assert.equal((await readRecord(attempt, "failure.json"))?.reason, "spawn-publish-failed");
  assert.ok(workerIdentity);
  assert.equal(await matchesProcessIdentity(workerIdentity as never), false);
});

test("spawn errorはpid無しでも期限内にrejectしhangしない", async (t) => {
  const run = await make(t);
  const startedAt = Date.now();
  await assert.rejects(() => launchRunWorker(run, fixture, { executablePath: join(run.runDirectory, "missing-node"), spawnTimeoutMs: 50, terminationGraceMs: 10 }));
  assert.ok(Date.now() - startedAt < 1_000);
  const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
  assert.equal(await readRecord(attempt, "failure.json"), undefined);
});

test("happy pathはattempt layout・private mode・同一claim tokenでreadyを永続化する", async (t) => {
  const run = await make(t);
  const handle = await launchRunWorker(run, fixture);
  assert.equal(handle.runId, run.manifest.runId);
  const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
  for (const name of ["boot.json", "ready.json", "stdout.log", "stderr.log"]) assert.equal((await lstat(join(attempt, name))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(run.runDirectory, "attempts"))).mode & 0o777, 0o700);
  const spawn = await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json");
  const ready = await readRecord(attempt, "ready.json");
  assert.equal(spawn?.token, run.claim.token);
  assert.equal(ready?.token, run.claim.token);
  await stop(spawn);
});

test("ready timeoutはTERMを無視するworkerをKILLしてexitを待ちfailureを残す", async (t) => {
  const run = await make(t);
  await assert.rejects(() => launchRunWorker(run, fixture, { timeoutMs: 40, terminationGraceMs: 10, env: { FIXTURE_HANG: "1", FIXTURE_IGNORE_TERM: "1" } }), { code: "RUN_READY_TIMEOUT" });
  const attempt = await attemptDirectory(run.runDirectory, run.claim.generation, run.claim.token);
  const failure = await readRecord(attempt, "failure.json");
  assert.equal(failure?.reason, "ready-timeout");
  const spawned = await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json");
  assert.equal(await matchesProcessIdentity(spawned!.processIdentity as never), false);
});

test("mismatched readyとmalformed readyは拒否・回収する", async (t) => {
  const run = await make(t);
  await assert.rejects(() => launchRunWorker(run, fixture, { timeoutMs: 40, terminationGraceMs: 10, env: { FIXTURE_BAD_READY: "1" } }), { code: "RUN_READY_TIMEOUT" });
  const malformed = await make(t);
  await assert.rejects(() => launchRunWorker(malformed, fixture, { timeoutMs: 500, terminationGraceMs: 10, env: { FIXTURE_MALFORMED_READY: "1", FIXTURE_IGNORE_TERM: "1" } }));
  const malformedAttempt = await attemptDirectory(malformed.runDirectory, malformed.claim.generation, malformed.claim.token);
  assert.equal((await readRecord(malformedAttempt, "failure.json"))?.reason, "ready-invalid");
  const malformedSpawn = await readRecord(join(malformed.runDirectory, "launch.lock"), "spawn.json");
  assert.equal(await matchesProcessIdentity(malformedSpawn!.processIdentity as never), false);
});

test("response discard後もspawn/ready recordを再読できる", async (t) => {
  const run = await make(t);
  await launchRunWorker(run, fixture);
  const retry = await openOrCreateRun({ projectRoot: run.manifest.callerWorktreePath, idempotencyKey: key, rawInput: { prompt: "x" } }, async () => { throw new Error("retry must not prepare"); });
  const attempt = await attemptDirectory(retry.runDirectory, retry.claim.generation, retry.claim.token);
  assert.equal((await readRecord(join(retry.runDirectory, "launch.lock"), "spawn.json"))?.token, retry.claim.token);
  const ready = await readRecord(attempt, "ready.json");
  assert.equal(ready?.token, retry.claim.token);
  await stop(await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json"));
});

test("a foreign process cannot launch a worker from a live coordinator claim", async (t) => {
  const run = await make(t); const module = new URL("./run-launch.js", import.meta.url).pathname;
  const code = `import {launchRunWorker} from ${JSON.stringify(module)}; const run=${JSON.stringify(run)}; launchRunWorker(run,${JSON.stringify(fixture)}).then(()=>process.exit(9),e=>process.exit(e.code==='RUN_ORPHANED'?0:8))`;
  await exec(process.execPath, ["--input-type=module", "-e", code]);
  assert.equal(await readRecord(join(run.runDirectory, "launch.lock"), "spawn.json"), undefined);
});

test("dead pre-spawn publisher is reclaimed under transition with a fenced next generation", async (t) => {
  const run = await make(t); const lock = join(run.runDirectory, "launch.lock");
  await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
  const body = { version: 1 as const, kind: "claim" as const, generation: 4, token: "Z".repeat(43), owner: { pid: 999999, startIdentity: "dead" }, createdAt: "2000-01-01T00:00:00.000Z" };
  const stale = { ...body, digest: sha256(stableJson(body)) };
  await publishRecord(lock, "claim.json", stale); await publishRecord(lock, "heartbeat.json", { kind: "heartbeat", generation: 4, token: stale.token, owner: stale.owner, updatedAt: body.createdAt });
  const reclaimed = await acquireOrReclaimLaunchClaim({ ...run, claim: stale }, { bootGraceMs: 1 });
  assert.equal(reclaimed.claim.generation, 5);
  assert.notEqual(reclaimed.claim.token, stale.token);
  assert.equal((await readRecord(join(run.runDirectory, "launch.lock.tombstone-4-" + stale.token), "claim.json"))?.token, stale.token);
});

test("reclaim resumes from a durable tombstone after the launcher dies before next claim", async (t) => {
  const run = await make(t); const lock = join(run.runDirectory, "launch.lock");
  await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
  const body = { version: 1 as const, kind: "claim" as const, generation: 3, token: "V".repeat(43), owner: { pid: 999999, startIdentity: "dead" }, createdAt: "2000-01-01T00:00:00.000Z" }; const stale = { ...body, digest: sha256(stableJson(body)) };
  await publishRecord(lock, "claim.json", stale); await publishRecord(lock, "heartbeat.json", { kind: "heartbeat", generation: 3, token: stale.token, owner: stale.owner, updatedAt: body.createdAt });
  await assert.rejects(() => acquireOrReclaimLaunchClaim({ ...run, claim: stale }, { bootGraceMs: 1, faultAfterTombstone: true }));
  await assert.rejects(() => lstat(lock), { code: "ENOENT" });
  const recovered = await acquireOrReclaimLaunchClaim({ ...run, claim: stale }, { bootGraceMs: 1 });
  assert.equal(recovered.claim.generation, 4);
});

test("an exited OS publisher is reclaimed and concurrent callers converge on one claim", async (t) => {
  const run = await make(t); const lock = join(run.runDirectory, "launch.lock");
  const identityModule = new URL("./process-identity.js", import.meta.url).pathname;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `import {currentProcessIdentity} from ${JSON.stringify(identityModule)}; console.log(JSON.stringify(await currentProcessIdentity()))`], { encoding: "utf8" });
  const deadOwner = JSON.parse(stdout.trim()) as { pid: number; startIdentity: string };
  await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
  const body = { version: 1 as const, kind: "claim" as const, generation: 7, token: "W".repeat(43), owner: deadOwner, createdAt: "2000-01-01T00:00:00.000Z" };
  const stale = { ...body, digest: sha256(stableJson(body)) };
  await publishRecord(lock, "claim.json", stale); await publishRecord(lock, "heartbeat.json", { kind: "heartbeat", generation: 7, token: stale.token, owner: stale.owner, updatedAt: body.createdAt });
  const [a, b] = await Promise.all([acquireOrReclaimLaunchClaim({ ...run, claim: stale }, { bootGraceMs: 1 }), acquireOrReclaimLaunchClaim({ ...run, claim: stale }, { bootGraceMs: 1 })]);
  assert.equal(a.claim.generation, 8); assert.equal(b.claim.generation, 8); assert.equal(a.claim.token, b.claim.token);
  assert.equal((await readRecord(join(run.runDirectory, "launch.lock"), "claim.json"))?.token, a.claim.token);
});

test("dead publisher with spawn, boot, or execution evidence is never automatically reclaimed", async (t) => {
  for (const evidence of ["spawn", "boot", "execution", "unsafe-attempt"] as const) await t.test(evidence, async (t) => {
    const run = await make(t); const lock = join(run.runDirectory, "launch.lock"); await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
    const body = { version: 1 as const, kind: "claim" as const, generation: 2, token: "Y".repeat(43), owner: { pid: 999999, startIdentity: "dead" }, createdAt: "2000-01-01T00:00:00.000Z" }; const stale = { ...body, digest: sha256(stableJson(body)) };
    await publishRecord(lock, "claim.json", stale); await publishRecord(lock, "heartbeat.json", { kind: "heartbeat", generation: 2, token: stale.token, owner: stale.owner, updatedAt: body.createdAt });
    if (evidence === "spawn") await publishRecord(lock, "spawn.json", { kind: "spawn", generation: 2, token: stale.token, pid: 2, pgid: 2, processIdentity: { pid: 2, startIdentity: "x" }, createdAt: body.createdAt });
    if (evidence === "boot") { const attempt = await attemptDirectory(run.runDirectory, 2, stale.token); await publishRecord(attempt, "boot.json", { kind: "boot", generation: 2, token: stale.token, pid: 2, pgid: 2, processIdentity: { pid: 2, startIdentity: "x" }, createdAt: body.createdAt }); }
    if (evidence === "execution") await publishRecord(run.runDirectory, "execution-started.json", { kind: "execution-started", generation: 2, token: stale.token, createdAt: body.createdAt });
    if (evidence === "unsafe-attempt") { const attempts = join(run.runDirectory, "attempts"); await mkdir(attempts, { mode: 0o700 }); await symlink("/tmp", join(attempts, `2-${stale.token}`)); }
    await assert.rejects(() => acquireOrReclaimLaunchClaim({ ...run, claim: stale }, { bootGraceMs: 1 }), { code: "RUN_ORPHANED" });
    assert.equal((await readRecord(lock, "claim.json"))?.token, stale.token);
  });
});

async function make(t: test.TestContext): Promise<StoredRun> {
  const repo = await mkdtemp(join(tmpdir(), "launch-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "x@y.z"], { cwd: repo });
  await exec("git", ["config", "user.name", "x"], { cwd: repo });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(repo, "a"), "x"));
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "x"], { cwd: repo });
  return openOrCreateRun({ projectRoot: repo, idempotencyKey: key, rawInput: { prompt: "x" } }, () => Promise.resolve({ normalizedRequest: request(repo) }));
}

function request(projectRoot: string): SidecarRequest {
  return { workflow: "work", projectRoot, readonly: false, requireWorktree: true, focus: [], allowedPaths: ["a"], denyPaths: [], safetyProfile: "generic", resultFormat: "json", turnTimeoutMs: 1, interruptOnTimeout: true, preserveWorktree: true, context: [], dryRun: false };
}
async function stop(record: Awaited<ReturnType<typeof readRecord>>): Promise<void> {
  if (record?.kind === "spawn") {
    const spawned = record as SpawnRecord;
    try { process.kill(-spawned.pid, "SIGKILL"); } catch {}
    for (let index = 0; index < 50 && await matchesProcessIdentity(spawned.processIdentity); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await matchesProcessIdentity(spawned.processIdentity), false);
  }
}
