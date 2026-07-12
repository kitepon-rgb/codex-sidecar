import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sha256, stableJson, RunStoreError } from "./run-foundation.js";
import type { ProcessIdentity } from "./process-identity.js";
import type { LaunchClaim } from "./run-types.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface RecordEnvelope {
  version: 1;
  kind: "claim" | "heartbeat" | "spawn" | "boot" | "ready" | "failure";
  generation: number;
  token: string;
  digest: string;
  [key: string]: unknown;
}

export interface Heartbeat extends RecordEnvelope {
  kind: "heartbeat";
  owner: { pid: number; startIdentity: string };
  updatedAt: string;
}

export interface SpawnRecord extends RecordEnvelope {
  kind: "spawn";
  pid: number;
  pgid: number;
  processIdentity: ProcessIdentity;
  createdAt: string;
}

export interface AttemptMarker extends RecordEnvelope {
  kind: "boot" | "ready";
  pid: number;
  pgid: number;
  processIdentity: ProcessIdentity;
  createdAt: string;
}

export interface FailureRecord extends RecordEnvelope {
  kind: "failure";
  pid: number;
  pgid: number;
  processIdentity: ProcessIdentity;
  reason: "early-exit" | "ready-timeout" | "ready-invalid" | "spawn-publish-failed";
  createdAt: string;
}

export async function ensureRecordDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertDirectory(path);
}

export async function attemptDirectory(runDirectory: string, generation: number, token: string): Promise<string> {
  assertAttemptIdentity(generation, token);
  await assertDirectory(runDirectory);
  const attempts = join(runDirectory, "attempts");
  await ensureRecordDirectory(attempts);
  const path = join(attempts, `${generation}-${token}`);
  await ensureRecordDirectory(path);
  return path;
}

/** Atomically publishes an immutable JSON record without replacing a winner. */
export async function publishRecord(directory: string, name: string, body: object): Promise<void> {
  await assertDirectory(directory);
  const expectedKind = recordKindForName(name);
  const { version: _version, digest: _digest, ...recordBody } = body as Record<string, unknown>;
  const record = { version: 1 as const, ...recordBody };
  assertRecordSchema(record, expectedKind);
  const payload = { ...record, digest: sha256(stableJson(record)) };
  const finalPath = join(directory, name);
  const temporaryPath = join(directory, `.tmp-${randomBytes(18).toString("base64url")}`);
  await writePrivateFile(temporaryPath, `${JSON.stringify(payload)}\n`);
  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readRecord(directory, name);
    if (!existing || stableJson(existing) !== stableJson(payload)) {
      throw new RunStoreError("RUN_STORE_CORRUPT", `record conflict: ${name}`);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function readRecord(directory: string, name: string): Promise<RecordEnvelope | undefined> {
  await assertDirectory(directory);
  const expectedKind = recordKindForName(name);
  const path = join(directory, name);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const file = await handle.stat();
      if (!file.isFile() || (file.mode & 0o777) !== FILE_MODE) throw new Error("unsafe record file");
      const value: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      assertRecordSchema(value, expectedKind);
      const record = value as RecordEnvelope;
      const { digest, ...body } = record;
      if (digest !== sha256(stableJson(body))) throw new Error("record digest mismatch");
      return record;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw corrupt(`cannot read record ${name}`, error);
  }
}

export async function readClaim(lockDirectory: string): Promise<LaunchClaim> {
  const value = await readRecord(lockDirectory, "claim.json");
  if (!value || value.kind !== "claim") throw new RunStoreError("RUN_STORE_CORRUPT", "launch claim is missing");
  return value as unknown as LaunchClaim;
}

export async function readHeartbeat(lockDirectory: string, claim: LaunchClaim): Promise<Heartbeat> {
  const current = await readClaim(lockDirectory);
  if (stableJson(current) !== stableJson(claim)) throw new RunStoreError("RUN_STORE_CORRUPT", "claim is no longer current");
  const value = await readRecord(lockDirectory, "heartbeat.json");
  if (!value || value.kind !== "heartbeat" || value.token !== current.token || value.generation !== current.generation || stableJson(value.owner) !== stableJson(current.owner)) {
    throw new RunStoreError("RUN_STORE_CORRUPT", "heartbeat does not belong to the current claim");
  }
  return value as Heartbeat;
}

/** Replaces only the heartbeat belonging to the durable current launch claim. */
export async function replaceHeartbeat(lockDirectory: string, claim: LaunchClaim, heartbeat: Omit<Heartbeat, "version" | "digest">): Promise<void> {
  await assertDirectory(lockDirectory);
  const current = await readClaim(lockDirectory);
  if (stableJson(current) !== stableJson(claim) || heartbeat.kind !== "heartbeat" || heartbeat.token !== current.token || heartbeat.generation !== current.generation || stableJson(heartbeat.owner) !== stableJson(current.owner)) {
    throw new RunStoreError("RUN_STORE_CORRUPT", "heartbeat owner mismatch");
  }
  const body = { version: 1 as const, ...heartbeat };
  assertRecordSchema(body);
  const payload = { ...body, digest: sha256(stableJson(body)) };
  const temporaryPath = join(lockDirectory, `.heartbeat-${randomBytes(18).toString("base64url")}`);
  await writePrivateFile(temporaryPath, `${JSON.stringify(payload)}\n`);
  try {
    await rename(temporaryPath, join(lockDirectory, "heartbeat.json"));
  } finally {
    await rm(temporaryPath, { force: true });
  }
  await readHeartbeat(lockDirectory, current);
}

export function assertEnvelope(value: unknown): asserts value is RecordEnvelope {
  assertRecordSchema(value);
}

function assertRecordSchema(value: unknown, expectedKind?: RecordEnvelope["kind"]): asserts value is RecordEnvelope {
  if (!isObject(value)) throw new Error("record must be an object");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.kind !== "string" || !Number.isInteger(record.generation) || (record.generation as number) < 1 || typeof record.token !== "string" || !TOKEN.test(record.token) || typeof record.digest !== "undefined" && typeof record.digest !== "string") {
    throw new Error("invalid record envelope");
  }
  const keys = schemaKeys(record.kind);
  const expectedKeys = record.digest === undefined ? keys?.filter((key) => key !== "digest") : keys;
  if (expectedKeys && !sameKeys(record, expectedKeys)) throw new Error(`invalid ${record.kind} record keys`);
  if (expectedKind && record.kind !== expectedKind) throw new Error(`record kind must be ${expectedKind}`);
  if ("owner" in record && !isProcessIdentity(record.owner)) throw new Error("invalid record owner");
  if ("processIdentity" in record && !isProcessIdentity(record.processIdentity)) throw new Error("invalid record process identity");
  if (record.kind === "spawn" || record.kind === "boot" || record.kind === "ready" || record.kind === "failure") {
    if (!isPositiveInteger(record.pid) || !isPositiveInteger(record.pgid)) throw new Error("invalid child process identifiers");
  }
  if (record.kind === "failure" && record.reason !== "early-exit" && record.reason !== "ready-timeout" && record.reason !== "ready-invalid" && record.reason !== "spawn-publish-failed") throw new Error("invalid failure reason");
  for (const timestamp of ["createdAt", "updatedAt"]) {
    if (timestamp in record && !isIsoTimestamp(record[timestamp])) throw new Error(`invalid ${timestamp}`);
  }
}

