import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { launchRunWorker } from "./run-launch.js";
import { matchesProcessIdentity } from "./process-identity.js";
import { attemptDirectory, readRecord, type SpawnRecord } from "./run-records.js";
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
