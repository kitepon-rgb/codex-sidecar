import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attemptDirectory, ensureRecordDirectory, promoteResultToTerminal, publishRecord, readClaim, readHeartbeat, readRecord, replaceHeartbeat } from "./run-records.js";
import { sha256, stableJson } from "./run-store.js";
import type { LaunchClaim } from "./run-types.js";

const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ_0123456789-".slice(0, 43);
const owner = { pid: process.pid, startIdentity: "test-process" };

async function directory(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-sidecar-records-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  await chmod(path, 0o700);
  return path;
}

function claim(): LaunchClaim {
  const body = { version: 1 as const, kind: "claim" as const, generation: 1, token, owner, createdAt: "2026-07-12T00:00:00.000Z" };
  return { ...body, digest: sha256(stableJson(body)) };
}

test("immutable record publish is create-only, idempotent only for exact content, and leaves no final file before publish", async (t) => {
  const dir = await directory(t);
  await writeFile(join(dir, ".tmp-interrupted"), "partial", { mode: 0o600 });
  assert.equal(await readRecord(dir, "claim.json"), undefined);
  await publishRecord(dir, "claim.json", claim());
  await publishRecord(dir, "claim.json", claim());
  await assert.rejects(() => publishRecord(dir, "claim.json", { ...claim(), createdAt: "2026-07-12T00:00:01.000Z" }), { code: "RUN_STORE_CORRUPT" });
  assert.equal((await lstat(join(dir, "claim.json"))).mode & 0o777, 0o600);
  assert.equal(await readRecord(dir, "heartbeat.json"), undefined);
});

test("record reader rejects symlink, modes, malformed envelopes, and digest corruption", async (t) => {
  const dir = await directory(t);
  const external = join(dir, "external.json");
  await writeFile(external, "{}", { mode: 0o600 });
  await symlink(external, join(dir, "claim.json"));
  await assert.rejects(() => readRecord(dir, "claim.json"), { code: "RUN_STORE_CORRUPT" });
  await rm(join(dir, "claim.json"));
  await publishRecord(dir, "claim.json", claim());
  await chmod(join(dir, "claim.json"), 0o644);
  await assert.rejects(() => readRecord(dir, "claim.json"), { code: "RUN_STORE_CORRUPT" });
  await chmod(join(dir, "claim.json"), 0o600);
  const value = JSON.parse(await readFile(join(dir, "claim.json"), "utf8"));
  value.digest = "0".repeat(64);
  await writeFile(join(dir, "claim.json"), JSON.stringify(value), { mode: 0o600 });
  await assert.rejects(() => readRecord(dir, "claim.json"), { code: "RUN_STORE_CORRUPT" });
});

test("record API rejects malformed typed records, unsupported names, and filename-kind mismatch", async (t) => {
  const dir = await directory(t);
  await assert.rejects(() => publishRecord(dir, "ready.json", { kind: "ready", generation: 1, token }));
  await assert.rejects(() => publishRecord(dir, "claim.json", { kind: "spawn", generation: 1, token, pid: 0, pgid: 0 }));
  await assert.rejects(() => publishRecord(dir, "heartbeat.json", claim()));
  await assert.rejects(() => publishRecord(dir, "execution-started.json", { kind: "execution-started", generation: Number.MAX_SAFE_INTEGER + 1, token, createdAt: "2026-07-12T00:00:00.000Z" }));
});

test("spawn reader rejects digest-valid invalid process fields and unknown keys", async (t) => {
  const dir = await directory(t);
  const writeMalformedSpawn = async (body: Record<string, unknown>) => {
    await writeFile(join(dir, "spawn.json"), JSON.stringify({ ...body, digest: sha256(stableJson(body)) }), { mode: 0o600 });
    await assert.rejects(() => readRecord(dir, "spawn.json"), { code: "RUN_STORE_CORRUPT" });
  };
  const base = { version: 1, kind: "spawn", generation: 1, token, pid: 2, pgid: 2, processIdentity: { pid: 2, startIdentity: "process" }, createdAt: "2026-07-12T00:00:00.000Z" };
  await writeMalformedSpawn({ ...base, pid: 0 });
  await writeMalformedSpawn({ ...base, processIdentity: { pid: 0, startIdentity: "" } });
  await writeMalformedSpawn({ ...base, unexpected: true });
});

test("attempt directories require safe identities and stay private", async (t) => {
  const run = await directory(t);
  const attempt = await attemptDirectory(run, 1, token);
  assert.equal((await lstat(join(run, "attempts"))).mode & 0o777, 0o700);
  assert.equal((await lstat(attempt)).mode & 0o777, 0o700);
  await assert.rejects(() => attemptDirectory(run, 0, token), { code: "RUN_INVALID_INPUT" });
  await assert.rejects(() => attemptDirectory(run, 1, "../bad"), { code: "RUN_INVALID_INPUT" });
  await rm(join(run, "attempts"), { recursive: true });
  await symlink("/tmp", join(run, "attempts"));
  await assert.rejects(() => attemptDirectory(run, 1, token), { code: "RUN_STORE_CORRUPT" });
});