function schemaKeys(kind: string): readonly string[] {
  const base = ["version", "kind", "generation", "token", "digest"];
  switch (kind) {
    case "claim": return [...base, "owner", "createdAt"];
    case "heartbeat": return [...base, "owner", "updatedAt"];
    case "spawn":
    case "boot":
    case "ready": return [...base, "pid", "pgid", "processIdentity", "createdAt"];
    case "failure": return [...base, "pid", "pgid", "processIdentity", "reason", "createdAt"];
    default: throw new Error(`unsupported record kind: ${kind}`);
  }
}

function assertAttemptIdentity(generation: number, token: string): void {
  if (!Number.isInteger(generation) || generation < 1 || !TOKEN.test(token)) {
    throw new RunStoreError("RUN_INVALID_INPUT", "invalid attempt identity");
  }
}

function recordKindForName(name: string): RecordEnvelope["kind"] {
  switch (name) {
    case "claim.json": return "claim";
    case "heartbeat.json": return "heartbeat";
    case "spawn.json": return "spawn";
    case "boot.json": return "boot";
    case "ready.json": return "ready";
    case "failure.json": return "failure";
    default: throw new RunStoreError("RUN_INVALID_INPUT", `unsupported record name: ${name}`);
  }
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE);
  try {
    await handle.writeFile(value, { encoding: "utf8" });
    await handle.chmod(FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertDirectory(path: string): Promise<void> {
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== DIRECTORY_MODE) {
    throw new RunStoreError("RUN_STORE_CORRUPT", `unsafe record directory: ${path}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProcessIdentity(value: unknown): boolean {
  return isObject(value) && sameKeys(value, ["pid", "startIdentity"]) && Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.startIdentity === "string" && value.startIdentity.length > 0;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0;
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function corrupt(message: string, error: unknown): RunStoreError {
  return new RunStoreError("RUN_STORE_CORRUPT", `${message}: ${error instanceof Error ? error.message : String(error)}`);
}
