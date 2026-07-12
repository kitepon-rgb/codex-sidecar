import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

test("auth-status is read-only and bypasses project config loading", async (t) => {
  const root = await fixture(t);
  const result = await runCli(root.home, root.cache, ["auth-status"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { state: "available" });
  await assert.rejects(() => lstat(root.cache), { code: "ENOENT" });
});

test("auth-recover rejects unknown strategy and missing confirmation before mutation", async (t) => {
  const root = await fixture(t);
  const unknown = await runCli(root.home, root.cache, ["auth-recover", "--session-id", "session-a", "--strategy", "not-a-strategy", "--confirm-no-running-processes"]);
  assert.equal(unknown.code, 1); assert.match(unknown.stdout, /--strategy must be one of/);
  const unconfirmed = await runCli(root.home, root.cache, ["auth-recover", "--session-id", "session-a", "--strategy", "release-never-started"]);
  assert.equal(unconfirmed.code, 1); assert.match(unconfirmed.stdout, /--confirm-no-running-processes is required/);
  await assert.rejects(() => lstat(root.cache), { code: "ENOENT" });
});

test("async work CLI uses project-root plus idempotency key for start, result, cancel, and inspection", async (t) => {
  const root = await workFixture(t);
  const start = await runCli(root.home, root.cache, [
    "work-start", "--project-root", root.repo, "--idempotency-key", key, "--dry-run",
  ]);
  assert.equal(start.code, 0, start.stdout);
  const started = JSON.parse(start.stdout) as { kind: string; runId: string; state: string; result: { status: string } };
  assert.equal(started.kind, "run_terminal");
  assert.equal(started.state, "completed");
  assert.equal(started.result.status, "dry-run");

  await writeFile(join(root.repo, ".codex-sidecar.yml"), "invalid: [\n");
  const retryAfterConfigDrift = await runCli(root.home, root.cache, [
    "work-start", "--project-root", root.repo, "--idempotency-key", key, "--dry-run",
  ]);
  assert.equal(retryAfterConfigDrift.code, 0, retryAfterConfigDrift.stdout);
  assert.equal((JSON.parse(retryAfterConfigDrift.stdout) as { runId: string }).runId, started.runId);

  const result = await runCli(root.home, root.cache, ["work-result", "--project-root", root.repo, "--idempotency-key", key]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal((JSON.parse(result.stdout) as { kind: string; runId: string }).kind, "run_terminal");
  assert.equal((JSON.parse(result.stdout) as { runId: string }).runId, started.runId);

  const cancel = await runCli(root.home, root.cache, ["work-cancel", "--project-root", root.repo, "--idempotency-key", key]);
  assert.equal(cancel.code, 0, cancel.stdout);
  assert.deepEqual(JSON.parse(cancel.stdout), {
    kind: "run_cancel_ack",
    runId: started.runId,
    accepted: false,
    terminal: true,
    state: "already_terminal",
    mode: "terminal",
    pollAfterMs: 250,
  });

  const inspection = await runCli(root.home, root.cache, ["work-recover", "--project-root", root.repo, "--idempotency-key", key]);
  assert.equal(inspection.code, 0, inspection.stdout);
  const recovered = JSON.parse(inspection.stdout) as { kind: string; outcome: string; status: { kind: string } };
  assert.equal(recovered.kind, "work_recovery_inspection");
  assert.equal(recovered.outcome, "inspection");
  assert.equal(recovered.status.kind, "run_terminal");
});

test("async work CLI maps durable lookup errors to a non-zero exit", async (t) => {
  const root = await workFixture(t);
  const missing = await runCli(root.home, root.cache, [
    "work-result", "--project-root", root.repo, "--idempotency-key", "BBBBBBBBBBBBBBBBBBBBBB",
  ]);
  assert.equal(missing.code, 1, missing.stdout);
  const payload = JSON.parse(missing.stdout) as { kind: string; error: { code: string } };
  assert.equal(payload.kind, "run_error");
  assert.equal(payload.error.code, "RUN_NOT_FOUND");
});

test("work recovery confirmation and all four work auth strategies use the shared parser", async (t) => {
  const root = await workFixture(t);
  const unconfirmed = await runCli(root.home, root.cache, [
    "work-recover", "--project-root", root.repo, "--idempotency-key", key, "--action", "quarantine",
  ]);
  assert.equal(unconfirmed.code, 1);
  assert.equal((JSON.parse(unconfirmed.stdout) as { kind: string; error: { code: string } }).kind, "run_error");
  assert.equal((JSON.parse(unconfirmed.stdout) as { error: { code: string } }).error.code, "RUN_INVALID_INPUT");

  const started = await runCli(root.home, root.cache, [
    "work-start", "--project-root", root.repo, "--idempotency-key", key, "--dry-run",
  ]);
  assert.equal(started.code, 0, started.stdout);

  for (const strategy of ["write-back-run-local", "keep-canonical-after-login", "release-never-started", "release-clean"]) {
    const outcome = await runCli(root.home, root.cache, [
      "work-auth-recover", "--project-root", root.repo, "--idempotency-key", key,
      "--strategy", strategy, "--confirm-no-running-processes",
    ]);
    assert.equal(outcome.code, 1, `${strategy}: ${outcome.stdout}`);
    assert.equal((JSON.parse(outcome.stdout) as { kind: string; error: { code: string } }).kind, "run_error");
    assert.equal((JSON.parse(outcome.stdout) as { error: { code: string } }).error.code, "RUN_AUTH_UNCERTAIN");
  }
});

async function fixture(t: test.TestContext): Promise<{ root: string; home: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); const cache = join(root, "cache");
  await mkdir(home, { mode: 0o700 }); await chmod(home, 0o700);
  await writeFile(join(home, "auth.json"), '{"refresh":"R0"}\n', { mode: 0o600 });
  return { root, home, cache };
}

async function workFixture(t: test.TestContext): Promise<{ root: string; home: string; cache: string; repo: string }> {
  const root = await fixture(t);
  const repo = join(root.root, "repo");
  await mkdir(repo, { mode: 0o700 });
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await writeFile(join(repo, ".codex-sidecar.yml"), "project: cli-test\nallowed_paths:\n  - README.md\n");
  await exec("git", ["add", "README.md", ".codex-sidecar.yml"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  return { ...root, repo };
}

async function runCli(home: string, cache: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entrypoint = new URL("./index.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: { ...process.env, CODEX_HOME: home, XDG_CACHE_HOME: cache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, stdout, stderr };
}
