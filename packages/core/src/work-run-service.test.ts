import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readRecord } from "./run-records.js";
import { matchesProcessIdentity } from "./process-identity.js";
import { cancelWorkRun, getWorkRunResult, startWorkRun } from "./work-run-service.js";
import type { SidecarConfig } from "./types.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";
const fixtureWorker = new URL("./run-worker-fixture.js", import.meta.url).pathname;

test("dry-run start commits a retrievable terminal result without a worker", async (t) => {
  const repo = await repository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const input = { projectRoot: repo, idempotencyKey: key, prompt: "change README", dryRun: true } as const;
  let initialConfigLoads = 0;
  const first = await startWorkRun(async () => {
    initialConfigLoads += 1;
    return config();
  }, input);
  assert.equal(first.kind, "run_terminal", JSON.stringify(first));
  if (first.kind !== "run_terminal") throw new Error("expected dry-run terminal result");
  assert.equal(first.result.status, "dry-run");
  assert.equal(initialConfigLoads, 1);

  let retryConfigLoads = 0;
  const retry = await startWorkRun(async () => {
    retryConfigLoads += 1;
    throw new Error("existing run retry must not reload config");
  }, input);
  assert.equal(retry.kind, "run_terminal");
  assert.equal(retryConfigLoads, 0);
  const result = await getWorkRunResult({ projectRoot: repo, idempotencyKey: key });
  assert.equal(result.kind, "run_terminal");
});

test("same idempotency key with different raw start input is an explicit run error", async (t) => {
  const repo = await repository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await startWorkRun(config(), { projectRoot: repo, idempotencyKey: key, prompt: "first", dryRun: true });
  const conflict = await startWorkRun(config(), { projectRoot: repo, idempotencyKey: key, prompt: "second", dryRun: true });
  assert.equal(conflict.kind, "run_error");
  if (conflict.kind !== "run_error") throw new Error("expected a run error");
  assert.equal(conflict.error.code, "RUN_KEY_CONFLICT");
});

test("retry returns the existing worker handle rather than spawning a second worker", async (t) => {
  const repo = await repository();
  const input = { projectRoot: repo, idempotencyKey: key, prompt: "change README" } as const;
  const options = {
    workerEntrypoint: fixtureWorker,
    launch: { env: { FIXTURE_HANG: "1", FIXTURE_HEARTBEAT_MS: "20" } },
  };
  const first = await startWorkRun(config(), input, options);
  assert.equal(first.kind, "run_handle");
  if (first.kind !== "run_handle") throw new Error("expected worker handle");
  const spawn = await readRecord(join(repo, ".git", "codex-sidecar", "runs", first.runId, "launch.lock"), "spawn.json");
  if (spawn?.kind !== "spawn") throw new Error("expected durable spawn record");
  const spawned = spawn as typeof spawn & { pid: number; processIdentity: { pid: number; startIdentity: string } };
  t.after(async () => {
    try { process.kill(-spawned.pid, "SIGKILL"); } catch {}
    for (let index = 0; index < 100 && await matchesProcessIdentity(spawned.processIdentity as never); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await rm(repo, { recursive: true, force: true });
  });

  const retry = await startWorkRun(undefined as unknown as SidecarConfig, input, options);
  assert.equal(retry.kind, "run_handle");
  if (retry.kind !== "run_handle") throw new Error("expected retry handle");
  assert.equal(retry.runId, first.runId);
  const sameSpawn = await readRecord(join(repo, ".git", "codex-sidecar", "runs", first.runId, "launch.lock"), "spawn.json");
  assert.deepEqual(sameSpawn, spawn);

  const pending = await waitForPending(repo, key);
  assert.equal(pending.state, "queued");
  const cancellation = await cancelWorkRun({ projectRoot: repo, idempotencyKey: key });
  assert.equal(cancellation.kind, "run_cancel_ack");
});

async function waitForPending(projectRoot: string, idempotencyKey: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await getWorkRunResult({ projectRoot, idempotencyKey });
    if (result.kind === "run_pending") return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("worker heartbeat was not observed");
}

function config(): SidecarConfig {
  return { project: "test", allowed_paths: ["README.md"] };
}

async function repository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "codex-sidecar-work-run-"));
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}
