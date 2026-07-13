import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectCurrentDurableAuthRecovery } from "./durable-auth-session.js";
import { matchesProcessIdentity } from "./process-identity.js";
import { readRecord, type SpawnRecord } from "./run-records.js";
import { WorkAuthRecoveryStrategy } from "./run-types.js";
import { cancelWorkRun, getWorkRunResult, startWorkRun } from "./work-run-service.js";
import { recoverWorkAuthSession } from "./work-auth-recovery.js";
import { buildSidecarOutputSchema } from "./structured-output-schema.js";
import type { SidecarConfig, SidecarRunInterrupted, SidecarRunPending, SidecarRunTerminal } from "./types.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";
const secondKey = "bcdefghijklmnopqrstuvw";

test("default durable worker executes an isolated App Server process and persists its terminal result", async (t) => {
  const fixture = await createFixture(t);
  const started = await startWorkRun(config(), {
    projectRoot: fixture.repo,
    idempotencyKey: key,
    prompt: "append a fixture marker to README.md",
  }, {
    launch: { env: workerEnv(fixture, "complete") },
  });

  assert.equal(started.kind, "run_handle", JSON.stringify(started));
  if (started.kind !== "run_handle") throw new Error("expected durable worker handle");

  const terminal = await waitForTerminal(fixture.repo, key);
  assert.equal(terminal.state, "completed", JSON.stringify(terminal));
  assert.equal(terminal.result.status, "ok");
  assert.equal(terminal.cleanup, "not-requested");
  assert.equal(terminal.result.worktreePreserved, true);
  assert.ok(terminal.result.worktreePath);

  const runDirectory = runDirectoryFor(fixture.repo, started.runId);
  const worktreePath = terminal.result.worktreePath!;
  assert.equal((await lstat(worktreePath)).mode & 0o777, 0o700);
  assert.match(await readFile(join(worktreePath, "README.md"), "utf8"), /sidecar fixture change/);
  assert.equal(await readFile(join(fixture.repo, "README.md"), "utf8"), "initial\n");
  assert.equal((await readRecord(runDirectory, "result.json"))?.kind, "result");
  assert.equal((await readRecord(runDirectory, "terminal.json"))?.kind, "terminal");
  assert.match(await readFile(join(runDirectory, "auth", "clean-shutdown.json"), "utf8"), /"kind":"clean-shutdown"/);

  const logs = join(runDirectory, "logs");
  const logEntries = await readdir(logs);
  assert.ok(logEntries.some((entry) => entry.endsWith(".jsonl")));
  assert.equal((await lstat(logs)).mode & 0o777, 0o700);
  const log = join(logs, logEntries.find((entry) => entry.endsWith(".jsonl"))!);
  assert.equal((await lstat(log)).mode & 0o777, 0o600);
  const rawLog = await readFile(log, "utf8");
  const turnStart = rawLog.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    event?: string;
    data?: { method?: string; params?: { outputSchema?: unknown } };
  }).find((entry) => entry.event === "request/send" && entry.data?.method === "turn/start");
  assert.deepEqual(
    turnStart?.data?.params?.outputSchema,
    buildSidecarOutputSchema(terminal.result.normalizedRequest!),
    "raw App Server log must retain the exact turn/start outputSchema payload",
  );

  assert.deepEqual(
    await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache }),
    { state: "available" },
  );
});

test("non-preserved durable work commits result and terminal before removing its real git worktree", async (t) => {
  const fixture = await createFixture(t);
  const started = await startWorkRun(config(), {
    projectRoot: fixture.repo,
    idempotencyKey: key,
    prompt: "append then clean up README.md worktree",
    preserveWorktree: false,
  }, {
    launch: { env: workerEnv(fixture, "complete") },
  });

  assert.equal(started.kind, "run_handle", JSON.stringify(started));
  if (started.kind !== "run_handle") throw new Error("expected durable worker handle");
  const committed = await waitForTerminal(fixture.repo, key);
  assert.equal(committed.state, "completed");
  assert.equal(committed.result.status, "ok");
  assert.equal(committed.result.worktreePreserved, false);
  assert.ok(committed.result.worktreePath);

  const runDirectory = runDirectoryFor(fixture.repo, started.runId);
  assert.equal((await readRecord(runDirectory, "result.json"))?.kind, "result");
  assert.equal((await readRecord(runDirectory, "terminal.json"))?.kind, "terminal");
  const terminal = committed.cleanup === "completed"
    ? committed
    : await waitForTerminal(fixture.repo, key, (candidate) => candidate.cleanup === "completed");
  assert.equal(terminal.cleanup, "completed");
  assert.equal((await readRecord(runDirectory, "cleanup.json"))?.kind, "cleanup");
  await assert.rejects(() => lstat(terminal.result.worktreePath!), { code: "ENOENT" });
  assert.equal(await readFile(join(fixture.repo, "README.md"), "utf8"), "initial\n");
});

