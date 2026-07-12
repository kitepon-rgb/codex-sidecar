import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { beginRunExecution, requestRunCancellation } from "./run-control.js";
import { publishRecord, readRecord } from "./run-records.js";
import { openOrCreateRun } from "./run-store.js";
import type { StoredRun } from "./run-types.js";
import type { SidecarRequest } from "./types.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

test("pre-start cancel wins the transition and fences execution", async (t) => {
  const run = await make(t);
  const ack = await requestRunCancellation(run);
  assert.equal(ack.mode, "pre_start_fenced");
  assert.equal((await beginRunExecution(run)).state, "cancelled-before-start");
  assert.equal(await readRecord(run.runDirectory, "execution-started.json"), undefined);
  assert.equal((await requestRunCancellation(run)).state, "already_requested");
});

test("execution first makes later cancellation cooperative", async (t) => {
  const run = await make(t);
  assert.equal((await beginRunExecution(run)).state, "started");
  const ack = await requestRunCancellation(run);
  assert.equal(ack.mode, "cooperative");
  assert.equal(ack.accepted, true);
  assert.equal((await beginRunExecution(run)).state, "started");
});

test("parallel cancel and execution have one durable order", async (t) => {
  const run = await make(t);
  const [cancel, execution] = await Promise.allSettled([requestRunCancellation(run), beginRunExecution(run)]);
  assert.equal(cancel.status, "fulfilled"); assert.equal(execution.status, "fulfilled");
  const ack = cancel.status === "fulfilled" ? cancel.value : undefined;
  const start = execution.status === "fulfilled" ? execution.value : undefined;
  assert.ok(ack && start);
  assert.equal(ack.mode === "pre_start_fenced", start.state === "cancelled-before-start");
  assert.equal(ack.mode === "cooperative", start.state === "started");
});

test("terminal is not overwritten by cancellation", async (t) => {
  const run = await make(t);
  await publishRecord(run.runDirectory, "terminal.json", { kind: "terminal", generation: run.claim.generation, token: run.claim.token, state: "failed", resultDigest: "a".repeat(64), createdAt: new Date().toISOString() });
  const ack = await requestRunCancellation(run);
  assert.equal(ack.accepted, false); assert.equal(ack.terminal, true); assert.equal(ack.mode, "terminal");
  assert.equal(await readRecord(run.runDirectory, "cancel.json"), undefined);
});

async function make(t: test.TestContext): Promise<StoredRun> {
  const repo = await mkdtemp(join(tmpdir(), "run-control-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo }); await exec("git", ["config", "user.email", "x@y.z"], { cwd: repo }); await exec("git", ["config", "user.name", "x"], { cwd: repo });
  await writeFile(join(repo, "a"), "x"); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "x"], { cwd: repo });
  return openOrCreateRun({ projectRoot: repo, idempotencyKey: key, rawInput: { prompt: "x" } }, () => Promise.resolve({ normalizedRequest: request(repo) }));
}

function request(projectRoot: string): SidecarRequest { return { workflow: "work", projectRoot, readonly: false, requireWorktree: true, focus: [], allowedPaths: ["a"], denyPaths: [], safetyProfile: "generic", resultFormat: "json", turnTimeoutMs: 1, interruptOnTimeout: true, preserveWorktree: true, context: [], dryRun: false }; }
