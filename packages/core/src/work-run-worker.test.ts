import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { requestRunCancellation } from "./run-control.js";
import { readRecord } from "./run-records.js";
import { openOrCreateRun } from "./run-store.js";
import { inspectStoredWorkRun } from "./run-status.js";
import { executeDurableWorkRun } from "./work-run-worker.js";
import type { SidecarRequest } from "./types.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

test("pre-start cancellation commits a cancelled terminal without acquiring auth or starting a worktree", async (t) => {
  const run = await make(t);
  const cancel = await requestRunCancellation(run);
  assert.equal(cancel.mode, "pre_start_fenced");

  await executeDurableWorkRun(run.runDirectory, new AbortController().signal);

  const terminal = await inspectStoredWorkRun(run);
  assert.equal(terminal.kind, "run_terminal");
  if (terminal.kind !== "run_terminal") throw new Error("expected a terminal run");
  assert.equal(terminal.state, "cancelled");
  assert.equal(terminal.result.error?.code, "APP_SERVER_CANCELLED");
  assert.equal(await readRecord(run.runDirectory, "execution-started.json"), undefined);
  assert.equal((await readRecord(run.runDirectory, "result.json"))?.kind, "result");
});

async function make(t: test.TestContext) {
  const repo = await mkdtemp(join(tmpdir(), "codex-sidecar-work-run-worker-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  return openOrCreateRun(
    { projectRoot: repo, idempotencyKey: key, rawInput: { prompt: "change README" } },
    async () => ({ normalizedRequest: request(repo) }),
  );
}

function request(projectRoot: string): SidecarRequest {
  return {
    workflow: "work", projectRoot, prompt: "change README", readonly: false, requireWorktree: true,
    focus: [], allowedPaths: ["README.md"], denyPaths: [], safetyProfile: "generic", resultFormat: "json",
    turnTimeoutMs: 1_000, interruptOnTimeout: true, preserveWorktree: true, context: [], dryRun: false,
  };
}