test("durable work refuses a deny-path write while keeping the active tree unchanged", async (t) => {
  const fixture = await createFixture(t);
  const started = await startWorkRun({ project: "test", allowed_paths: ["README.md"], deny_paths: [".env"] }, {
    projectRoot: fixture.repo,
    idempotencyKey: key,
    prompt: "attempt to write a denied environment file",
  }, {
    launch: { env: workerEnv(fixture, "complete", ".env") },
  });

  assert.equal(started.kind, "run_handle", JSON.stringify(started));
  if (started.kind !== "run_handle") throw new Error("expected durable worker handle");

  const terminal = await waitForTerminal(fixture.repo, key);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.result.status, "refused");
  assert.equal(terminal.result.error?.code, "SAFETY_REFUSAL");
  assert.ok(terminal.result.worktreePath);
  assert.equal(await readFile(join(terminal.result.worktreePath!, ".env"), "utf8"), "sidecar fixture change\n");
  await assert.rejects(() => readFile(join(fixture.repo, ".env"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(join(fixture.repo, "README.md"), "utf8"), "initial\n");
});

test("killed durable worker leaves its worktree and auth lease for explicit recovery", async (t) => {
  const fixture = await createFixture(t);
  const started = await startWorkRun(config(), {
    projectRoot: fixture.repo,
    idempotencyKey: key,
    prompt: "hold until the worker is killed",
    preserveWorktree: false,
  }, {
    launch: { env: workerEnv(fixture, "hang") },
  });

  assert.equal(started.kind, "run_handle", JSON.stringify(started));
  if (started.kind !== "run_handle") throw new Error("expected durable worker handle");

  const runDirectory = runDirectoryFor(fixture.repo, started.runId);
  await waitForRunning(fixture.repo, key);
  const worktreePath = join(runDirectory, "worktree");
  await waitForPath(worktreePath);
  await waitForPath(join(runDirectory, "auth", "app-server-started.json"));
  await killFixtureWorker(runDirectory);

  const interrupted = await waitForInterrupted(fixture.repo, key);
  assert.equal(interrupted.error.code, "RUN_ORPHANED");
  assert.equal(interrupted.salvageAllowed, false);
  assert.equal(interrupted.terminal, false);
  assert.equal(await readRecord(runDirectory, "result.json"), undefined);
  assert.equal(await readRecord(runDirectory, "terminal.json"), undefined);
  assert.equal(await readRecord(runDirectory, "cleanup.json"), undefined);
  assert.equal((await lstat(worktreePath)).isDirectory(), true);
  assert.equal(await readFile(join(fixture.repo, "README.md"), "utf8"), "initial\n");

  const auth = await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(auth.state, "held");
  if (auth.state !== "held") throw new Error("expected durable auth lease to remain held");
  assert.equal(auth.ownerKind, "work-run");
  assert.equal(auth.ownerId, started.runId);
  assert.equal(auth.appServerStarted, true);

  await replaceCanonicalAuthAfterLogin(fixture.home);
  const recovery = await recoverWorkAuthSession({
    projectRoot: fixture.repo,
    idempotencyKey: key,
    strategy: WorkAuthRecoveryStrategy.KeepCanonicalAfterLogin,
    confirmNoRunningProcesses: true,
  }, {
    baseEnv: { CODEX_HOME: fixture.home },
    cacheRoot: fixture.cache,
  });
  assert.equal(recovery.kind, "work_auth_recovery_ack");
  assert.equal(recovery.outcome, "recovered");
  assert.equal(recovery.runId, started.runId);
  assert.equal(recovery.strategy, WorkAuthRecoveryStrategy.KeepCanonicalAfterLogin);
  assert.match(recovery.operatorRecoveryRecordPath, /\/auth\/operator-recovery\.json$/);
  assert.deepEqual(
    await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache }),
    { state: "available" },
  );
});

