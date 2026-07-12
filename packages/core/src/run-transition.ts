import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { currentProcessIdentity, matchesProcessIdentity, type ProcessIdentity } from "./process-identity.js";
import { RunStoreError, sha256, stableJson } from "./run-foundation.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** @internal test seam */
export const __runTransitionTestHooks: { beforeReleaseUnlink?: () => Promise<void> } = {};

export interface RunTransitionClaim {
  version: 1;
  kind: "run-transition-claim";
  token: string;
  owner: ProcessIdentity;
  runDirectory: string;
  createdAt: string;
  digest: string;
}

export interface RunTransitionLease {
  directory: string;
  currentPath: string;
  claimPath: string;
  claim: RunTransitionClaim;
}

export type RunTransitionInspection =
  | { state: "available" }
  | { state: "held"; claim: RunTransitionClaim; ownerRunning: boolean };

export async function claimRunTransition(runDirectory: string): Promise<RunTransitionLease> {
  unsupported();
  const canonicalRun = await canonicalDirectory(runDirectory);
  const directory = join(canonicalRun, "transition");
  const claims = join(directory, "claims");
  await ensureDirectory(directory);
  await ensureDirectory(claims);
  await ensureDirectory(join(directory, "releases"));
  const token = randomBytes(32).toString("base64url");
  const body = { version: 1 as const, kind: "run-transition-claim" as const, token, owner: await currentProcessIdentity(), runDirectory: canonicalRun, createdAt: new Date().toISOString() };
  const claim: RunTransitionClaim = { ...body, digest: sha256(stableJson(body)) };
  const claimPath = join(claims, `${token}.json`);
  const currentPath = join(directory, "current.json");
  await writePrivate(claimPath, claim);
  try { await link(claimPath, currentPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain("cannot publish run transition claim", error);
    try { await readCurrent(canonicalRun); }
    catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
    } finally { await rm(claimPath, { force: true }); }
    throw new RunStoreError("RUN_ORPHANED", "run transition is already held");
  }
  const current = await readCurrent(canonicalRun);
  if (stableJson(current.claim) !== stableJson(claim)) throw new RunStoreError("RUN_STORE_CORRUPT", "published run transition claim changed");
  return current;
}

export async function inspectRunTransition(runDirectory: string): Promise<RunTransitionInspection> {
  unsupported();
  const canonicalRun = await canonicalDirectory(runDirectory);
  try {
    const lease = await readCurrent(canonicalRun);
    return { state: "held", claim: lease.claim, ownerRunning: await matchesProcessIdentity(lease.claim.owner) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "available" };
    throw error;
  }
}

export async function releaseRunTransition(lease: RunTransitionLease): Promise<void> {
  unsupported();
  const currentIdentity = await currentProcessIdentity();
  if (lease.claim.owner.pid !== currentIdentity.pid || lease.claim.owner.startIdentity !== currentIdentity.startIdentity) throw new RunStoreError("RUN_ORPHANED", "only the transition owner may release it");
  const canonicalRun = await canonicalDirectory(lease.claim.runDirectory);
  await publishReleaseWinner(lease);
  try {
    const current = await readCurrent(canonicalRun);
    if (stableJson(current.claim) !== stableJson(lease.claim) || current.claimPath !== lease.claimPath || current.currentPath !== lease.currentPath) throw new RunStoreError("RUN_STORE_CORRUPT", "run transition owner changed");
    const [a, b] = await Promise.all([lstat(current.currentPath, { bigint: true }), lstat(current.claimPath, { bigint: true })]);
    if (a.dev !== b.dev || a.ino !== b.ino) throw new RunStoreError("RUN_STORE_CORRUPT", "run transition inode changed");
    await __runTransitionTestHooks.beforeReleaseUnlink?.();
    await rm(current.currentPath);
  } catch (error) { throw error; }
}

