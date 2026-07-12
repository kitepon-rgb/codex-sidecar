import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { recoverDurableAuthSessionForTarget, recoveryTargetFromInspection } from "./durable-auth-session.js";
import { openOrCreateRun } from "./run-store.js";
import { WorkAuthRecoveryStrategy } from "./run-types.js";
import { __workAuthRecoveryTestHooks, inspectWorkAuthRecovery, recoverWorkAuthSession } from "./work-auth-recovery.js";
import type { SidecarRequest } from "./types.js";

const execFileAsync = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";
const secondKey = "bcdefghijklmnopqrstuvw";

test("work auth inspection binds a held lease to its exact durable run journal", async (t) => {
  const fixture = await createFixture(t); const run = await createRun(fixture.repo);
  await abandonWorkAuth(fixture, run.manifest.runId, run.runDirectory, "work-run");
  const inspection = await inspectWorkAuthRecovery({ projectRoot: fixture.repo, idempotencyKey: key }, { baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(inspection.ownership, "owned-by-run");
  assert.equal(inspection.runId, run.manifest.runId);
  assert.equal(inspection.expectedJournalPath, join(run.runDirectory, "auth"));
  assert.equal(inspection.auth.state, "held");
  assert.equal(inspection.auth.ownerKind, "work-run");
  assert.equal(inspection.auth.ownerId, run.manifest.runId);
  assert.equal(inspection.auth.canonicalAuth.state, "present");
  assert.equal(inspection.auth.initialCanonicalAuth?.hash, inspection.auth.canonicalAuth.hash);
});

test("work auth recovery releases only the exact abandoned work lease", async (t) => {
  const fixture = await createFixture(t); const run = await createRun(fixture.repo);
  await abandonWorkAuth(fixture, run.manifest.runId, run.runDirectory, "work-run");
  const ack = await recoverWorkAuthSession({ projectRoot: fixture.repo, idempotencyKey: key, strategy: WorkAuthRecoveryStrategy.ReleaseNeverStarted, confirmNoRunningProcesses: true }, { baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(ack.kind, "work_auth_recovery_ack");
  assert.equal(ack.outcome, "recovered");
  assert.equal(ack.runId, run.manifest.runId);
  assert.equal(ack.strategy, WorkAuthRecoveryStrategy.ReleaseNeverStarted);
  assert.equal(ack.target.token.length > 0, true);
  assert.equal(ack.operatorRecoveryRecordPath, join(run.runDirectory, "auth", "operator-recovery.json"));
  const after = await inspectWorkAuthRecovery({ projectRoot: fixture.repo, idempotencyKey: key }, { baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(after.ownership, "available");
  assert.equal(after.auth.state, "available");
});

test("work auth recovery refuses a lease owned by a different session", async (t) => {
  const fixture = await createFixture(t); await createRun(fixture.repo);
  await abandonWorkAuth(fixture, "other-sync-session", join(fixture.root, "other-session"), "sync-session");
  const inspection = await inspectWorkAuthRecovery({ projectRoot: fixture.repo, idempotencyKey: key }, { baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(inspection.ownership, "owned-by-other");
  await assert.rejects(() => recoverWorkAuthSession({ projectRoot: fixture.repo, idempotencyKey: key, strategy: WorkAuthRecoveryStrategy.ReleaseNeverStarted, confirmNoRunningProcesses: true }, { baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache }), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal((await inspectWorkAuthRecovery({ projectRoot: fixture.repo, idempotencyKey: key }, { baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache })).ownership, "owned-by-other");
});

test("work auth recovery never settles another run's abandoned recovery after inspection", async (t) => {
  const fixture = await createFixture(t);
  const first = await createRun(fixture.repo, key);
  const second = await createRun(fixture.repo, secondKey);
  await abandonWorkAuth(fixture, first.manifest.runId, first.runDirectory, "work-run");
  __workAuthRecoveryTestHooks.afterInspectionBeforeRecovery = async (inspection) => {
    if (inspection.auth.state !== "held") throw new Error("first work auth fixture must be held");
    await recoverDurableAuthSessionForTarget(
      { home: fixture.home, cacheRoot: fixture.cache, strategy: "release-never-started", confirmNoRunningProcesses: true },
      recoveryTargetFromInspection(inspection.auth),
    );
    await abandonWorkAuth(fixture, second.manifest.runId, second.runDirectory, "work-run");
    await abandonRecoveryAfterDecision(fixture, secondKey);
  };
  t.after(() => { __workAuthRecoveryTestHooks.afterInspectionBeforeRecovery = undefined; });

  await assert.rejects(
    () => recoverWorkAuthSession({ projectRoot: fixture.repo, idempotencyKey: key, strategy: WorkAuthRecoveryStrategy.ReleaseNeverStarted, confirmNoRunningProcesses: true }, { baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache }),
    { code: "RUN_AUTH_UNCERTAIN" },
  );
  const after = await inspectWorkAuthRecovery({ projectRoot: fixture.repo, idempotencyKey: secondKey }, { baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(after.ownership, "owned-by-run");
  assert.equal(after.auth.state, "held");
  assert.equal(after.auth.ownerId, second.manifest.runId);
});

async function createFixture(t: test.TestContext): Promise<{ root: string; repo: string; home: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-work-auth-")); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); const home = join(root, "home"); const cache = join(root, "cache");
  await mkdir(repo, { mode: 0o700 }); await mkdir(home, { mode: 0o700 }); await mkdir(cache, { mode: 0o700 });
  await chmod(repo, 0o700); await chmod(home, 0o700); await chmod(cache, 0o700);
  await writeFile(join(home, "auth.json"), '{"refresh":"R0"}\n', { mode: 0o600 });
  await git(repo, ["init", "--initial-branch=main"]); await git(repo, ["config", "user.email", "test@example.invalid"]); await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "initial\n"); await git(repo, ["add", "README.md"]); await git(repo, ["commit", "-m", "initial"]);
  return { root: await realpath(root), repo: await realpath(repo), home: await realpath(home), cache: await realpath(cache) };
}

async function createRun(repo: string, idempotencyKey = key) {
  return openOrCreateRun({ projectRoot: repo, idempotencyKey, rawInput: { prompt: "change README", dryRun: false } }, async () => ({ normalizedRequest: snapshot(repo) }));
}

function snapshot(projectRoot: string): SidecarRequest {
  return { workflow: "work", projectRoot, prompt: "change README", readonly: false, requireWorktree: true, focus: [], allowedPaths: ["README.md"], denyPaths: [], safetyProfile: "generic", resultFormat: "json", turnTimeoutMs: 1_000, interruptOnTimeout: true, preserveWorktree: true, context: [], dryRun: false };
}

async function abandonWorkAuth(
  fixture: { home: string; cache: string },
  ownerId: string,
  root: string,
  ownerKind: "work-run" | "sync-session",
): Promise<void> {
  if (ownerKind === "sync-session") { await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700); }
  const module = new URL("./durable-auth-session.js", import.meta.url).pathname;
  const code = `import {createDurableAuthSession} from ${JSON.stringify(module)}; await createDurableAuthSession({baseEnv:{CODEX_HOME:${JSON.stringify(fixture.home)}},cacheRoot:${JSON.stringify(fixture.cache)},sessionRoot:${JSON.stringify(root)},journalPath:${JSON.stringify(join(root, ownerKind === "work-run" ? "auth" : "journal"))},codexHomePath:${JSON.stringify(join(root, "codex-home"))},ownerKind:${JSON.stringify(ownerKind)},ownerId:${JSON.stringify(ownerId)}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`work auth fixture child failed: ${status}; ${stderr}`)));
  });
}

async function abandonRecoveryAfterDecision(
  fixture: { repo: string; home: string; cache: string },
  idempotencyKey: string,
): Promise<void> {
  const authLease = new URL("./auth-lease.js", import.meta.url).pathname;
  const workRecovery = new URL("./work-auth-recovery.js", import.meta.url).pathname;
  const code = `import {__authLeaseTestHooks} from ${JSON.stringify(authLease)}; import {recoverWorkAuthSession} from ${JSON.stringify(workRecovery)}; __authLeaseTestHooks.afterRecoveryRecord=async()=>{process.exit(0)}; await recoverWorkAuthSession({projectRoot:${JSON.stringify(fixture.repo)},idempotencyKey:${JSON.stringify(idempotencyKey)},strategy:'release-never-started',confirmNoRunningProcesses:true},{baseEnv:{CODEX_HOME:${JSON.stringify(fixture.home)}},cacheRoot:${JSON.stringify(fixture.cache)}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`recovery-decision child failed: ${status}; ${stderr}`)));
  });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}