test("SIGKILL after the auth write-ahead marker and App Server spawn leaves the run fail-closed before initialize", async (t) => {
  if (process.platform === "win32") return;
  const fixture = await createFixture(t);
  const appServerSpawnMarker = join(fixture.root, "app-server-spawned.json");
  const appServerInitializeMarker = join(fixture.root, "app-server-initialized");
  const started = await startWorkRun(config(), {
    projectRoot: fixture.repo,
    idempotencyKey: key,
    prompt: "stop immediately after the App Server process spawns",
    preserveWorktree: false,
  }, {
    launch: {
      env: {
        ...workerEnv(fixture, "hang"),
        FAKE_CODEX_SPAWN_MARKER: appServerSpawnMarker,
        FAKE_CODEX_INITIALIZE_MARKER: appServerInitializeMarker,
        FAKE_CODEX_STOP_BEFORE_INITIALIZE: "1",
      },
    },
  });

  assert.equal(started.kind, "run_handle", JSON.stringify(started));
  if (started.kind !== "run_handle") throw new Error("expected durable worker handle");
  const runDirectory = runDirectoryFor(fixture.repo, started.runId);
  const worktreePath = join(runDirectory, "worktree");
  await waitForPath(worktreePath);
  await waitForPath(join(runDirectory, "auth", "app-server-started.json"));
  await waitForPath(appServerSpawnMarker);

  const appServerPid = await readFakeAppServerPid(appServerSpawnMarker);
  const worker = await readFixtureWorker(runDirectory);
  assert.equal(await matchesProcessIdentity(worker.processIdentity), true);
  const appServer = await processStatus(appServerPid);
  assert.equal(appServer.pgid, worker.pgid);
  assert.match(appServer.stat, /T/, "fake App Server must be SIGSTOPped before it can read initialize");
  await assert.rejects(() => lstat(appServerInitializeMarker), { code: "ENOENT" });

  await killFixtureWorker(runDirectory);
  await waitForProcessGone(appServerPid);

  const interrupted = await waitForInterrupted(fixture.repo, key);
  assert.equal(interrupted.error.code, "RUN_ORPHANED");
  assert.equal(interrupted.salvageAllowed, false);
  assert.equal(interrupted.terminal, false);
  assert.equal(await readRecord(runDirectory, "result.json"), undefined);
  assert.equal(await readRecord(runDirectory, "terminal.json"), undefined);
  assert.equal(await readRecord(runDirectory, "cleanup.json"), undefined);
  assert.equal((await lstat(worktreePath)).isDirectory(), true);

  const auth = await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(auth.state, "held");
  if (auth.state !== "held") throw new Error("expected explicit auth recovery after killed App Server startup");
  assert.equal(auth.ownerKind, "work-run");
  assert.equal(auth.ownerId, started.runId);
  assert.equal(auth.appServerStarted, true);

  await replaceCanonicalAuthAfterLogin(fixture.home);
  const recovery = await recoverWorkAuthSession({
    projectRoot: fixture.repo,
    idempotencyKey: key,
    strategy: WorkAuthRecoveryStrategy.KeepCanonicalAfterLogin,
    confirmNoRunningProcesses: true,
  }, {
    baseEnv: { CODEX_HOME: fixture.home },
    cacheRoot: fixture.cache,
  });
  assert.equal(recovery.kind, "work_auth_recovery_ack");
  assert.equal(recovery.outcome, "recovered");
  assert.equal(recovery.runId, started.runId);
  assert.deepEqual(
    await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache }),
    { state: "available" },
  );
});