export async function withRunTransition<T>(runDirectory: string, action: (lease: RunTransitionLease) => Promise<T>): Promise<T> {
  let lease: RunTransitionLease | undefined;
  for (let attempt = 0; attempt < 200 && !lease; attempt += 1) {
    try { lease = await claimRunTransition(runDirectory); }
    catch (error) {
      if ((error as { code?: string }).code !== "RUN_ORPHANED") throw error;
      const inspection = await inspectRunTransition(runDirectory);
      if (inspection.state === "available") continue;
      if (!inspection.ownerRunning) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (!lease) throw new RunStoreError("RUN_ORPHANED", "timed out waiting for run transition");
  try { return await action(lease); }
  finally { await releaseRunTransition(lease); }
}

async function readCurrent(canonicalRun: string): Promise<RunTransitionLease> {
  const directory = join(canonicalRun, "transition");
  const currentPath = join(directory, "current.json");
  const claim = await readPrivate(currentPath);
  const claimPath = join(directory, "claims", `${claim.token}.json`);
  const immutable = await readPrivate(claimPath);
  const [a, b] = await Promise.all([lstat(currentPath, { bigint: true }), lstat(claimPath, { bigint: true })]);
  if (a.dev !== b.dev || a.ino !== b.ino || stableJson(claim) !== stableJson(immutable) || claim.runDirectory !== canonicalRun) throw new RunStoreError("RUN_STORE_CORRUPT", "run transition current is not its immutable claim");
  return { directory, currentPath, claimPath, claim };
}

async function writePrivate(path: string, value: object): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.chmod(FILE_MODE); await handle.sync(); }
  finally { await handle.close(); }
}

async function publishReleaseWinner(lease: RunTransitionLease): Promise<void> {
  const directory = join(lease.directory, "releases"); await ensureDirectory(directory);
  const releaseToken = randomBytes(32).toString("base64url");
  const body = { version: 1 as const, kind: "run-transition-release" as const, leaseToken: lease.claim.token, releaseToken, owner: lease.claim.owner, createdAt: new Date().toISOString() };
  const record = { ...body, digest: sha256(stableJson(body)) };
  const temp = join(directory, `.tmp-${releaseToken}`); const finalPath = join(directory, `${lease.claim.token}.json`);
  await writePrivate(temp, record);
  try { await link(temp, finalPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RunStoreError("RUN_ORPHANED", "run transition release already has a winner");
    throw error;
  } finally { await rm(temp, { force: true }); }
}

async function readPrivate(path: string): Promise<RunTransitionClaim> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== FILE_MODE) throw new Error("unsafe transition file");
      const value: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      assertClaim(value);
      return value;
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw uncertain("cannot read run transition claim", error);
  }
}

function assertClaim(value: unknown): asserts value is RunTransitionClaim {
  if (!object(value) || !sameKeys(value, ["version", "kind", "token", "owner", "runDirectory", "createdAt", "digest"]) || value.version !== 1 || value.kind !== "run-transition-claim" || !TOKEN.test(String(value.token)) || typeof value.runDirectory !== "string" || resolve(value.runDirectory) !== value.runDirectory || !date(value.createdAt) || typeof value.digest !== "string" || !object(value.owner) || !Number.isInteger(value.owner.pid) || value.owner.pid <= 0 || typeof value.owner.startIdentity !== "string" || !value.owner.startIdentity) throw new RunStoreError("RUN_STORE_CORRUPT", "invalid run transition claim");
  const { digest, ...body } = value;
  if (digest !== sha256(stableJson(body))) throw new RunStoreError("RUN_STORE_CORRUPT", "run transition digest mismatch");
}

async function canonicalDirectory(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) { throw new RunStoreError("RUN_INVALID_INPUT", `cannot canonicalize run directory: ${error instanceof Error ? error.message : String(error)}`); }
}

async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: DIR_MODE }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== DIR_MODE) throw new RunStoreError("RUN_STORE_CORRUPT", `unsafe transition directory: ${path}`);
}

function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sameKeys(value: Record<string, unknown>, keys: string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function uncertain(message: string, cause: unknown): RunStoreError { return new RunStoreError("RUN_STORE_CORRUPT", `${message}: ${cause instanceof Error ? cause.message : String(cause)}`); }
function unsupported(): void { if (process.platform === "win32") throw new RunStoreError("RUN_UNSUPPORTED_PLATFORM", "run transitions require POSIX hard links"); }
