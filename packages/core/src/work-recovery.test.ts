import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { publishRecord, readRecord } from "./run-records.js";
import { openOrCreateRun } from "./run-store.js";
import { inspectWorkRecovery, recoverWorkRun } from "./work-recovery.js";
import type { StoredRun, WorkRecoverInput } from "./run-types.js";
import type { SidecarRequest, SidecarResult } from "./types.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

test("work-recover inspection is read-only and exposes an interrupted worker without creating a transition", async (t) => {
  const run = await make(t);
  await deadSpawn(run);

  const inspection = await inspectWorkRecovery({ projectRoot: run.manifest.callerWorktreePath, idempotencyKey: key });
  assert.equal(inspection.outcome, "inspection");
  assert.equal(inspection.quarantinePublished, false);
  assert.equal(inspection.status.kind, "run_interrupted");
  if (inspection.status.kind !== "run_interrupted") throw new Error("expected interrupted worker view");
  assert.equal(inspection.status.terminal, false);
  await assert.rejects(() => lstat(join(run.runDirectory, "transition")), { code: "ENOENT" });
  assert.equal(await readRecord(run.runDirectory, "quarantine.json"), undefined);
});

test("work-recover mutation requires the exact quarantine action and confirmation", async (t) => {
  const run = await make(t);
  await assert.rejects(
    () => recoverWorkRun({ projectRoot: run.manifest.callerWorktreePath, idempotencyKey: key, action: "quarantine" } as unknown as WorkRecoverInput),
    { code: "RUN_INVALID_INPUT" },
  );
  assert.equal(await readRecord(run.runDirectory, "quarantine.json"), undefined);
});

test("confirmed work-recover writes a current-generation quarantine and returns terminal interrupted state", async (t) => {
  const run = await make(t);
  await deadSpawn(run);

  const recovered = await recoverWorkRun({
    projectRoot: run.manifest.callerWorktreePath,
    idempotencyKey: key,
    action: "quarantine",
    confirmNoRunningProcesses: true,
  });
  assert.equal(recovered.outcome, "quarantined");
  assert.equal(recovered.quarantinePublished, true);
  assert.equal(recovered.status.kind, "run_interrupted");
  if (recovered.status.kind !== "run_interrupted") throw new Error("expected terminal interrupted quarantine");
  assert.equal(recovered.status.terminal, true);
  assert.equal(recovered.status.salvageAllowed, false);
  const quarantine = await readRecord(run.runDirectory, "quarantine.json");
  assert.equal(quarantine?.kind, "quarantine");
  assert.equal(quarantine?.generation, run.claim.generation);
  assert.equal(quarantine?.token, run.claim.token);
});

test("work-recover never downgrades or repairs an already durable result", async (t) => {
  const run = await make(t);
  const result = completedResult(run.manifest.normalizedRequest);
  await publishRecord(run.runDirectory, "result.json", {
    kind: "result", generation: run.claim.generation, token: run.claim.token, result, createdAt: new Date().toISOString(),
  });

  const inspection = await inspectWorkRecovery({
    projectRoot: run.manifest.callerWorktreePath,
    idempotencyKey: key,
  });
  assert.equal(inspection.status.kind, "run_terminal");
  assert.equal(await readRecord(run.runDirectory, "terminal.json"), undefined);

  const recovered = await recoverWorkRun({
    projectRoot: run.manifest.callerWorktreePath,
    idempotencyKey: key,
    action: "quarantine",
    confirmNoRunningProcesses: true,
  });
  assert.equal(recovered.outcome, "result-preserved");
  assert.equal(recovered.quarantinePublished, false);
  assert.equal(recovered.status.kind, "run_terminal");
  assert.equal(await readRecord(run.runDirectory, "quarantine.json"), undefined);
  assert.equal(await readRecord(run.runDirectory, "terminal.json"), undefined);
});

