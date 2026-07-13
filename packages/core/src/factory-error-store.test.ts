import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acknowledgeSidecarRuntimeErrors,
  captureSidecarRuntimeError,
  compactSidecarRuntimeErrors,
  inspectSidecarRuntimeErrorStore,
  readSidecarRuntimeErrors,
  reopenSidecarRuntimeError,
  resolveSidecarRuntimeError,
} from "./factory-error-store.js";

async function fixture(enabled: boolean | "malformed" = true) {
  const root = await mkdtemp(join(tmpdir(), "sidecar-factory-errors-"));
  const configPath = join(root, "config.json");
  const storePath = join(root, "state", "errors.json");
  await writeFile(configPath, enabled === "malformed"
    ? "{broken"
    : JSON.stringify({
      schema_version: "1.0",
      host: { id: "test-host", profile: "mac" },
      collection: { enabled },
      reporting: { enabled: false },
    }), { mode: 0o600 });
  return { root, configPath, storePath, productVersion: "1.2.3" };
}

test("collection is fail-closed for missing, malformed, and explicit false config", async () => {
  for (const enabled of [false, "malformed"] as const) {
    const options = await fixture(enabled);
    assert.deepEqual(await captureSidecarRuntimeError("PROTOCOL_ERROR", options), { status: "disabled" });
    assert.equal((await inspectSidecarRuntimeErrorStore(options)).store, "absent");
  }
  const options = await fixture();
  options.configPath = join(options.root, "missing.json");
  assert.deepEqual(await captureSidecarRuntimeError("PROTOCOL_ERROR", options), { status: "disabled" });
});

test("allow-listed codes aggregate with a stable fingerprint and contain no raw values", async () => {
  const options = await fixture();
  const first = await captureSidecarRuntimeError("PROTOCOL_ERROR", options);
  const second = await captureSidecarRuntimeError("PROTOCOL_ERROR", options);
  assert.equal(first.status, "recorded");
  assert.equal(second.fingerprint, first.fingerprint);
  const snapshot = await readSidecarRuntimeErrors(options);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].occurrence_count, 2);
  assert.equal(snapshot.records[0].status, "open");
  assert.equal(snapshot.cursor, 2);
  const bytes = await readFile(options.storePath, "utf8");
  for (const forbidden of ["stderr", "stack", "prompt", "exception", options.root, "secret-value"]) {
    assert.equal(bytes.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(await captureSidecarRuntimeError("secret-value/raw/stack", options), { status: "ignored" });
});

test("resolve, acknowledge, compact, and reopen preserve the cursor contract", async () => {
  const old = new Date("2026-01-01T00:00:00.000Z");
  const options = { ...await fixture(), now: () => old };
  const captured = await captureSidecarRuntimeError("RUN_STORE_CORRUPT", options);
  assert.equal(captured.status, "recorded");
  assert.equal(await resolveSidecarRuntimeError(captured.fingerprint!, options), true);
  let snapshot = await readSidecarRuntimeErrors(options);
  assert.equal(snapshot.records[0].status, "resolved");
  assert.equal(await reopenSidecarRuntimeError(captured.fingerprint!, options), true);
  assert.equal((await readSidecarRuntimeErrors(options)).records[0].status, "open");
  assert.equal(await resolveSidecarRuntimeError(captured.fingerprint!, options), true);
  snapshot = await readSidecarRuntimeErrors(options);
  assert.equal(await compactSidecarRuntimeErrors({ ...options, now: () => new Date("2026-03-01T00:00:00.000Z"), retentionMs: 1 }), 0);
  await acknowledgeSidecarRuntimeErrors(snapshot.cursor, options);
  assert.equal(await compactSidecarRuntimeErrors({ ...options, now: () => new Date("2026-03-01T00:00:00.000Z"), retentionMs: 1 }), 1);
  assert.equal((await readSidecarRuntimeErrors(options)).records.length, 0);
  await captureSidecarRuntimeError("RUN_STORE_CORRUPT", { ...options, now: () => new Date("2026-03-02T00:00:00.000Z") });
  snapshot = await readSidecarRuntimeErrors(options);
  assert.equal(snapshot.records[0].status, "open");
  assert(snapshot.cursor > 2);
});

test("private modes, atomic replacement, and bounded diagnostics", { skip: process.platform === "win32" }, async () => {
  const options = await fixture();
  await captureSidecarRuntimeError("APP_SERVER_TIMEOUT", options);
  assert.equal((await stat(join(options.root, "state"))).mode & 0o777, 0o700);
  assert.equal((await stat(options.storePath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(options.root, "state"))).sort(), ["errors.json", "errors.json.lock.sqlite"]);
  assert.deepEqual(await inspectSidecarRuntimeErrorStore(options), {
    schemaVersion: "1",
    collection: "enabled",
    store: "ready",
    pending: 1,
  });
});

test("parallel captures retain every occurrence", async () => {
  const options = await fixture();
  await Promise.all(Array.from({ length: 12 }, () => captureSidecarRuntimeError("APP_SERVER_TIMEOUT", options)));
  const snapshot = await readSidecarRuntimeErrors(options);
  assert.equal(snapshot.records[0].occurrence_count, 12);
  assert.equal(snapshot.cursor, 12);
});

test("public fixed-time captures still use the bounded isolated queue", async () => {
  const options = { ...await fixture(), now: () => new Date("2026-07-13T00:00:00.000Z") };
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    captureSidecarRuntimeError("APP_SERVER_TIMEOUT", options)));
  assert.equal(results.every((result) => result.status === "recorded"), true);
  const snapshot = await readSidecarRuntimeErrors(options);
  assert.equal(snapshot.records[0].occurrence_count, 12);
});

