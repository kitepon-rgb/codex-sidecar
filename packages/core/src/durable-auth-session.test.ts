import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __durableAuthTestHooks, createDurableAuthSession, inspectCurrentDurableAuthRecovery, inspectDurableAuthRecovery, recoverDurableAuthSessionForTarget, recoverSyncDurableAuthSession, recoveryTargetFromInspection } from "./durable-auth-session.js";
import { inspectAuthLease } from "./auth-lease.js";
import { currentProcessIdentity } from "./process-identity.js";

async function fixture(t: test.TestContext): Promise<{ home: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-durable-auth-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); const cache = join(root, "cache"); await mkdir(home, { mode: 0o700 }); await mkdir(cache, { mode: 0o700 }); await chmod(home, 0o700); await chmod(cache, 0o700);
  await writeFile(join(home, "auth.json"), '{"refresh":"R0"}\n', { mode: 0o600 });
  await writeFile(join(home, "config.toml"), 'model = "gpt-5.6"\nmodel_context_window = 272000\nmodel_auto_compact_token_limit = 240000\n[mcp_servers.bad]\ncommand="x"\n', { mode: 0o600 });
  return { home: await realpath(home), cache: await realpath(cache) };
}

test("durable session holds the global lease and commits rotated auth before clean release", async (t) => {
  const { home, cache } = await fixture(t);
  const session = await createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: home }, cacheRoot: cache, ownerKind: "sync-session", ownerId: "session-a" });
  assert.equal((await inspectAuthLease({ home, cacheRoot: cache, owner: { ...session.lease.owner, processIdentity: await currentProcessIdentity() } })).state, "held");
  const config = await readFile(join(session.codexHome, "config.toml"), "utf8");
  assert.match(config, /model = "gpt-5\.6"/);
  assert.doesNotMatch(config, /model_context_window|model_auto_compact_token_limit|mcp_servers/);
  await session.markAppServerStarted(); const rotated = join(session.codexHome, "auth.rotated"); await writeFile(rotated, '{"refresh":"R1"}\n', { mode: 0o600 }); await rename(rotated, join(session.codexHome, "auth.json")); await session.closeClean();
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"refresh":"R1"}\n');
  assert.equal((await inspectAuthLease({ home, cacheRoot: cache, owner: session.lease.owner })).state, "available");
  assert.deepEqual((await readdir(session.journalPath)).filter((name) => name.endsWith(".json")).sort(), ["app-server-exited.json", "app-server-started.json", "auth-written-back.json", "clean-shutdown.json", "lease-acquired.json", "run-local-rotation.json", "snapshot.json"]);
  assert.equal((await readdir(home)).some((name) => name.includes("codex-sidecar-session-a.tmp")), false);
});

test("all projects sharing canonical CODEX_HOME are serialized", async (t) => {
  const { home, cache } = await fixture(t); const first = await createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: home }, cacheRoot: cache, ownerKind: "sync-session", ownerId: "first" });
  await assert.rejects(() => createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: home }, cacheRoot: cache, ownerKind: "work-run", ownerId: "second" }), { code: "AUTH_LEASE_BUSY" });
  await first.closeClean();
});

test("subprocess kills at durable session entrypoint write-ahead checkpoints require explicit never-started recovery", async (t) => {
  const boundaries = [
    { name: "lease claim before lease-acquired evidence", hook: "afterLeaseClaimBeforeLeaseAcquired", leaseEvidence: false, snapshot: false },
    { name: "lease-acquired evidence before snapshot", hook: "afterLeaseAcquiredBeforeSnapshot", leaseEvidence: true, snapshot: false },
    { name: "snapshot evidence before App Server started", hook: "afterSnapshotBeforeAppServerStarted", leaseEvidence: true, snapshot: true },
  ] as const;
  for (const boundary of boundaries) await t.test(boundary.name, async (t) => {
    const { home, cache } = await fixture(t);
    await killSessionAtCheckpoint(home, cache, `killed-${boundary.hook}`, boundary.hook);

    const status = await inspectDurableAuthRecovery({ home, cacheRoot: cache });
    assert.equal(status.state, "held");
    if (status.state !== "held") throw new Error("killed session must leave a held lease");
    assert.equal(status.snapshotPresent, boundary.snapshot);
    assert.equal(status.appServerStarted, false);
    assert.deepEqual(status.candidates, ["release-never-started"]);
    const journal = await readdir(status.journalPath);
    assert.equal(journal.includes("lease-acquired.json"), boundary.leaseEvidence);
    assert.equal(journal.includes("snapshot.json"), boundary.snapshot);
    assert.equal(journal.includes("app-server-started.json"), false);
    assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"refresh":"R0"}\n');

    await recoverCurrentDurableAuth({ home, cacheRoot: cache, strategy: "release-never-started", confirmNoRunningProcesses: true });
    assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "available");
  });
});