test("claim and heartbeat use strict schemas and heartbeat only accepts the current owner", async (t) => {
  const lock = await directory(t);
  const current = claim();
  await publishRecord(lock, "claim.json", current);
  await publishRecord(lock, "heartbeat.json", { kind: "heartbeat", generation: 1, token, owner, updatedAt: "2026-07-12T00:00:00.000Z" });
  assert.deepEqual(await readClaim(lock), current);
  assert.equal((await readHeartbeat(lock, current)).updatedAt, "2026-07-12T00:00:00.000Z");
  await replaceHeartbeat(lock, current, { kind: "heartbeat", generation: 1, token, owner, updatedAt: "2026-07-12T00:00:01.000Z" });
  await assert.rejects(() => replaceHeartbeat(lock, { ...current, token: token.replace("a", "b") }, { kind: "heartbeat", generation: 1, token, owner, updatedAt: "2026-07-12T00:00:02.000Z" }), { code: "RUN_STORE_CORRUPT" });
  assert.equal((await lstat(join(lock, "heartbeat.json"))).mode & 0o777, 0o600);
});

test("claim rejects unknown or missing keys, invalid token/generation/timestamp/process identity, digest, mode, and symlink", async (t) => {
  const lock = await directory(t);
  const original = claim();
  await publishRecord(lock, "claim.json", original);
  const claimPath = join(lock, "claim.json");
  const corrupt = async (mutate: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
    mutate(value);
    await writeFile(claimPath, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(() => readClaim(lock), { code: "RUN_STORE_CORRUPT" });
    await writeFile(claimPath, JSON.stringify(original), { mode: 0o600 });
  };
  await corrupt((value) => { value.extra = true; });
  await corrupt((value) => { delete value.createdAt; });
  await corrupt((value) => { value.token = "short"; });
  await corrupt((value) => { value.generation = 0; });
  await corrupt((value) => { value.createdAt = "not-a-time"; });
  await corrupt((value) => { value.owner = { pid: 0, startIdentity: "" }; });
  await corrupt((value) => { value.digest = "0".repeat(64); });
  await chmod(claimPath, 0o644);
  await assert.rejects(() => readClaim(lock), { code: "RUN_STORE_CORRUPT" });
  await chmod(claimPath, 0o600);
  const external = join(lock, "claim-target.json");
  await writeFile(external, JSON.stringify(original), { mode: 0o600 });
  await rm(claimPath);
  await symlink(external, claimPath);
  await assert.rejects(() => readClaim(lock), { code: "RUN_STORE_CORRUPT" });
});

test("run-level immutable records are strict, and a durable result promotes exactly one terminal", async (t) => {
  const dir = await directory(t);
  const result = { status: "ok", workflow: "work", summary: "done", confidence: { level: "high", rationale: "test" }, recommendedNextAction: "none", unvalidatedReport: { preserved: true } };
  await publishRecord(dir, "cancel.json", { kind: "cancel", observedGeneration: 1, observedToken: token, createdAt: "2026-07-12T00:00:00.000Z" });
  await publishRecord(dir, "execution-started.json", { kind: "execution-started", generation: 1, token, createdAt: "2026-07-12T00:00:00.000Z" });
  await publishRecord(dir, "quarantine.json", { kind: "quarantine", generation: 1, token, createdAt: "2026-07-12T00:00:00.000Z" });
  await publishRecord(dir, "result.json", { kind: "result", generation: 1, token, result, createdAt: "2026-07-12T00:00:00.000Z" });
  await publishRecord(dir, "cleanup.json", { kind: "cleanup", generation: 1, token, state: "not-requested", createdAt: "2026-07-12T00:00:00.000Z" });
  const terminal = await promoteResultToTerminal(dir, 1, token);
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.resultDigest, (await readRecord(dir, "result.json"))!.digest);
  await assert.rejects(() => publishRecord(dir, "terminal.json", { kind: "terminal", generation: 1, token, state: "failed", resultDigest: "0".repeat(64), createdAt: "2026-07-12T00:00:00.000Z" }), { code: "RUN_STORE_CORRUPT" });
  await assert.rejects(() => publishRecord(dir, "result.json", { kind: "result", generation: 1, token, result: { ...result, unexpected: true }, createdAt: "2026-07-12T00:00:00.000Z" }));
  await assert.rejects(() => publishRecord(dir, "result.json", { kind: "result", generation: 2, token, result: {}, createdAt: "2026-07-12T00:00:00.000Z" }));
  await assert.rejects(() => publishRecord(dir, "result.json", { kind: "result", generation: 2, token, result: { ...result, changedFiles: [1] }, createdAt: "2026-07-12T00:00:00.000Z" }));
  await assert.rejects(() => publishRecord(dir, "result.json", { kind: "result", generation: 2, token, result: { ...result, confidence: { level: "high", extra: true } }, createdAt: "2026-07-12T00:00:00.000Z" }));
  await assert.rejects(() => publishRecord(dir, "result.json", { kind: "result", generation: 2, token, result: { ...result, workflow: "review" }, createdAt: "2026-07-12T00:00:00.000Z" }));
  await assert.rejects(() => publishRecord(dir, "result.json", { kind: "result", generation: 2, token, result: { ...result, error: { code: "MADE_UP", message: "x" } }, createdAt: "2026-07-12T00:00:00.000Z" }));
  await assert.rejects(() => publishRecord(dir, "result.json", { kind: "result", generation: 2, token, result: { ...result, normalizedRequest: { workflow: "work", projectRoot: "/x", readonly: false, requireWorktree: true, focus: [], allowedPaths: [], denyPaths: [], safetyProfile: "made-up", resultFormat: "json", turnTimeoutMs: 1, interruptOnTimeout: true, preserveWorktree: true, context: [{ kind: "made-up" }], dryRun: false } }, createdAt: "2026-07-12T00:00:00.000Z" }));
  await assert.rejects(() => publishRecord(dir, "cancel.json", { kind: "cancel", generation: 1, token, observedGeneration: 1, observedToken: token, createdAt: "2026-07-12T00:00:00.000Z" }));
});