test("SIGKILL after the durable auth marker but before App Server client start leaves marker-only recovery evidence", async (t) => {
  if (process.platform === "win32") return;
  const fixture = await createFixture(t);
  const readyMarker = join(fixture.root, "after-auth-marker-before-client-start.ready");
  const appServerSpawnMarker = join(fixture.root, "app-server-spawned.json");
  const workerWrapper = await createAuthMarkerStopWorkerWrapper(fixture.root, readyMarker);
  const started = await startWorkRun(config(), {
    projectRoot: fixture.repo,
    idempotencyKey: key,
    prompt: "stop after the durable auth marker and before App Server client start",
    preserveWorktree: false,
  }, {
    workerEntrypoint: workerWrapper,
    launch: {
      env: {
        ...workerEnv(fixture, "hang"),
        FAKE_CODEX_SPAWN_MARKER: appServerSpawnMarker,
      },
    },
  });

  assert.equal(started.kind, "run_handle", JSON.stringify(started));
  if (started.kind !== "run_handle") throw new Error("expected durable worker handle");
  const runDirectory = runDirectoryFor(fixture.repo, started.runId);
  const worktreePath = join(runDirectory, "worktree");
  await waitForPath(worktreePath);
  await waitForPath(join(runDirectory, "auth", "app-server-started.json"));
  await waitForPath(readyMarker);

  const worker = await readFixtureWorker(runDirectory);
  assert.equal(await matchesProcessIdentity(worker.processIdentity), true);
  const workerStatus = await processStatus(worker.pid);
  assert.equal(workerStatus.pgid, worker.pgid);
  assert.match(workerStatus.stat, /T/, "worker wrapper must be SIGSTOPped at the marker-only boundary");
  await assert.rejects(() => lstat(appServerSpawnMarker), { code: "ENOENT" });

  await killFixtureWorker(runDirectory);

  const interrupted = await waitForInterrupted(fixture.repo, key);
  assert.equal(interrupted.error.code, "RUN_ORPHANED");
  assert.equal(interrupted.salvageAllowed, false);
  assert.equal(interrupted.terminal, false);
  assert.equal(await readRecord(runDirectory, "result.json"), undefined);
  assert.equal(await readRecord(runDirectory, "terminal.json"), undefined);
  assert.equal(await readRecord(runDirectory, "cleanup.json"), undefined);
  assert.equal((await lstat(worktreePath)).isDirectory(), true);

  const auth = await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(auth.state, "held");
  if (auth.state !== "held") throw new Error("expected durable auth lease to remain held at marker-only boundary");
  assert.equal(auth.ownerKind, "work-run");
  assert.equal(auth.ownerId, started.runId);
  assert.equal(auth.appServerStarted, true);

  await assert.rejects(
    () => recoverWorkAuthSession({
      projectRoot: fixture.repo,
      idempotencyKey: key,
      strategy: WorkAuthRecoveryStrategy.ReleaseNeverStarted,
      confirmNoRunningProcesses: true,
    }, {
      baseEnv: { CODEX_HOME: fixture.home },
      cacheRoot: fixture.cache,
    }),
    { code: "RUN_AUTH_UNCERTAIN" },
  );

  await replaceCanonicalAuthAfterLogin(fixture.home);
  const recovery = await recoverWorkAuthSession({
    projectRoot: fixture.repo,
    idempotencyKey: key,
    strategy: WorkAuthRecoveryStrategy.KeepCanonicalAfterLogin,
    confirmNoRunningProcesses: true,
  }, {
    baseEnv: { CODEX_HOME: fixture.home },
    cacheRoot: fixture.cache,
  });
  assert.equal(recovery.kind, "work_auth_recovery_ack");
  assert.equal(recovery.outcome, "recovered");
  assert.equal(recovery.runId, started.runId);
  assert.equal(recovery.strategy, WorkAuthRecoveryStrategy.KeepCanonicalAfterLogin);
  assert.match(recovery.operatorRecoveryRecordPath, /\/auth\/operator-recovery\.json$/);
  assert.deepEqual(
    await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache }),
    { state: "available" },
  );
});