test("external canonical auth change leaves the durable lease held and fails closed", async (t) => {
  const { home, cache } = await fixture(t); const session = await createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: home }, cacheRoot: cache, ownerKind: "sync-session", ownerId: "uncertain" });
  await session.markAppServerStarted(); await writeFile(join(session.codexHome, "auth.json"), '{"refresh":"R1"}\n', { mode: 0o600 }); await writeFile(join(home, "auth.json"), '{"refresh":"external"}\n', { mode: 0o600 });
  await assert.rejects(() => session.closeClean(), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal((await inspectAuthLease({ home, cacheRoot: cache, owner: session.lease.owner })).state, "held");
});

test("durable session rejects owner path traversal before creating session artifacts", async (t) => {
  const { home, cache } = await fixture(t);
  await assert.rejects(() => createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: home }, cacheRoot: cache, ownerKind: "sync-session", ownerId: "../escape" }), { code: "RUN_INVALID_INPUT" });
});

test("in-place run-local auth rewrite is not accepted as rotation evidence", async (t) => {
  const { home, cache } = await fixture(t); const session = await createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: home }, cacheRoot: cache, ownerKind: "sync-session", ownerId: "in-place" });
  await session.markAppServerStarted(); await writeFile(join(session.codexHome, "auth.json"), '{"refresh":"R1"}\n', { mode: 0o600 });
  await assert.rejects(() => session.closeClean(), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"refresh":"R0"}\n');
  assert.equal((await inspectAuthLease({ home, cacheRoot: cache, owner: session.lease.owner })).state, "held");
});

test("write-back is bound to the auth bytes named by durable rotation evidence", async (t) => {
  const { home, cache } = await fixture(t); const session = await createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: home }, cacheRoot: cache, ownerKind: "sync-session", ownerId: "bound-write" });
  await session.markAppServerStarted(); const first = join(session.codexHome, "first"); await writeFile(first, '{"refresh":"R1"}\n', { mode: 0o600 }); await rename(first, join(session.codexHome, "auth.json"));
  __durableAuthTestHooks.beforeBoundWriteBack = async () => { const second = join(session.codexHome, "second"); await writeFile(second, '{"refresh":"R2"}\n', { mode: 0o600 }); await rename(second, join(session.codexHome, "auth.json")); };
  t.after(() => { __durableAuthTestHooks.beforeBoundWriteBack = undefined; });
  await assert.rejects(() => session.closeClean(), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"refresh":"R0"}\n');
  assert.equal((await inspectAuthLease({ home, cacheRoot: cache, owner: session.lease.owner })).state, "held");
});

test("write-back rechecks canonical auth immediately before atomic replace", async (t) => {
  const { home, cache } = await fixture(t); const session = await createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: home }, cacheRoot: cache, ownerKind: "sync-session", ownerId: "canonical-race" });
  await session.markAppServerStarted(); const rotated = join(session.codexHome, "rotated"); await writeFile(rotated, '{"refresh":"R1"}\n', { mode: 0o600 }); await rename(rotated, join(session.codexHome, "auth.json"));
  __durableAuthTestHooks.beforeAtomicWriteBack = async () => { const external = join(home, "external-login"); await writeFile(external, '{"refresh":"EXTERNAL"}\n', { mode: 0o600 }); await rename(external, join(home, "auth.json")); };
  t.after(() => { __durableAuthTestHooks.beforeAtomicWriteBack = undefined; });
  await assert.rejects(() => session.closeClean(), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"refresh":"EXTERNAL"}\n');
  assert.equal((await inspectAuthLease({ home, cacheRoot: cache, owner: session.lease.owner })).state, "held");
});

