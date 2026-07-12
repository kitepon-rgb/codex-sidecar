import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __durableAuthTestHooks, createDurableAuthSession } from "./durable-auth-session.js";
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
  const config = await readFile(join(session.codexHome, "config.toml"), "utf8"); assert.match(config, /model_context_window = 272000/); assert.doesNotMatch(config, /mcp_servers/);
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