test("a queued run is pre-start fenced when cancellation wins while another project holds the auth lease", async (t) => {
  const fixture = await createFixture(t);
  const secondRepo = await createSecondRepository(fixture.root);
  t.after(() => stopFixtureWorkers(secondRepo));

  const first = await startWorkRun(config(), {
    projectRoot: fixture.repo,
    idempotencyKey: key,
    prompt: "hold the global auth lease",
  }, {
    launch: { env: workerEnv(fixture, "hang") },
  });
  assert.equal(first.kind, "run_handle", JSON.stringify(first));
  if (first.kind !== "run_handle") throw new Error("expected first durable worker handle");
  await waitForPath(join(runDirectoryFor(fixture.repo, first.runId), "auth", "app-server-started.json"));

  const second = await startWorkRun(config(), {
    projectRoot: secondRepo,
    idempotencyKey: secondKey,
    prompt: "wait for the global auth lease",
  }, {
    launch: { env: workerEnv(fixture, "complete") },
  });
  assert.equal(second.kind, "run_handle", JSON.stringify(second));
  if (second.kind !== "run_handle") throw new Error("expected queued durable worker handle");
  const secondRunDirectory = runDirectoryFor(secondRepo, second.runId);
  await waitForQueued(secondRepo, secondKey);

  const held = await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(held.state, "held");
  if (held.state !== "held") throw new Error("expected first run to hold the global auth lease");
  assert.equal(held.ownerId, first.runId);

  const cancellation = await cancelWorkRun({ projectRoot: secondRepo, idempotencyKey: secondKey });
  assert.equal(cancellation.kind, "run_cancel_ack", JSON.stringify(cancellation));
  if (cancellation.kind !== "run_cancel_ack") throw new Error("expected queued cancellation acknowledgement");
  assert.equal(cancellation.mode, "pre_start_fenced");

  const cancelled = await waitForTerminal(secondRepo, secondKey);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.result.error?.code, "APP_SERVER_CANCELLED");
  assert.equal(await readRecord(secondRunDirectory, "execution-started.json"), undefined);
  await assert.rejects(() => lstat(join(secondRunDirectory, "auth", "app-server-started.json")), { code: "ENOENT" });
  await assert.rejects(() => lstat(join(secondRunDirectory, "worktree")), { code: "ENOENT" });

  const stillHeld = await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache });
  assert.equal(stillHeld.state, "held");
  if (stillHeld.state !== "held") throw new Error("queued run unexpectedly released the global auth lease");
  assert.equal(stillHeld.ownerId, first.runId);

  const firstCancellation = await cancelWorkRun({ projectRoot: fixture.repo, idempotencyKey: key });
  assert.equal(firstCancellation.kind, "run_cancel_ack", JSON.stringify(firstCancellation));
  await waitForTerminal(fixture.repo, key);
  assert.deepEqual(
    await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache }),
    { state: "available" },
  );
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`worker completes after its ${signal}ed coordinator exits`, async (t) => {
    const fixture = await createFixture(t);
    const coordinator = await startCoordinator(fixture);
    t.after(() => { try { coordinator.kill("SIGKILL"); } catch {} });

    const started = await waitForCoordinatorHandle(coordinator);
    assert.equal(started.kind, "run_handle", JSON.stringify(started));
    const runId = started.runId;
    if (typeof runId !== "string") throw new Error("expected durable run id");

    const runDirectory = runDirectoryFor(fixture.repo, runId);
    await waitForPath(join(runDirectory, "auth", "app-server-started.json"));
    assert.equal(await readRecord(runDirectory, "terminal.json"), undefined);
    await stopCoordinator(coordinator, signal);

    const terminal = await readTerminalFromSeparateProcess(fixture.repo, key);
    assert.equal(terminal.kind, "run_terminal");
    assert.equal(terminal.runId, runId);
    assert.equal(terminal.state, "completed");
    assert.equal((terminal.result as { status?: string }).status, "ok");
  });
}

test("cooperative cancel interrupts the owned App Server and returns a cancelled durable terminal", async (t) => {
  const fixture = await createFixture(t);
  const started = await startWorkRun(config(), {
    projectRoot: fixture.repo,
    idempotencyKey: key,
    prompt: "hold until cancellation",
  }, {
    launch: { env: workerEnv(fixture, "hang") },
  });

  assert.equal(started.kind, "run_handle", JSON.stringify(started));
  await waitForRunning(fixture.repo, key);

  const cancellation = await cancelWorkRun({ projectRoot: fixture.repo, idempotencyKey: key });
  assert.equal(cancellation.kind, "run_cancel_ack", JSON.stringify(cancellation));
  if (cancellation.kind !== "run_cancel_ack") throw new Error("expected cancellation acknowledgement");
  assert.equal(cancellation.accepted, true);
  assert.equal(cancellation.mode, "cooperative");

  const terminal = await waitForTerminal(fixture.repo, key);
  assert.equal(terminal.state, "cancelled");
  assert.equal(terminal.result.status, "failed");
  assert.equal(terminal.result.error?.code, "APP_SERVER_CANCELLED");
  assert.equal(terminal.cleanup, "not-requested");
  assert.ok(terminal.result.worktreePath);
  assert.match(await readFile(join(terminal.result.worktreePath!, "README.md"), "utf8"), /sidecar fixture change/);
  assert.equal(await readFile(join(fixture.repo, "README.md"), "utf8"), "initial\n");

  assert.deepEqual(
    await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: fixture.home }, cacheRoot: fixture.cache }),
    { state: "available" },
  );
});

