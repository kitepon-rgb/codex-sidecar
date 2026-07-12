import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectCurrentDurableAuthRecovery } from "./durable-auth-session.js";
import { matchesProcessIdentity } from "./process-identity.js";
import { readRecord, type SpawnRecord } from "./run-records.js";
import { cancelWorkRun, getWorkRunResult, startWorkRun } from "./work-run-service.js";
import type { SidecarConfig, SidecarRunPending, SidecarRunTerminal } from "./types.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

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
    reply(message.id, { userAgent: "fixture", codexHome: process.env.CODEX_HOME || "", platformFamily: "unix", platformOs: process.platform });
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
      setImmediate(() => {
        if (interrupted) return;
        notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: report });
        notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } });
      });
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

function config(): SidecarConfig {
  return { project: "test", allowed_paths: ["README.md"] };
}

function workerEnv(fixture: Fixture, mode: "complete" | "hang", writePath = "README.md"): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: fixture.home,
    XDG_CACHE_HOME: fixture.cache,
    CODEX_BINARY: fixture.fakeCodex,
    FAKE_CODEX_MODE: mode,
    FAKE_CODEX_WRITE: "1",
    FAKE_CODEX_WRITE_PATH: writePath,
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

function runDirectoryFor(repo: string, runId: string): string {
  return join(repo, ".git", "codex-sidecar", "runs", runId);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