test("non-canonical reporting fields keep collection fail-closed", async () => {
  const options = await fixture();
  await writeFile(options.configPath, JSON.stringify({
    schema_version: "1.0",
    host: { id: "test-host", profile: "mac" },
    collection: { enabled: true },
    reporting: { enabled: true, endpoint: "ftp://not-canonical", credential_file: "" },
  }));
  assert.deepEqual(await captureSidecarRuntimeError("PROTOCOL_ERROR", options), { status: "disabled" });
});

test("tampered record fields and cursors are rejected before projection or compaction", async () => {
  const options = await fixture();
  await captureSidecarRuntimeError("PROTOCOL_ERROR", options);
  const store = JSON.parse(await readFile(options.storePath, "utf8"));
  store.records[0].message_template = `raw exception ${options.root}`;
  await writeFile(options.storePath, JSON.stringify(store), { mode: 0o600 });
  await assert.rejects(() => readSidecarRuntimeErrors(options), /invalid factory error record/);
  store.records[0].message_template = "Codex App Server protocol contract failed";
  store.acknowledged_through = 999;
  await writeFile(options.storePath, JSON.stringify(store), { mode: 0o600 });
  await assert.rejects(() => compactSidecarRuntimeErrors({ ...options, retentionMs: 0 }), /invalid factory error store/);
  store.acknowledged_through = 0;
  store.secret = `${options.root} Bearer secret-token`;
  await writeFile(options.storePath, JSON.stringify(store), { mode: 0o600 });
  await assert.rejects(() => readSidecarRuntimeErrors(options), /invalid factory error store/);
});

test("opaque durable observation ids make retries idempotent", async () => {
  const options = { ...await fixture(), now: () => new Date("2026-07-13T00:00:00.000Z"), observationId: "b".repeat(64) };
  assert.equal((await captureSidecarRuntimeError("RUN_INTERNAL_ERROR", options)).status, "recorded");
  assert.equal((await captureSidecarRuntimeError("RUN_INTERNAL_ERROR", options)).status, "recorded");
  let snapshot = await readSidecarRuntimeErrors(options);
  assert.equal(snapshot.records[0].occurrence_count, 1);
  await captureSidecarRuntimeError("RUN_INTERNAL_ERROR", { ...options, observationId: "c".repeat(64) });
  snapshot = await readSidecarRuntimeErrors(options);
  assert.equal(snapshot.records[0].occurrence_count, 2);
});

test("durable observation ledger is bounded and overflow leaves the store readable", async () => {
  const options = { ...await fixture(), now: () => new Date("2026-07-13T00:00:00.000Z"), observationId: "d".repeat(64) };
  await captureSidecarRuntimeError("RUN_INTERNAL_ERROR", options);
  const store = JSON.parse(await readFile(options.storePath, "utf8"));
  const fingerprint = store.records[0].fingerprint;
  store.observations = Array.from({ length: 1_024 }, (_, index) => ({
    id: createHash("sha256").update(`observation-${index}`).digest("hex"), fingerprint, sequence: 1,
    transient: false, created_at: "2026-07-13T00:00:00.000Z",
  }));
  await writeFile(options.storePath, JSON.stringify(store), { mode: 0o600 });
  const overflow = await captureSidecarRuntimeError("RUN_INTERNAL_ERROR", { ...options, observationId: "e".repeat(64) });
  assert.equal(overflow.status, "failed");
  assert.equal((await readSidecarRuntimeErrors(options)).records[0].occurrence_count, 1);
});

test("FIFO config is rejected without waiting for a writer", { skip: process.platform === "win32" }, async () => {
  const options = await fixture();
  const fifo = join(options.root, "config-fifo");
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => execFile("mkfifo", [fifo], (error) => error ? reject(error) : resolve()));
  options.configPath = fifo;
  const result = await Promise.race([
    captureSidecarRuntimeError("PROTOCOL_ERROR", options),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("capture blocked")), 300)),
  ]);
  assert.deepEqual(result, { status: "disabled" });
});

test("permission drift is unverified and an OS-released SQLite mutex survives owner crash", { skip: process.platform === "win32" }, async () => {
  const options = await fixture();
  await captureSidecarRuntimeError("APP_SERVER_TIMEOUT", options);
  await chmod(options.storePath, 0o644);
  assert.equal((await inspectSidecarRuntimeErrorStore(options)).store, "unverified");
  await chmod(options.storePath, 0o600);
  const lockPath = `${options.storePath}.lock.sqlite`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", [
    "import { DatabaseSync } from 'node:sqlite'",
    `const db = new DatabaseSync(${JSON.stringify(lockPath)})`,
    "db.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE')",
    "console.log('READY')",
    "setInterval(() => {}, 1000)",
  ].join(";")], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => String(chunk).includes("READY") ? resolve() : reject(new Error("lock child did not become ready")));
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal((await captureSidecarRuntimeError("APP_SERVER_TIMEOUT", options)).status, "recorded");
});

test("oversized product versions fail before replacement and leave the store readable", async () => {
  const options = await fixture();
  await captureSidecarRuntimeError("PROTOCOL_ERROR", options);
  const before = await readFile(options.storePath, "utf8");
  const result = await captureSidecarRuntimeError("APP_SERVER_TIMEOUT", {
    ...options,
    productVersion: `1.2.3-${"a".repeat(1024 * 1024)}`,
  });
  assert.deepEqual(result, { status: "failed" });
  assert.equal(await readFile(options.storePath, "utf8"), before);
  assert.equal((await readSidecarRuntimeErrors(options)).records.length, 1);
});