interface Fixture {
  root: string;
  repo: string;
  home: string;
  cache: string;
  fakeCodex: string;
}

async function createFixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-work-run-e2e-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const cache = join(root, "cache");
  await Promise.all([mkdir(repo, { mode: 0o700 }), mkdir(home, { mode: 0o700 }), mkdir(cache, { mode: 0o700 })]);
  await Promise.all([chmod(repo, 0o700), chmod(home, 0o700), chmod(cache, 0o700)]);
  await writeFile(join(home, "auth.json"), '{"refresh":"fixture"}\n', { mode: 0o600 });
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  const fakeCodex = await createFakeCodex(root);

  t.after(async () => {
    await stopFixtureWorkers(repo);
    await rm(root, { recursive: true, force: true });
  });
  return { root, repo, home, cache, fakeCodex };
}

async function createFakeCodex(root: string): Promise<string> {
  const binary = join(root, "fake-codex");
  const source = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.env.FAKE_CODEX_SPAWN_MARKER) {
  fs.writeFileSync(process.env.FAKE_CODEX_SPAWN_MARKER, JSON.stringify({ pid: process.pid }) + "\\n");
  if (process.env.FAKE_CODEX_STOP_BEFORE_INITIALIZE === "1") process.kill(process.pid, "SIGSTOP");
}

