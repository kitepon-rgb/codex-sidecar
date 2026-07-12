import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { lookupStoredRun, openOrCreateRun } from "./run-store.js";
import { toSidecarError } from "./results.js";
import type { RunStartInput } from "./run-types.js";
import { SIDECAR_RUN_ERROR_CODES, type SidecarRequest } from "./types.js";

const execFileAsync = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

test("same key retry reopens the winner without normalization or HEAD resolution", async (t) => {
  const repo = await createRepo(t);
  const first = await open(repo);
  await commit(repo, "second");
  const retry = await open(repo, { prepare: async () => { throw new Error("must not normalize a retry"); } });

  assert.equal(retry.created, false);
  assert.equal(retry.manifest.runId, first.manifest.runId);
  assert.equal(retry.manifest.baseCommit, first.manifest.baseCommit);
  assert.deepEqual(retry.claim, first.claim);
  assert.equal(await readFile(join(first.runDirectory, "manifest.json"), "utf8").then((value) => value.includes(key)), false);
  assert.equal("idempotencyKey" in retry.manifest.normalizedRequest, false);
});

test("same key rejects a different caller raw input", async (t) => {
  const repo = await createRepo(t);
  await open(repo);
  await assert.rejects(() => open(repo, { rawInput: { prompt: "different" } }), { code: "RUN_KEY_CONFLICT" });
  await assert.rejects(() => open(repo, { baseRef: "refs/heads/main" }), { code: "RUN_KEY_CONFLICT" });
});

test("same key from a linked worktree is a raw identity conflict", async (t) => {
  const repo = await createRepo(t);
  await open(repo);
  const linked = await mkdtemp(join(tmpdir(), "codex-sidecar-linked-"));
  t.after(() => rm(linked, { recursive: true, force: true }));
  await git(repo, ["worktree", "add", "--detach", linked, "HEAD"]);
  await assert.rejects(() => open(linked), { code: "RUN_KEY_CONFLICT" });
});

test("new manifest fixes the original base commit for the future worker", async (t) => {
  const repo = await createRepo(t);
  const before = await git(repo, ["rev-parse", "HEAD"]);
  const stored = await open(repo);
  await commit(repo, "later");
  assert.equal(stored.manifest.baseCommit, before.trim());
});

test("parallel starts elect one manifest winner", async (t) => {
  const repo = await createRepo(t);
  let normalized = 0;
  const runs = await Promise.all(Array.from({ length: 12 }, () => open(repo, {
    prepare: async () => { normalized += 1; return snapshot(repo); },
  })));
  assert.equal(new Set(runs.map((run) => run.manifest.runId)).size, 1);
  assert.equal(new Set(runs.map((run) => run.claim.token)).size, 1);
  assert.equal(runs.filter((run) => run.created).length, 1);
  assert.ok(normalized >= 1);
});

test("corrupt final manifest is rejected without overwrite", async (t) => {
  const repo = await createRepo(t);
  const stored = await open(repo);
  const manifestPath = join(stored.runDirectory, "manifest.json");
  await chmod(manifestPath, 0o600);
  await writeFile(manifestPath, "{not json", { mode: 0o600 });
  await assert.rejects(() => open(repo), { code: "RUN_STORE_CORRUPT" });
  assert.equal(await readFile(manifestPath, "utf8"), "{not json");
});