test("operator recovery releases a dead never-started durable session only with explicit strategy", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "never-started", "never-started");
  const status = await inspectDurableAuthRecovery({ home, cacheRoot: cache });
  assert.equal(status.state, "held"); assert.ok(status.candidates.includes("release-never-started"));
  await recoverCurrentDurableAuth({ home, cacheRoot: cache, strategy: "release-never-started", confirmNoRunningProcesses: true });
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "available");
});

test("operator write-back recovery accepts only durable atomic rotation evidence", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "recovery-writeback", "rotated");
  const status = await inspectDurableAuthRecovery({ home, cacheRoot: cache });
  assert.equal(status.state, "held"); assert.ok(status.candidates.includes("write-back-run-local"));
  await recoverCurrentDurableAuth({ home, cacheRoot: cache, strategy: "write-back-run-local", confirmNoRunningProcesses: true });
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"refresh":"R1"}\n');
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "available");
});

test("write-back recovery validates the App Server boundary before mutating canonical auth", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "recovery-missing-start", "rotated");
  const status = await inspectDurableAuthRecovery({ home, cacheRoot: cache });
  assert.equal(status.state, "held");
  await rm(join(status.journalPath, "app-server-started.json"));
  await assert.rejects(() => recoverCurrentDurableAuth({ home, cacheRoot: cache, strategy: "write-back-run-local", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"refresh":"R0"}\n');
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "held");
});

test("operator keep-canonical-after-login never adopts the abandoned run-local auth", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "recovery-login", "started");
  const replacement = join(home, "login-auth"); await writeFile(replacement, '{"refresh":"LOGIN"}\n', { mode: 0o600 }); await rename(replacement, join(home, "auth.json"));
  await recoverCurrentDurableAuth({ home, cacheRoot: cache, strategy: "keep-canonical-after-login", confirmNoRunningProcesses: true });
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"refresh":"LOGIN"}\n');
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "available");
});

test("operator release-clean requires the completed journal and leaves an audit recovery record", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "recovery-clean", "clean");
  const status = await inspectDurableAuthRecovery({ home, cacheRoot: cache });
  assert.equal(status.state, "held"); assert.ok(status.candidates.includes("release-clean"));
  await recoverCurrentDurableAuth({ home, cacheRoot: cache, strategy: "release-clean", confirmNoRunningProcesses: true });
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "available");
  assert.equal((await readdir(status.journalPath)).includes("operator-recovery.json"), true);
});

test("operator recovery requires explicit process-stop confirmation without mutating the held lease", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "recovery-confirm", "never-started");
  await assert.rejects(() => recoverCurrentDurableAuth({ home, cacheRoot: cache, strategy: "release-never-started", confirmNoRunningProcesses: false }), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "held");
});

test("bound operator recovery never acts on a later lease for the same canonical home", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "target-first", "never-started");
  const first = await inspectDurableAuthRecovery({ home, cacheRoot: cache });
  assert.equal(first.state, "held");
  const target = recoveryTargetFromInspection(first);
  await recoverDurableAuthSessionForTarget({ home, cacheRoot: cache, strategy: "release-never-started", confirmNoRunningProcesses: true }, target);
  await abandonSession(home, cache, "target-second", "never-started");
  await assert.rejects(() => recoverDurableAuthSessionForTarget({ home, cacheRoot: cache, strategy: "release-never-started", confirmNoRunningProcesses: true }, target), { code: "RUN_AUTH_UNCERTAIN" });
  const second = await inspectDurableAuthRecovery({ home, cacheRoot: cache });
  assert.equal(second.state, "held"); assert.equal(second.ownerId, "target-second");
});

test("current auth status is read-only when no sidecar cache exists", async (t) => {
  const { home, cache } = await fixture(t); const missingCache = join(cache, "not-created");
  assert.deepEqual(await inspectCurrentDurableAuthRecovery({ baseEnv: { CODEX_HOME: home }, cacheRoot: missingCache }), { state: "available" });
  await assert.rejects(() => lstat(missingCache), { code: "ENOENT" });
});