let threadCwd;
let interrupted = false;
const report = JSON.stringify({
  summary: "fixture work complete",
  confidence: { level: "high", rationale: "fixture App Server" },
  recommendedNextAction: "review the worktree",
  openQuestions: [],
  fileReferences: [],
  sourceBoundaries: [],
  tests: [],
  risks: [],
});
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function reply(id, result) { send({ id, result }); }
function notify(method, params) { send({ method, params }); }
process.on("SIGTERM", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.FAKE_CODEX_INITIALIZE_MARKER) fs.writeFileSync(process.env.FAKE_CODEX_INITIALIZE_MARKER, "initialized\\n");
    reply(message.id, { userAgent: "codex-sidecar/0.144.1 (fixture)", codexHome: process.env.CODEX_HOME || "", platformFamily: "unix", platformOs: process.platform });
    return;
  }
  if (message.method === "thread/start") {
    threadCwd = message.params.cwd;
    reply(message.id, { thread: { id: "thread-1", cwd: threadCwd, status: "idle" }, model: "fixture", modelProvider: "fixture", cwd: threadCwd });
    return;
  }
  if (message.method === "turn/start") {
    if (process.env.FAKE_CODEX_WRITE === "1") fs.appendFileSync(path.join(threadCwd, process.env.FAKE_CODEX_WRITE_PATH || "README.md"), "sidecar fixture change\\n");
    reply(message.id, { turn: { id: "turn-1", status: "in_progress", error: null } });
    if (process.env.FAKE_CODEX_MODE !== "hang") {
      const complete = () => {
        if (interrupted) return;
        notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: report });
        notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } });
      };
      if (process.env.FAKE_CODEX_MODE === "delayed") setTimeout(complete, Number(process.env.FAKE_CODEX_DELAY_MS || 1_000));
      else setImmediate(complete);
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    interrupted = true;
    reply(message.id, {});
    notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } });
  }
});
`;
  await writeFile(binary, source, { mode: 0o700 });
  await chmod(binary, 0o700);
  return binary;
}

async function createAuthMarkerStopWorkerWrapper(root: string, readyMarker: string): Promise<string> {
  const wrapper = join(root, "stop-after-auth-marker-before-client-start.mjs");
  const appServerRunner = new URL("./app-server-runner.js", import.meta.url).pathname;
  const runWorker = new URL("./run-worker.js", import.meta.url).pathname;
  const source = `
    import { writeFile } from "node:fs/promises";
    import { __appServerRunnerTestHooks } from ${JSON.stringify(appServerRunner)};
    import { runWorker } from ${JSON.stringify(runWorker)};
    __appServerRunnerTestHooks.afterAuthMarkerBeforeClientStart = async () => {
      await writeFile(${JSON.stringify(readyMarker)}, "ready\\n", { mode: 0o600 });
      process.kill(process.pid, "SIGSTOP");
    };
    await runWorker(process.argv[2]);
  `;
  await writeFile(wrapper, source, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

function config(): SidecarConfig {
  return { project: "test", allowed_paths: ["README.md"] };
}

function workerEnv(fixture: Fixture, mode: "complete" | "hang" | "delayed", writePath = "README.md"): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: fixture.home,
    XDG_CACHE_HOME: fixture.cache,
    CODEX_BINARY: fixture.fakeCodex,
    FAKE_CODEX_MODE: mode,
    FAKE_CODEX_WRITE: "1",
    FAKE_CODEX_WRITE_PATH: writePath,
    FAKE_CODEX_DELAY_MS: "1000",
  };
}

async function waitForRunning(projectRoot: string, idempotencyKey: string): Promise<SidecarRunPending> {
  const deadline = Date.now() + 10_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const result = await getWorkRunResult({ projectRoot, idempotencyKey });
    last = result;
    if (result.kind === "run_pending" && result.state === "running") return result;
    await sleep(25);
  }
  throw new Error(`durable worker did not reach running state: ${JSON.stringify(last)}`);
}

async function waitForQueued(projectRoot: string, idempotencyKey: string): Promise<SidecarRunPending> {
  const deadline = Date.now() + 10_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const result = await getWorkRunResult({ projectRoot, idempotencyKey });
    last = result;
    if (result.kind === "run_pending" && result.state === "queued" && result.phase === "auth-queue") return result;
    await sleep(25);
  }
  throw new Error(`durable worker did not enter auth queue: ${JSON.stringify(last)}`);
}

async function waitForTerminal(
  projectRoot: string,
  idempotencyKey: string,
  accept: (terminal: SidecarRunTerminal) => boolean = () => true,
): Promise<SidecarRunTerminal> {
  const deadline = Date.now() + 10_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const result = await getWorkRunResult({ projectRoot, idempotencyKey });
    last = result;
    if (result.kind === "run_terminal" && accept(result)) return result;
    await sleep(25);
  }
  throw new Error(`durable worker did not reach a terminal result: ${JSON.stringify(last)}`);
}

async function waitForInterrupted(projectRoot: string, idempotencyKey: string): Promise<SidecarRunInterrupted> {
  const deadline = Date.now() + 10_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const result = await getWorkRunResult({ projectRoot, idempotencyKey });
    last = result;
    if (result.kind === "run_interrupted") return result;
    await sleep(25);
  }
  throw new Error(`durable worker did not become interrupted: ${JSON.stringify(last)}`);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await sleep(25);
  }
  throw new Error(`path was not created: ${path}`);
}

async function startCoordinator(fixture: Fixture): Promise<ChildProcess> {
  const workRunService = new URL("./work-run-service.js", import.meta.url).pathname;
  const code = `
    import { startWorkRun } from ${JSON.stringify(workRunService)};
    const started = await startWorkRun(
      { project: "test", allowed_paths: ["README.md"] },
      { projectRoot: ${JSON.stringify(fixture.repo)}, idempotencyKey: ${JSON.stringify(key)}, prompt: "complete after coordinator exit" },
      { launch: { env: ${JSON.stringify(workerEnv(fixture, "delayed"))} } },
    );
    process.stdout.write(JSON.stringify(started) + "\\n");
    setInterval(() => {}, 1_000);
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
}

async function waitForCoordinatorHandle(coordinator: ChildProcess): Promise<Record<string, unknown>> {
  let output = "";
  let stderr = "";
  coordinator.stdout?.setEncoding("utf8");
  coordinator.stderr?.setEncoding("utf8");
  coordinator.stdout?.on("data", (chunk: string) => { output += chunk; });
  coordinator.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const line = output.indexOf("\n");
    if (line >= 0) return JSON.parse(output.slice(0, line)) as Record<string, unknown>;
    if (coordinator.exitCode !== null || coordinator.signalCode !== null) {
      throw new Error(`coordinator exited before returning a handle: ${coordinator.exitCode ?? coordinator.signalCode}; ${stderr}`);
    }
    await sleep(25);
  }
  throw new Error(`coordinator did not return a handle: ${stderr}`);
}