test("store directories and manifests are private and active tree stays unchanged", async (t) => {
  const repo = await createRepo(t);
  const stored = await open(repo);
  assert.equal((await stat(join(stored.storeRoot, ".."))).mode & 0o777, 0o700);
  assert.equal((await stat(stored.storeRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(stored.runDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(stored.runDirectory, "launch.lock"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(stored.runDirectory, "manifest.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stored.runDirectory, "launch.lock", "claim.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stored.runDirectory, "launch.lock", "heartbeat.json"))).mode & 0o777, 0o600);
  await assert.rejects(() => stat(join(stored.runDirectory, "records")), { code: "ENOENT" });
  assert.equal((await git(repo, ["status", "--porcelain=v1"])).trim(), "");
});

test("a discarded start response is recovered by re-opening with the same key", async (t) => {
  const repo = await createRepo(t);
  const discarded = await open(repo);
  const recovered = await open(repo, { prepare: async () => { throw new Error("response-loss retry must not prepare"); } });
  assert.equal(recovered.manifest.runId, discarded.manifest.runId);
  assert.equal(recovered.created, false);
});

test("read-only lookup resolves the exact durable run without creating a store", async (t) => {
  const repo = await createRepo(t);
  await assert.rejects(() => lookupStoredRun({ projectRoot: repo, idempotencyKey: key }), { code: "RUN_NOT_FOUND" });
  const stored = await open(repo);
  const found = await lookupStoredRun({ projectRoot: repo, idempotencyKey: key });
  assert.equal(found.created, false);
  assert.equal(found.runDirectory, stored.runDirectory);
  assert.deepEqual(found.manifest, stored.manifest);
  assert.deepEqual(found.claim, stored.claim);
});

test("raw identity applies only API-fixed defaults and distinguishes config-derived omissions", async (t) => {
  const repo = await createRepo(t);
  const omitted = await open(repo, { rawInput: { prompt: "change README" } });
  const explicitDefaults = await open(repo, { rawInput: { prompt: "change README", workflow: "work", turnTimeoutMs: 600_000, interruptOnTimeout: true, preserveWorktree: true, context: [], dryRun: false } });
  assert.equal(explicitDefaults.created, false);
  assert.equal(explicitDefaults.manifest.rawInputDigest, omitted.manifest.rawInputDigest);
  await assert.rejects(() => open(repo, { rawInput: { prompt: "change README", readonly: false } }), { code: "RUN_KEY_CONFLICT" });
});

test("raw start input rejects non-JSON values and undefined array entries", async (t) => {
  const repo = await createRepo(t);
  await assert.rejects(() => open(repo, { rawInput: { prompt: "x", context: [undefined] } as unknown as RunStartInput["rawInput"] }), { code: "RUN_INVALID_INPUT" });
  await assert.rejects(() => open(repo, { rawInput: { prompt: "x", context: [new Date()] } as unknown as RunStartInput["rawInput"] }), { code: "RUN_INVALID_INPUT" });
});

test("tampered valid-looking OID and symlinked run directory are corrupt", async (t) => {
  const repo = await createRepo(t);
  const stored = await open(repo);
  const manifestPath = join(stored.runDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.baseCommit = "0".repeat(40);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await assert.rejects(() => open(repo), { code: "RUN_STORE_CORRUPT" });

  await rm(stored.runDirectory, { recursive: true, force: true });
  await symlink(repo, stored.runDirectory);
  await assert.rejects(() => open(repo), { code: "RUN_STORE_CORRUPT" });
});

test("mode drift and normalized request digest drift are corrupt", async (t) => {
  const repo = await createRepo(t);
  const stored = await open(repo);
  await chmod(stored.runDirectory, 0o755);
  await assert.rejects(() => open(repo), { code: "RUN_STORE_CORRUPT" });
  await chmod(stored.runDirectory, 0o700);
  const manifestPath = join(stored.runDirectory, "manifest.json");
  await chmod(manifestPath, 0o644);
  await assert.rejects(() => open(repo), { code: "RUN_STORE_CORRUPT" });
  await chmod(manifestPath, 0o600);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { normalizedRequest: { dryRun: boolean } };
  manifest.normalizedRequest.dryRun = true;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await assert.rejects(() => open(repo), { code: "RUN_STORE_CORRUPT" });
});

test("a symlinked manifest is rejected even when its target is valid JSON", async (t) => {
  const repo = await createRepo(t);
  const stored = await open(repo);
  const manifestPath = join(stored.runDirectory, "manifest.json");
  const externalManifest = join(repo, "external-manifest.json");
  await writeFile(externalManifest, await readFile(manifestPath, "utf8"), { mode: 0o600 });
  await rm(manifestPath);
  await symlink(externalManifest, manifestPath);
  await assert.rejects(() => open(repo), { code: "RUN_STORE_CORRUPT" });
});

test("a symlinked store namespace is rejected without touching its target", async (t) => {
  const repo = await createRepo(t);
  const external = await mkdtemp(join(tmpdir(), "codex-sidecar-external-store-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const namespace = join(repo, ".git", "codex-sidecar");
  await symlink(external, namespace);
  await assert.rejects(() => open(repo), { code: "RUN_STORE_CORRUPT" });
  assert.deepEqual(await readdir(external), []);
});

test("all run error codes survive conversion to SidecarError", () => {
  for (const code of SIDECAR_RUN_ERROR_CODES) {
    const converted = toSidecarError(Object.assign(new Error(`${code}: test`), { code }));
    assert.equal(converted.code, code);
  }
  assert.equal(toSidecarError(Object.assign(new Error("busy"), { code: "AUTH_LEASE_BUSY" })).code, "AUTH_LEASE_BUSY");
});

async function open(
  projectRoot: string,
  options: { rawInput?: Record<string, unknown>; baseRef?: string; prepare?: () => Promise<{ normalizedRequest: SidecarRequest }> } = {},
) {
  const input: RunStartInput = {
    projectRoot,
    idempotencyKey: key,
    rawInput: options.rawInput ?? { prompt: "change README", dryRun: false },
    baseRef: options.baseRef,
  };
  return openOrCreateRun(input, options.prepare ?? (() => snapshot(projectRoot)));
}

function snapshot(projectRoot: string): Promise<{ normalizedRequest: SidecarRequest }> {
  return Promise.resolve({
    normalizedRequest: {
      workflow: "work", projectRoot, prompt: "change README", readonly: false, requireWorktree: true,
      focus: [], allowedPaths: ["README.md"], denyPaths: [], safetyProfile: "generic", resultFormat: "json",
      turnTimeoutMs: 1_000, interruptOnTimeout: true, preserveWorktree: true, context: [], dryRun: false,
    },
  });
}

async function createRepo(t: test.TestContext): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "codex-sidecar-run-store-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function commit(repo: string, content: string): Promise<void> {
  await writeFile(join(repo, "README.md"), `${content}\n`);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", content]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}