test("work-recover refuses terminal quarantine after the auth App Server write-ahead marker", async (t) => {
  const run = await make(t);
  const authDirectory = join(run.runDirectory, "auth");
  await mkdir(authDirectory, { mode: 0o700 });
  await writeFile(join(authDirectory, "app-server-started.json"), "{}\n", { mode: 0o600 });

  await assert.rejects(
    () => recoverWorkRun({
      projectRoot: run.manifest.callerWorktreePath,
      idempotencyKey: key,
      action: "quarantine",
      confirmNoRunningProcesses: true,
    }),
    { code: "RUN_AUTH_UNCERTAIN" },
  );
  assert.equal(await readRecord(run.runDirectory, "quarantine.json"), undefined);
});

test("confirmed work-recover audits and releases only a captured dead transition before quarantine", async (t) => {
  const run = await make(t);
  await abandonTransition(run.runDirectory);

  const recovered = await recoverWorkRun({
    projectRoot: run.manifest.callerWorktreePath,
    idempotencyKey: key,
    action: "quarantine",
    confirmNoRunningProcesses: true,
  });
  assert.equal(recovered.outcome, "quarantined");
  assert.equal(recovered.status.kind, "run_interrupted");
  const auditNames = (await readdir(run.runDirectory)).filter((name) => name.startsWith("operator-recovery-"));
  assert.equal(auditNames.length, 1);
  const audit = await readRecord(run.runDirectory, auditNames[0]!);
  assert.equal(audit?.kind, "operator-recovery");
  assert.equal(audit?.action, "release-dead-transition");
  await assert.rejects(() => lstat(join(run.runDirectory, "transition", "current.json")), { code: "ENOENT" });
});

test("each dead transition receives its own immutable operator audit", async (t) => {
  const run = await make(t);
  await abandonTransition(run.runDirectory);
  await recoverWorkRun({
    projectRoot: run.manifest.callerWorktreePath,
    idempotencyKey: key,
    action: "quarantine",
    confirmNoRunningProcesses: true,
  });

  // This simulates a crash after the first audit/release but before its
  // quarantine record survives. A subsequent dead transition must not collide
  // with that prior audit record.
  await rm(join(run.runDirectory, "quarantine.json"));
  await abandonTransition(run.runDirectory);
  await recoverWorkRun({
    projectRoot: run.manifest.callerWorktreePath,
    idempotencyKey: key,
    action: "quarantine",
    confirmNoRunningProcesses: true,
  });

  const audits = (await readdir(run.runDirectory)).filter((name) => name.startsWith("operator-recovery-")).sort();
  assert.equal(audits.length, 2);
  const tokens = new Set((await Promise.all(audits.map(async (name) => (await readRecord(run.runDirectory, name))?.transitionToken))).filter(Boolean));
  assert.equal(tokens.size, 2);
});

async function make(t: test.TestContext): Promise<StoredRun> {
  const repo = await mkdtemp(join(tmpdir(), "codex-sidecar-work-recovery-"));
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

async function deadSpawn(run: StoredRun): Promise<void> {
  await publishRecord(join(run.runDirectory, "launch.lock"), "spawn.json", {
    kind: "spawn",
    generation: run.claim.generation,
    token: run.claim.token,
    pid: 999_999,
    pgid: 999_999,
    processIdentity: { pid: 999_999, startIdentity: "known-dead" },
    createdAt: new Date().toISOString(),
  });
}

async function abandonTransition(runDirectory: string): Promise<void> {
  const module = new URL("./run-transition.js", import.meta.url).pathname;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {claimRunTransition} from ${JSON.stringify(module)}; await claimRunTransition(${JSON.stringify(runDirectory)});`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`transition fixture failed: ${code}; ${stderr}`)));
  });
}

function request(projectRoot: string): SidecarRequest {
  return {
    workflow: "work", projectRoot, prompt: "change README", readonly: false, requireWorktree: true,
    focus: [], allowedPaths: ["README.md"], denyPaths: [], safetyProfile: "generic", resultFormat: "json",
    turnTimeoutMs: 1_000, interruptOnTimeout: true, preserveWorktree: true, context: [], dryRun: false,
  };
}

function completedResult(normalizedRequest: SidecarRequest): SidecarResult {
  return {
    status: "ok", workflow: "work", summary: "done", confidence: { level: "high" },
    recommendedNextAction: "review", normalizedRequest,
  };
}