async function stopCoordinator(coordinator: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!coordinator.kill(signal)) throw new Error(`failed to send ${signal} to coordinator`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (coordinator.exitCode !== null || coordinator.signalCode !== null) return;
    await sleep(25);
  }
  throw new Error(`coordinator did not exit after ${signal}`);
}

async function readTerminalFromSeparateProcess(projectRoot: string, idempotencyKey: string): Promise<Record<string, unknown>> {
  const workRunService = new URL("./work-run-service.js", import.meta.url).pathname;
  const code = `
    import { getWorkRunResult } from ${JSON.stringify(workRunService)};
    const deadline = Date.now() + 10_000;
    let result;
    while (Date.now() < deadline) {
      result = await getWorkRunResult({ projectRoot: ${JSON.stringify(projectRoot)}, idempotencyKey: ${JSON.stringify(idempotencyKey)} });
      if (result.kind === "run_terminal") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!result || result.kind !== "run_terminal") throw new Error("terminal result was not available: " + JSON.stringify(result));
    process.stdout.write(JSON.stringify(result));
  `;
  const reader = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stderr = "";
  reader.stdout?.setEncoding("utf8");
  reader.stderr?.setEncoding("utf8");
  reader.stdout?.on("data", (chunk: string) => { output += chunk; });
  reader.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    reader.once("error", reject);
    reader.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`result reader failed: ${status}; ${stderr}`)));
  });
  return JSON.parse(output) as Record<string, unknown>;
}

function runDirectoryFor(repo: string, runId: string): string {
  return join(repo, ".git", "codex-sidecar", "runs", runId);
}

async function createSecondRepository(root: string): Promise<string> {
  const repo = join(root, "second-repo");
  await mkdir(repo, { mode: 0o700 });
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

async function stopFixtureWorkers(repo: string): Promise<void> {
  const runs = join(repo, ".git", "codex-sidecar", "runs");
  let entries: string[];
  try {
    entries = await readdir(runs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.map(async (runId) => {
    const spawned = await readRecord(join(runs, runId, "launch.lock"), "spawn.json");
    if (!spawned || spawned.kind !== "spawn") return;
    const worker = spawned as SpawnRecord;
    if (!await matchesProcessIdentity(worker.processIdentity)) return;
    try { process.kill(-worker.pgid, "SIGKILL"); } catch {}
  }));
}

async function killFixtureWorker(runDirectory: string): Promise<void> {
  const worker = await readFixtureWorker(runDirectory);
  process.kill(-worker.pgid, "SIGKILL");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!await matchesProcessIdentity(worker.processIdentity)) return;
    await sleep(25);
  }
  throw new Error("killed durable worker remained alive");
}

async function readFixtureWorker(runDirectory: string): Promise<SpawnRecord> {
  const spawned = await readRecord(join(runDirectory, "launch.lock"), "spawn.json");
  if (!spawned || spawned.kind !== "spawn") throw new Error("expected durable worker spawn record");
  return spawned as SpawnRecord;
}

async function readFakeAppServerPid(marker: string): Promise<number> {
  const value = JSON.parse(await readFile(marker, "utf8")) as { pid?: unknown };
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error(`invalid fake App Server spawn marker: ${JSON.stringify(value)}`);
  }
  return value.pid;
}

async function processStatus(pid: number): Promise<{ pgid: number; stat: string }> {
  const { stdout } = await exec("ps", ["-p", String(pid), "-o", "pgid=,stat="]);
  const [pgid, stat] = stdout.trim().split(/\s+/, 2);
  if (!pgid || !stat || !/^\d+$/.test(pgid)) throw new Error(`unreadable process status for pid=${pid}: ${stdout}`);
  return { pgid: Number(pgid), stat };
}

async function waitForProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await processStatus(pid);
    } catch {
      return;
    }
    await sleep(25);
  }
  throw new Error(`App Server child remained alive after worker process-group SIGKILL: pid=${pid}`);
}

async function replaceCanonicalAuthAfterLogin(home: string): Promise<void> {
  const replacement = join(home, "auth.json.external-login");
  await writeFile(replacement, '{"refresh":"external-login"}\n', { mode: 0o600 });
  await rename(replacement, join(home, "auth.json"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