test("durable result records omit optional undefined fields without changing the JSON payload", async (t) => {
  const dir = await directory(t);
  const result = {
    status: "ok" as const,
    workflow: "work" as const,
    summary: "done",
    confidence: { level: "high" as const, rationale: undefined },
    recommendedNextAction: "none",
    findings: undefined,
    risks: undefined,
    tests: undefined,
  };
  await publishRecord(dir, "result.json", {
    kind: "result", generation: 1, token, result, createdAt: "2026-07-12T00:00:00.000Z",
  });

  const durable = await readRecord(dir, "result.json");
  assert.equal(durable?.kind, "result");
  const stored = durable as unknown as { result: Record<string, unknown> };
  assert.equal("findings" in stored.result, false);
  assert.equal("risks" in stored.result, false);
  assert.equal("tests" in stored.result, false);
  const confidence = stored.result.confidence as Record<string, unknown>;
  assert.equal("rationale" in confidence, false);
  assert.equal((await promoteResultToTerminal(dir, 1, token)).state, "completed");
});

test("a competing terminal bound to the same result wins without overwrite", async (t) => {
  const dir = await directory(t);
  const result = { status: "failed", workflow: "work", summary: "cancelled", confidence: { level: "high" }, recommendedNextAction: "poll" };
  await publishRecord(dir, "result.json", { kind: "result", generation: 1, token, result, createdAt: "2026-07-12T00:00:00.000Z" });
  const durable = await readRecord(dir, "result.json");
  await publishRecord(dir, "terminal.json", { kind: "terminal", generation: 1, token, state: "cancelled", resultDigest: durable!.digest, createdAt: "2026-07-12T00:00:01.000Z" });
  const winner = await promoteResultToTerminal(dir, 1, token);
  assert.equal(winner.state, "cancelled");
});

test("a result-bound cancellation state wins when poll promotes before its worker", async (t) => {
  const dir = await directory(t);
  const result = { status: "ok", workflow: "work", summary: "late completion", confidence: { level: "high" }, recommendedNextAction: "poll" };
  await publishRecord(dir, "result.json", {
    kind: "result", generation: 1, token, result, terminalState: "cancelled", createdAt: "2026-07-12T00:00:00.000Z",
  });

  const terminal = await promoteResultToTerminal(dir, 1, token);
  assert.equal(terminal.state, "cancelled");
  assert.equal(terminal.resultDigest, (await readRecord(dir, "result.json"))?.digest);
});

test("run-level readers reject digest-valid unknown keys, modes, symlinks, and filename mismatch", async (t) => {
  const dir = await directory(t);
  const body = { version: 1, kind: "terminal", generation: 1, token, state: "completed", resultDigest: "a".repeat(64), createdAt: "2026-07-12T00:00:00.000Z", unexpected: true };
  await writeFile(join(dir, "terminal.json"), JSON.stringify({ ...body, digest: sha256(stableJson(body)) }), { mode: 0o600 });
  await assert.rejects(() => readRecord(dir, "terminal.json"), { code: "RUN_STORE_CORRUPT" });
  await rm(join(dir, "terminal.json"));
  await publishRecord(dir, "terminal.json", { kind: "terminal", generation: 1, token, state: "completed", resultDigest: "a".repeat(64), createdAt: "2026-07-12T00:00:00.000Z" });
  await chmod(join(dir, "terminal.json"), 0o644);
  await assert.rejects(() => readRecord(dir, "terminal.json"), { code: "RUN_STORE_CORRUPT" });
  await chmod(join(dir, "terminal.json"), 0o600);
  const external = join(dir, "external-terminal.json"); await writeFile(external, await readFile(join(dir, "terminal.json")), { mode: 0o600 }); await rm(join(dir, "terminal.json")); await symlink(external, join(dir, "terminal.json"));
  await assert.rejects(() => readRecord(dir, "terminal.json"), { code: "RUN_STORE_CORRUPT" });
  await assert.rejects(() => publishRecord(dir, "terminal.json", { kind: "result", generation: 1, token, result: {}, createdAt: "2026-07-12T00:00:00.000Z" }));
});