test("sync auth recovery binds the requested session id before changing a lease", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "sync-recover", "never-started");
  await assert.rejects(() => recoverSyncDurableAuthSession({ baseEnv: { CODEX_HOME: home }, cacheRoot: cache, sessionId: "other-session", strategy: "release-never-started", confirmNoRunningProcesses: true }), { code: "RUN_NOT_FOUND" });
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "held");
  await recoverSyncDurableAuthSession({ baseEnv: { CODEX_HOME: home }, cacheRoot: cache, sessionId: "sync-recover", strategy: "release-never-started", confirmNoRunningProcesses: true });
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "available");
});

test("unknown durable auth recovery strategy is rejected before mutation", async (t) => {
  const { home, cache } = await fixture(t); await abandonSession(home, cache, "unknown-strategy", "never-started");
  const status = await inspectDurableAuthRecovery({ home, cacheRoot: cache });
  assert.equal(status.state, "held");
  await assert.rejects(() => recoverDurableAuthSessionForTarget({ home, cacheRoot: cache, strategy: "unknown" as never, confirmNoRunningProcesses: true }, recoveryTargetFromInspection(status)), { code: "RUN_INVALID_INPUT" });
  assert.equal((await inspectDurableAuthRecovery({ home, cacheRoot: cache })).state, "held");
});

async function recoverCurrentDurableAuth(input: Parameters<typeof recoverDurableAuthSessionForTarget>[0]): Promise<void> {
  const inspection = await inspectDurableAuthRecovery(input);
  if (inspection.state !== "held") throw new Error("test fixture does not hold a durable auth lease");
  return recoverDurableAuthSessionForTarget(input, recoveryTargetFromInspection(inspection));
}

async function abandonSession(home: string, cache: string, id: string, mode: "never-started" | "started" | "rotated" | "clean"): Promise<void> {
  const module = new URL("./durable-auth-session.js", import.meta.url).pathname;
  const authLease = new URL("./auth-lease.js", import.meta.url).pathname;
  const lifecycle = mode === "rotated" || mode === "clean"
    ? `const next=session.codexHome+'/rotated'; await writeFile(next,'{\\"refresh\\":\\"R1\\"}\\n',{mode:0o600}); await rename(next,session.codexHome+'/auth.json'); await session.recordRunLocalRotation();`
    : "";
  const finalizer = mode === "clean" ? `__authLeaseTestHooks.beforeReleaseUnlink=async()=>{process.exit(0)}; await session.closeClean();` : "";
  const code = `import {createDurableAuthSession} from ${JSON.stringify(module)}; import {__authLeaseTestHooks} from ${JSON.stringify(authLease)}; import {writeFile,rename} from 'node:fs/promises'; const session=await createDurableAuthSession({baseEnv:{CODEX_HOME:${JSON.stringify(home)}},cacheRoot:${JSON.stringify(cache)},ownerKind:'sync-session',ownerId:${JSON.stringify(id)}}); ${mode === "never-started" ? "" : "await session.markAppServerStarted();"} ${lifecycle} ${finalizer}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`abandoned-session child failed: ${status}`))); });
}

async function killSessionAtCheckpoint(
  home: string,
  cache: string,
  id: string,
  hook: "afterLeaseClaimBeforeLeaseAcquired" | "afterLeaseAcquiredBeforeSnapshot" | "afterSnapshotBeforeAppServerStarted",
): Promise<void> {
  const module = new URL("./durable-auth-session.js", import.meta.url).pathname;
  const code = `
    import { __durableAuthTestHooks, createDurableAuthSession } from ${JSON.stringify(module)};
    __durableAuthTestHooks[${JSON.stringify(hook)}] = async () => {
      process.stdout.write("READY\\n");
      process.kill(process.pid, "SIGSTOP");
    };
    await createDurableAuthSession({
      baseEnv: { CODEX_HOME: ${JSON.stringify(home)} }, cacheRoot: ${JSON.stringify(cache)},
      ownerKind: "sync-session", ownerId: ${JSON.stringify(id)},
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (output.includes("READY\n")) break;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`boundary child exited early: ${child.exitCode ?? child.signalCode}; ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!output.includes("READY\n")) throw new Error(`boundary child did not become ready: ${stderr}`);
  child.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}
