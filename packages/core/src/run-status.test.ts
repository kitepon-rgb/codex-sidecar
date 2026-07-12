import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { currentProcessIdentity } from "./process-identity.js";
import { publishRecord, readRecord } from "./run-records.js";
import { openOrCreateRun } from "./run-store.js";
import { inspectStoredWorkRun } from "./run-status.js";
import type { StoredRun } from "./run-types.js";
import type { SidecarRequest, SidecarResult } from "./types.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

test("durable result is promoted to terminal instead of being downgraded after a crash", async (t) => {
  const run = await make(t, false);
  const result = completedResult(run.manifest.normalizedRequest);
  await publishRecord(run.runDirectory, "result.json", { kind: "result", generation: run.claim.generation, token: run.claim.token, result, createdAt: new Date().toISOString() });

  const status = await inspectStoredWorkRun(run);
  assert.equal(status.kind, "run_terminal");
  assert.equal(status.state, "completed");
  assert.equal(status.cleanup, "pending");
  assert.deepEqual(status.result, result);
  assert.equal((await readRecord(run.runDirectory, "terminal.json"))?.kind, "terminal");
});

test("fresh worker heartbeat projects a nonterminal running state", async (t) => {
  const run = await make(t, true);
  const identity = await currentProcessIdentity();
  await publishRecord(join(run.runDirectory, "launch.lock"), "spawn.json", {
    kind: "spawn", generation: run.claim.generation, token: run.claim.token,
    pid: identity.pid, pgid: identity.pid, processIdentity: identity, createdAt: new Date().toISOString(),
  });
  await publishRecord(run.runDirectory, "execution-started.json", {
    kind: "execution-started", generation: run.claim.generation, token: run.claim.token, createdAt: new Date().toISOString(),
  });
  await publishRecord(run.runDirectory, "worker-heartbeat.json", {
    kind: "worker-heartbeat", generation: run.claim.generation, token: run.claim.token,
    pid: identity.pid, pgid: identity.pid, processIdentity: identity, updatedAt: new Date().toISOString(),
  });

  const status = await inspectStoredWorkRun(run);
  assert.deepEqual(status.kind, "run_pending");
  if (status.kind !== "run_pending") throw new Error("expected a pending run");
  assert.equal(status.state, "running");
  assert.equal(status.phase, "execution");
});

test("terminal without a matching durable result is corrupt rather than fabricated", async (t) => {
  const run = await make(t, true);
  await publishRecord(run.runDirectory, "terminal.json", {
    kind: "terminal", generation: run.claim.generation, token: run.claim.token,
    state: "completed", resultDigest: "a".repeat(64), createdAt: new Date().toISOString(),
  });
  await assert.rejects(() => inspectStoredWorkRun(run), { code: "RUN_STORE_CORRUPT" });
});

test("operator quarantine is a terminal interrupted view unless a valid result already won", async (t) => {
  const run = await make(t, true);
  await publishRecord(run.runDirectory, "quarantine.json", {
    kind: "quarantine", generation: run.claim.generation, token: run.claim.token, createdAt: new Date().toISOString(),
  });

  const status = await inspectStoredWorkRun(run);
  assert.equal(status.kind, "run_interrupted");
  if (status.kind !== "run_interrupted") throw new Error("expected quarantined interruption");
  assert.equal(status.terminal, true);
  assert.equal(status.salvageAllowed, false);
  assert.equal(status.state, "interrupted");
});

async function make(t: test.TestContext, preserveWorktree: boolean): Promise<StoredRun> {
  const repo = await mkdtemp(join(tmpdir(), "codex-sidecar-run-status-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  return openOrCreateRun(
    { projectRoot: repo, idempotencyKey: key, rawInput: { prompt: "change README", preserveWorktree } },
    async () => ({ normalizedRequest: request(repo, preserveWorktree) }),
  );
}

function request(projectRoot: string, preserveWorktree: boolean): SidecarRequest {
  return {
    workflow: "work", projectRoot, prompt: "change README", readonly: false, requireWorktree: true,
    focus: [], allowedPaths: ["README.md"], denyPaths: [], safetyProfile: "generic", resultFormat: "json",
    turnTimeoutMs: 1_000, interruptOnTimeout: true, preserveWorktree, context: [], dryRun: false,
  };
}

function completedResult(request: SidecarRequest): SidecarResult {
  return {
    status: "ok", workflow: "work", summary: "done", confidence: { level: "high", rationale: "test" },
    recommendedNextAction: "review", normalizedRequest: request,
  };
}
