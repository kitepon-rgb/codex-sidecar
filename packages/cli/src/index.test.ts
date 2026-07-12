import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

test("--version prints the packaged CLI version without config or cache access", async (t) => {
  const root = await fixture(t);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const result = await runCli(root.home, root.cache, ["--version"]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stdout, `${manifest.version}\n`);
  assert.equal(result.stderr, "");
  await assert.rejects(() => lstat(root.cache), { code: "ENOENT" });
});

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

test("diagnostics preserves the normalized request compatibility contract", async (t) => {
  const root = await workFixture(t);
  const result = await runCli(root.home, root.cache, ["diagnostics", "--project", root.repo]);
  assert.equal(result.code, 0, result.stdout);
  const payload = JSON.parse(result.stdout) as {
    status: string;
    configFile: string;
    projectRoot: string;
    normalizedRequest: { workflow: string; projectRoot: string; dryRun: boolean };
    modelPolicy: { source: string };
  };
  assert.equal(payload.status, "ok");
  assert.equal(payload.configFile, ".codex-sidecar.yml");
  assert.equal(payload.projectRoot, root.repo);
  assert.equal(payload.normalizedRequest.workflow, "review");
  assert.equal(payload.normalizedRequest.projectRoot, root.repo);
  assert.equal(payload.normalizedRequest.dryRun, true);
  assert.equal(payload.modelPolicy.source, "inherited");
  assert.equal("factoryReadiness" in payload, false);
});

test("factory-diagnostics returns native readiness without exposing request or filesystem data", async (t) => {
  const root = await workFixture(t);
  const bin = join(root.root, "bin");
  await mkdir(bin);
  const mcp = join(bin, "codex-sidecar-mcp");
  await writeFile(mcp, `#!/bin/sh
read request
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"codex-sidecar","version":"0.3.5"}}}'
`);
  await chmod(mcp, 0o755);
  const context = join(root.repo, "context.json");
  await writeFile(join(root.repo, ".codex-sidecar.yml"), [
    "project: cli-test",
    "defaults:",
    "  model: gpt-test-model",
    "presets:",
    "  review:",
    "    workflow: review",
    "    readonly: true",
    "    prompt: native-factory-private-prompt",
  ].join("\n"));
  await writeFile(context, JSON.stringify([{ kind: "manual_note", source: "test", trust: "local", summary: "native-factory-private-context" }]));

  const result = await runCli(root.home, root.cache, [
    "factory-diagnostics", "--project", root.repo, "--preset", "review", "--context-file", context,
  ], { PATH: `${bin}:${process.env.PATH}` });

  assert.equal(result.code, 0, result.stdout);
  const payload = JSON.parse(result.stdout) as {
    status: string;
    factoryReadiness: {
      schemaVersion: string;
      overall: string;
      packageVersions: { status: string; packages: Record<string, string> };
      resultSchema: { status: string };
      workflows: { status: string; entries: Record<string, { status: string }> };
      presets: { status: string; configured: number; ready: number; notReady: number; notApplicable: number };
      modelPolicy: { status: string; source: string; modelConfigured: boolean };
      readOnlyDryRun: { status: string; workflow: string };
    };
  };
  assert.equal(payload.status, "ok");
  assert.deepEqual(payload.factoryReadiness, {
    schemaVersion: "1",
    overall: "ready",
    packageVersions: {
      status: "ready",
      packages: {
        cli: "0.3.5",
        core: "0.3.5",
        mcp: "0.3.5",
      },
    },
    resultSchema: { status: "ready" },
    workflows: {
      status: "ready",
      entries: {
        review: { status: "ready" },
        explore: { status: "ready" },
        work: { status: "not_applicable" },
        opinion: { status: "ready" },
        "risk-check": { status: "ready" },
        auditor: { status: "ready" },
        generate: { status: "ready" },
      },
    },
    presets: {
      status: "ready",
      configured: 1,
      ready: 1,
      notReady: 0,
      notApplicable: 0,
    },
    modelPolicy: { status: "ready", source: "explicit", modelConfigured: true, modelReasoningEffortConfigured: false },
    readOnlyDryRun: { status: "ready", workflow: "review" },
  });
  assert.equal("normalizedRequest" in payload, false);
  assert.doesNotMatch(result.stdout, new RegExp(root.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.stdout, /native-factory-private-(prompt|context)/);
});

test("factory-diagnostics reports configuration failure as unverified without exposing the path", async (t) => {
  const root = await workFixture(t);
  await writeFile(join(root.repo, ".codex-sidecar.yml"), "project: [\n");
  const result = await runCli(root.home, root.cache, ["factory-diagnostics", "--project", root.repo]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "failed",
    factoryReadiness: { schemaVersion: "1", overall: "unverified" },
    errorCode: "PROTOCOL_ERROR",
  });
  assert.doesNotMatch(result.stdout, new RegExp(root.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

async function runCli(home: string, cache: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entrypoint = new URL("./index.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: { ...process.env, ...env, CODEX_HOME: home, XDG_CACHE_HOME: cache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, stdout, stderr };
}
