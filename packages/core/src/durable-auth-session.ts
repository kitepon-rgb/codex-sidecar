import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { claimAuthLease, inspectHeldAuthLease, recoverHeldAuthLeaseWithJournalAction, releaseAuthLease, writeAuthLeaseMarker, type AuthLease, type AuthRecoveryStrategy } from "./auth-lease.js";
import { currentProcessIdentity } from "./process-identity.js";
import { RunStoreError } from "./run-foundation.js";
import { sha256, stableJson } from "./run-foundation.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;

type AuthObservation =
  | { state: "absent"; hash: "absent" }
  | { state: "present"; hash: string; dev: string; ino: string; size: string; mtimeNs: string };

/** Hash-only auth observation safe to expose from operator inspection. */
export interface DurableAuthFileInspection {
  state: "absent" | "present";
  hash: string;
}

export interface DurableAuthRecoveryInput {
  home: string;
  cacheRoot: string;
  strategy: AuthRecoveryStrategy;
  confirmNoRunningProcesses: boolean;
}

/** Immutable recovery target copied from a read-only inspection. */
export interface DurableAuthRecoveryTarget {
  ownerKind: string;
  ownerId: string;
  journalPath: string;
  canonicalAuthPath: string;
  token: string;
}

export interface HeldDurableAuthRecoveryInspection extends DurableAuthRecoveryTarget {
  state: "held";
  appServerStarted: boolean;
  snapshotPresent: boolean;
  rotationPresent: boolean;
  canonicalAuth: DurableAuthFileInspection;
  initialCanonicalAuth?: DurableAuthFileInspection;
  initialRunLocalAuth?: DurableAuthFileInspection;
  currentRunLocalAuth?: DurableAuthFileInspection;
  rotatedRunLocalAuth?: DurableAuthFileInspection;
  candidates: readonly AuthRecoveryStrategy[];
}

export type DurableAuthRecoveryInspection =
  | { state: "available" }
  | HeldDurableAuthRecoveryInspection;

/** @internal fault-injection seam. */
export const __durableAuthTestHooks: {
  afterLeaseClaimBeforeLeaseAcquired?: () => Promise<void>;
  afterLeaseAcquiredBeforeSnapshot?: () => Promise<void>;
  afterSnapshotBeforeAppServerStarted?: () => Promise<void>;
  beforeBoundWriteBack?: () => Promise<void>;
  beforeAtomicWriteBack?: () => Promise<void>;
} = {};

export interface DurableAuthSessionOptions {
  baseEnv?: NodeJS.ProcessEnv;
  cacheRoot?: string;
  sessionRoot?: string;
  /** Exact durable journal location; async work uses `<run>/auth`. */
  journalPath?: string;
  /** Exact run-local CODEX_HOME; async work uses `<run>/codex-home`. */
  codexHomePath?: string;
  ownerKind: "sync-session" | "work-run";
  ownerId?: string;
}

/** Read-only/current-user locator options for `auth-status` and `auth-recover`. */
export interface CurrentDurableAuthOptions {
  baseEnv?: NodeJS.ProcessEnv;
  cacheRoot?: string;
}

/** Explicit sync-session recovery input for the public `auth-recover` command. */
export interface SyncDurableAuthRecoveryInput extends CurrentDurableAuthOptions {
  sessionId: string;
  strategy: AuthRecoveryStrategy;
  confirmNoRunningProcesses: boolean;
}

/** Internal shared input for a recovery already bound to an inspection target. */
export interface CurrentDurableAuthRecoveryForTargetInput extends CurrentDurableAuthOptions {
  strategy: AuthRecoveryStrategy;
  confirmNoRunningProcesses: boolean;
}

export interface DurableAuthSession {
  id: string;
  root: string;
  codexHome: string;
  journalPath: string;
  env: NodeJS.ProcessEnv;
  lease: AuthLease;
  markAppServerStarted(): Promise<void>;
  /**
   * Records the first valid atomic run-local auth replacement while the
   * session still owns the App Server. A crash before this evidence exists is
   * intentionally not recoverable by write-back.
   */
  recordRunLocalRotation(): Promise<void>;
  closeClean(): Promise<void>;
}

export async function createDurableAuthSession(options: DurableAuthSessionOptions): Promise<DurableAuthSession> {
  const baseEnv = options.baseEnv ?? process.env;
  const sourceHome = await realpath(baseEnv.CODEX_HOME ?? join(homedir(), ".codex"));
  const cacheRoot = await ensureCacheRoot(options.cacheRoot ?? defaultCacheRoot(baseEnv));
  const id = options.ownerId ?? randomBytes(18).toString("base64url");
  if (!OWNER_ID.test(id)) throw new RunStoreError("RUN_INVALID_INPUT", "durable auth ownerId is unsafe");
  const root = options.sessionRoot ?? join(cacheRoot, "codex-sidecar", "auth-sessions", id);
  if (!isAbsolute(root) || resolve(root) !== root) throw new RunStoreError("RUN_INVALID_INPUT", "durable auth sessionRoot must be canonical and absolute");
  await ensureDirectory(join(cacheRoot, "codex-sidecar")); await ensureDirectory(join(cacheRoot, "codex-sidecar", "auth-sessions")); await ensureDirectory(root);
  if (await realpath(root) !== root) throw new RunStoreError("RUN_STORE_CORRUPT", "durable auth sessionRoot is not canonical");
  const journalPath = options.journalPath ?? join(root, "journal"); const codexHome = options.codexHomePath ?? join(root, "codex-home");
  assertChildDirectory(root, journalPath, "journalPath"); assertChildDirectory(root, codexHome, "codexHomePath");
  await ensureDirectory(journalPath); await ensureDirectory(codexHome);
  const owner = { kind: options.ownerKind, id, journalPath, processIdentity: await currentProcessIdentity() };
  const lease = await claimAuthLease({ home: sourceHome, cacheRoot, owner });
  try {
    await __durableAuthTestHooks.afterLeaseClaimBeforeLeaseAcquired?.();
    await writeEvidence(join(journalPath, "lease-acquired.json"), { version: 1, kind: "auth-lease-acquired", token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, createdAt: new Date().toISOString() });
    await __durableAuthTestHooks.afterLeaseAcquiredBeforeSnapshot?.();
    const initial = await observeStableAuth(lease.canonicalAuthPath);
    await copyOptional(join(sourceHome, "auth.json"), join(codexHome, "auth.json"));
    await copyOptional(join(sourceHome, "installation_id"), join(codexHome, "installation_id"));
    await writePrivate(join(codexHome, "config.toml"), minimalConfig(await readOptional(join(sourceHome, "config.toml"))));
    const localInitial = await observeStableAuth(join(codexHome, "auth.json"));
    if (localInitial.hash !== initial.hash) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "canonical auth changed while the durable snapshot was copied");
    await writeEvidence(join(journalPath, "snapshot.json"), { version: 1, kind: "auth-snapshot", token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, canonicalInitial: initial, runLocalInitial: localInitial, createdAt: new Date().toISOString() });
    await __durableAuthTestHooks.afterSnapshotBeforeAppServerStarted?.();
    let started = false; let closed = false;
    const recordRunLocalRotation = async (): Promise<void> => {
      if (!started) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "run-local auth rotation cannot be observed before App Server start");
      await observeAndRecordRunLocalRotation({ lease, journalPath, codexHome, initial, localInitial });
    };
    return {
      id, root, codexHome, journalPath, lease, env: { ...baseEnv, CODEX_HOME: codexHome },
      async markAppServerStarted() { if (!started) { await writeAuthLeaseMarker(lease, "app-server-started"); started = true; } },
      recordRunLocalRotation,
      async closeClean() {
        if (closed) return;
        if (!started) { await releaseAuthLease(lease); closed = true; return; }
        if (started) await writeAuthLeaseMarker(lease, "app-server-exited");
        const final = await observeStableAuth(join(codexHome, "auth.json"));
        let canonical = await observeStableAuth(lease.canonicalAuthPath);
        if (final.hash !== initial.hash) {
          await recordRunLocalRotation();
          const snapshot = await readSnapshot(join(journalPath, "snapshot.json"), lease);
          const rotation = await readRotation(join(journalPath, "run-local-rotation.json"), lease, snapshot);
          if (canonical.hash !== initial.hash && canonical.hash !== final.hash) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "canonical auth changed outside the durable session");
          if (canonical.hash === initial.hash) { await __durableAuthTestHooks.beforeBoundWriteBack?.(); const bytes = await readBoundAuth(join(codexHome, "auth.json"), rotation.final); await atomicWriteBack(bytes, lease.canonicalAuthPath, id, canonical); canonical = await observeStableAuth(lease.canonicalAuthPath); }
        }
        if (canonical.hash !== final.hash) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth final hash does not match canonical auth");
        await writeAuthLeaseMarker(lease, "auth-written-back", { initialAuthHash: initial.hash, finalAuthHash: final.hash, canonicalAuthHash: canonical.hash });
        await writeAuthLeaseMarker(lease, "clean-shutdown");
        await releaseAuthLease(lease); closed = true;
      },
    };
  } catch (error) {
    // Before the App Server start boundary the exact never-started lease can be
    // released by its live owner; after returning, failures remain durable.
    try { await releaseAuthLease(lease); } catch (releaseError) { Object.assign(error as object, { releaseError }); }
    throw error;
  }
}

async function observeAndRecordRunLocalRotation(input: {
  lease: AuthLease;
  journalPath: string;
  codexHome: string;
  initial: AuthObservation;
  localInitial: AuthObservation;
}): Promise<void> {
  const final = await observeStableAuth(join(input.codexHome, "auth.json"));
  if (final.hash === input.initial.hash) return;
  if (final.state !== "present") throw new RunStoreError("RUN_AUTH_UNCERTAIN", "rotated run-local auth is absent");
  if (input.localInitial.state === "present" && final.dev === input.localInitial.dev && final.ino === input.localInitial.ino) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "in-place auth rewrite is not valid rotation evidence");
  await writeEvidence(join(input.journalPath, "run-local-rotation.json"), {
    version: 1,
    kind: "auth-run-local-rotation",
    token: input.lease.token,
    canonicalAuthPath: input.lease.canonicalAuthPath,
    canonicalInitial: input.initial,
    runLocalInitial: input.localInitial,
    final,
    createdAt: new Date().toISOString(),
  });
}

/** Read-only status for a held canonical auth lease; it never releases or rewrites auth. */
export async function inspectDurableAuthRecovery(input: Pick<DurableAuthRecoveryInput, "home" | "cacheRoot">): Promise<DurableAuthRecoveryInspection> {
  const inspection = await inspectHeldAuthLease(input);
  if (inspection.state === "available" || !inspection.claim) return { state: "available" };
  const lease = inspection.claim; await assertDirectory(lease.owner.journalPath);
  const names = new Set(await readdirSafe(lease.owner.journalPath));
  const started = names.has("app-server-started.json"); const snapshot = names.has("snapshot.json"); const rotation = names.has("run-local-rotation.json");
  const canonicalAuth = publicAuthObservation(await observeStableAuth(lease.canonicalAuthPath));
  let initialCanonicalAuth: DurableAuthFileInspection | undefined;
  let initialRunLocalAuth: DurableAuthFileInspection | undefined;
  let currentRunLocalAuth: DurableAuthFileInspection | undefined;
  let rotatedRunLocalAuth: DurableAuthFileInspection | undefined;
  if (snapshot) {
    const snapshotEvidence = await readSnapshot(join(lease.owner.journalPath, "snapshot.json"), lease);
    initialCanonicalAuth = publicAuthObservation(snapshotEvidence.canonicalInitial);
    initialRunLocalAuth = publicAuthObservation(snapshotEvidence.runLocalInitial);
    currentRunLocalAuth = publicAuthObservation(await observeStableAuth(join(dirname(lease.owner.journalPath), "codex-home", "auth.json")));
    if (rotation) {
      const rotationEvidence = await readRotation(join(lease.owner.journalPath, "run-local-rotation.json"), lease, snapshotEvidence);
      rotatedRunLocalAuth = publicAuthObservation(rotationEvidence.final);
    }
  } else if (rotation) {
    throw new RunStoreError("RUN_AUTH_UNCERTAIN", "run-local rotation exists without a durable snapshot");
  }
  const candidates: AuthRecoveryStrategy[] = [];
  if (!started) candidates.push("release-never-started");
  if (started && snapshot && rotation) candidates.push("write-back-run-local");
  if (started && snapshot) candidates.push("keep-canonical-after-login");
  if (names.has("app-server-exited.json") && names.has("auth-written-back.json") && names.has("clean-shutdown.json")) candidates.push("release-clean");
  return { state: "held", ownerKind: lease.owner.kind, ownerId: lease.owner.id, journalPath: lease.owner.journalPath, canonicalAuthPath: lease.canonicalAuthPath, token: lease.token, appServerStarted: started, snapshotPresent: snapshot, rotationPresent: rotation, canonicalAuth, initialCanonicalAuth, initialRunLocalAuth, currentRunLocalAuth, rotatedRunLocalAuth, candidates };
}

/**
 * Read-only status for the current user's canonical CODEX_HOME. A missing
 * cache root means no sidecar lease could have been created, and is reported
 * as available without creating anything.
 */
export async function inspectCurrentDurableAuthRecovery(options: CurrentDurableAuthOptions = {}): Promise<DurableAuthRecoveryInspection> {
  const locator = await resolveCurrentDurableAuthLocator(options);
  if (!locator) return { state: "available" };
  return inspectDurableAuthRecovery(locator);
}

/** Recovers exactly one named durable sync session; it never targets a later lease. */
export async function recoverSyncDurableAuthSession(input: SyncDurableAuthRecoveryInput): Promise<void> {
  if (!OWNER_ID.test(input.sessionId)) throw new RunStoreError("RUN_INVALID_INPUT", "durable auth sessionId is unsafe");
  const locator = await resolveCurrentDurableAuthLocator(input);
  if (!locator) throw new RunStoreError("RUN_NOT_FOUND", "durable auth session is not held");
  const inspection = await inspectDurableAuthRecovery(locator);
  if (inspection.state !== "held" || inspection.ownerKind !== "sync-session" || inspection.ownerId !== input.sessionId) {
    throw new RunStoreError("RUN_NOT_FOUND", "durable auth session is not the current lease owner");
  }
  await recoverCurrentDurableAuthSessionForTarget(input, recoveryTargetFromInspection(inspection));
}

/** @internal Shared exact-target recovery for sync and work operator adapters. */
export async function recoverCurrentDurableAuthSessionForTarget(
  input: CurrentDurableAuthRecoveryForTargetInput,
  target: DurableAuthRecoveryTarget,
): Promise<void> {
  const locator = await resolveCurrentDurableAuthLocator(input);
  if (!locator) throw new RunStoreError("RUN_NOT_FOUND", "durable auth session is not held");
  await recoverDurableAuthSessionForTarget({ ...locator, strategy: input.strategy, confirmNoRunningProcesses: input.confirmNoRunningProcesses }, target);
}

/**
 * Recovers only the exact inspected lease. A target mismatch is fail-closed,
 * so a stale operator command cannot act on a later owner of the same auth
 * path.
 */
export async function recoverDurableAuthSessionForTarget(
  input: DurableAuthRecoveryInput,
  expected: DurableAuthRecoveryTarget,
): Promise<void> {
  if (!isRecoveryStrategy(input.strategy)) throw new RunStoreError("RUN_INVALID_INPUT", "unknown durable auth recovery strategy");
  const locator = { home: input.home, cacheRoot: input.cacheRoot };
  await recoverHeldAuthLeaseWithJournalAction(locator, input, expected, async (lease) => {
    assertExpectedRecoveryTarget(lease, expected);
    if (input.strategy === "release-never-started" || input.strategy === "release-clean") return;
    const root = dirname(lease.owner.journalPath);
    const snapshot = await readSnapshot(join(lease.owner.journalPath, "snapshot.json"), lease);
    const canonical = await observeStableAuth(lease.canonicalAuthPath);
    if (input.strategy === "keep-canonical-after-login") {
      if (canonical.state !== "present" || canonical.hash === snapshot.canonicalInitial.hash) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "canonical auth does not prove a completed replacement login");
      await publishEvidence(join(lease.owner.journalPath, "operator-auth-action.json"), { version: 1, kind: "operator-auth-action", token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, strategy: input.strategy, canonicalAuthHash: canonical.hash, snapshotDigest: snapshot.digest, rotationDigest: null, createdAt: new Date().toISOString() });
      return;
    }
    const rotation = await readRotation(join(lease.owner.journalPath, "run-local-rotation.json"), lease, snapshot);
    let finalCanonical = canonical;
    if (canonical.hash === snapshot.canonicalInitial.hash) {
      const bytes = await readBoundAuth(join(root, "codex-home", "auth.json"), rotation.final);
      await atomicWriteBack(bytes, lease.canonicalAuthPath, lease.token, canonical);
      finalCanonical = await observeStableAuth(lease.canonicalAuthPath);
    }
    if (finalCanonical.hash !== rotation.final.hash) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "canonical auth does not match durable run-local rotation evidence");
    await publishEvidence(join(lease.owner.journalPath, "operator-auth-action.json"), { version: 1, kind: "operator-auth-action", token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, strategy: input.strategy, canonicalAuthHash: finalCanonical.hash, snapshotDigest: snapshot.digest, rotationDigest: rotation.digest, createdAt: new Date().toISOString() });
  });
}

export function recoveryTargetFromInspection(inspection: HeldDurableAuthRecoveryInspection): DurableAuthRecoveryTarget {
  return {
    ownerKind: inspection.ownerKind,
    ownerId: inspection.ownerId,
    journalPath: inspection.journalPath,
    canonicalAuthPath: inspection.canonicalAuthPath,
    token: inspection.token,
  };
}

function assertExpectedRecoveryTarget(lease: AuthLease, expected: DurableAuthRecoveryTarget): void {
  if (lease.owner.kind !== expected.ownerKind || lease.owner.id !== expected.ownerId || lease.owner.journalPath !== expected.journalPath || lease.canonicalAuthPath !== expected.canonicalAuthPath || lease.token !== expected.token) {
    throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth recovery target changed after inspection");
  }
}

function publicAuthObservation(observation: AuthObservation): DurableAuthFileInspection {
  return { state: observation.state, hash: observation.hash };
}

function defaultCacheRoot(env: NodeJS.ProcessEnv): string { if (env.XDG_CACHE_HOME) return env.XDG_CACHE_HOME; return process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"); }
function assertChildDirectory(root: string, path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new RunStoreError("RUN_INVALID_INPUT", `durable auth ${label} must be canonical and absolute`);
  const relation = relative(root, path);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new RunStoreError("RUN_INVALID_INPUT", `durable auth ${label} must be contained by sessionRoot`);
  }
}
async function resolveCurrentDurableAuthLocator(options: CurrentDurableAuthOptions): Promise<Pick<DurableAuthRecoveryInput, "home" | "cacheRoot"> | undefined> {
  const baseEnv = options.baseEnv ?? process.env;
  const home = await realpath(baseEnv.CODEX_HOME ?? join(homedir(), ".codex"));
  try {
    return { home, cacheRoot: await realpath(options.cacheRoot ?? defaultCacheRoot(baseEnv)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function ensureCacheRoot(path: string): Promise<string> { await mkdir(path, { recursive: true, mode: DIR_MODE }); return realpath(path); }
async function ensureDirectory(path: string): Promise<void> { try { await mkdir(path, { mode: DIR_MODE }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== DIR_MODE) throw new RunStoreError("RUN_STORE_CORRUPT", `unsafe durable auth directory: ${path}`); }
async function assertDirectory(path: string): Promise<void> { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== DIR_MODE) throw new RunStoreError("RUN_AUTH_UNCERTAIN", `unsafe durable auth directory: ${path}`); }
async function copyOptional(from: string, to: string): Promise<void> { try { await copyFile(from, to, constants.COPYFILE_EXCL); await chmod(to, FILE_MODE); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
async function readOptional(path: string): Promise<string> { try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; } }
async function writePrivate(path: string, value: string): Promise<void> { const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE); try { await handle.writeFile(value); await handle.chmod(FILE_MODE); await handle.sync(); } finally { await handle.close(); } }
async function atomicWriteBack(content: Buffer, target: string, id: string, expectedCanonical: AuthObservation): Promise<void> {
  const temp = `${target}.codex-sidecar-${id}.tmp`;
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE);
    try { await handle.writeFile(content); await handle.chmod(FILE_MODE); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!Buffer.from(await readPrivateBytes(temp)).equals(content)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth write-back temp conflicts with bound auth bytes");
  }
  // The global sidecar lease serializes sidecar writers. The operator's
  // confirmation is the trust boundary for non-cooperating writers such as a
  // concurrent `codex login`; re-observe immediately before rename so any
  // completed external replacement is never overwritten.
  await __durableAuthTestHooks.beforeAtomicWriteBack?.();
  const beforeRename = await observeStableAuth(target);
  if (stableJson(beforeRename) !== stableJson(expectedCanonical)) {
    throw new RunStoreError("RUN_AUTH_UNCERTAIN", "canonical auth changed before durable write-back");
  }
  await rename(temp, target);
}
async function writeEvidence(path: string, body: object): Promise<void> { await publishEvidence(path, body); }
async function publishEvidence(path: string, body: object): Promise<void> {
  const payload = { ...body, digest: sha256(stableJson(body)) };
  try { await writePrivate(path, `${JSON.stringify(payload)}\n`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readEvidence(path);
    if (!sameEvidence(existing, payload)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth evidence conflicts with an existing record");
  }
}
async function readEvidence(path: string): Promise<Record<string, unknown>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || (info.mode & 0o777) !== FILE_MODE) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth evidence is not private");
    const value: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (!isObject(value) || typeof value.digest !== "string") throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth evidence is malformed");
    const { digest, ...body } = value;
    if (digest !== sha256(stableJson(body))) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth evidence digest mismatches");
    return value;
  } finally { await handle.close(); }
}
async function readPrivateBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); if (!info.isFile() || (info.mode & 0o777) !== FILE_MODE) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth temp is unsafe"); return handle.readFile(); }
  finally { await handle.close(); }
}
async function observeStableAuth(path: string): Promise<AuthObservation> { const first = await observeAuth(path); const second = await observeAuth(path); if (stableJson(first) !== stableJson(second)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "auth file did not have two stable observations"); return second; }
async function observeAuth(path: string): Promise<AuthObservation> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || (before.mode & 0o777n) !== 0o600n) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "auth file is not a private regular file");
    const content = await handle.readFile(); const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "auth file changed during observation");
    const value: unknown = JSON.parse(content.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "auth file is not a JSON object");
    return { state: "present", hash: createHash("sha256").update(content).digest("hex"), dev: String(before.dev), ino: String(before.ino), size: String(before.size), mtimeNs: String(before.mtimeNs) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", hash: "absent" }; throw error; }
  finally { await handle?.close(); }
}
async function readBoundAuth(path: string, expected: AuthObservation): Promise<Buffer> {
  if (expected.state !== "present") throw new RunStoreError("RUN_AUTH_UNCERTAIN", "cannot bind absent auth bytes");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true }); const content = await handle.readFile(); const after = await handle.stat({ bigint: true });
    const observed = { state: "present" as const, hash: createHash("sha256").update(content).digest("hex"), dev: String(after.dev), ino: String(after.ino), size: String(after.size), mtimeNs: String(after.mtimeNs) };
    if (!before.isFile() || (before.mode & 0o777n) !== 0o600n || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || stableJson(observed) !== stableJson(expected)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "run-local auth changed after rotation evidence");
    const value: unknown = JSON.parse(content.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "bound auth is not a JSON object");
    return content;
  } finally { await handle.close(); }
}
type SnapshotEvidence = { version: 1; kind: "auth-snapshot"; token: string; canonicalAuthPath: string; canonicalInitial: AuthObservation; runLocalInitial: AuthObservation; createdAt: string; digest: string };
type RotationEvidence = { version: 1; kind: "auth-run-local-rotation"; token: string; canonicalAuthPath: string; canonicalInitial: AuthObservation; runLocalInitial: AuthObservation; final: AuthObservation; createdAt: string; digest: string };
async function readSnapshot(path: string, lease: AuthLease): Promise<SnapshotEvidence> {
  const value = await readEvidence(path);
  if (!sameKeys(value, ["version", "kind", "token", "canonicalAuthPath", "canonicalInitial", "runLocalInitial", "createdAt", "digest"]) || value.version !== 1 || value.kind !== "auth-snapshot" || value.token !== lease.token || value.canonicalAuthPath !== lease.canonicalAuthPath || !isIsoTimestamp(value.createdAt) || !isAuthObservation(value.canonicalInitial) || !isAuthObservation(value.runLocalInitial)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth snapshot is invalid");
  if (value.canonicalInitial.hash !== value.runLocalInitial.hash) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth snapshot hashes do not bind the same source");
  return value as unknown as SnapshotEvidence;
}
async function readRotation(path: string, lease: AuthLease, snapshot: SnapshotEvidence): Promise<RotationEvidence> {
  let value: Record<string, unknown>;
  try {
    value = await readEvidence(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth rotation evidence is absent");
    }
    throw error;
  }
  if (!sameKeys(value, ["version", "kind", "token", "canonicalAuthPath", "canonicalInitial", "runLocalInitial", "final", "createdAt", "digest"]) || value.version !== 1 || value.kind !== "auth-run-local-rotation" || value.token !== lease.token || value.canonicalAuthPath !== lease.canonicalAuthPath || !isIsoTimestamp(value.createdAt) || !isAuthObservation(value.canonicalInitial) || !isAuthObservation(value.runLocalInitial) || !isAuthObservation(value.final)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth rotation evidence is invalid");
  if (stableJson(value.canonicalInitial) !== stableJson(snapshot.canonicalInitial) || stableJson(value.runLocalInitial) !== stableJson(snapshot.runLocalInitial) || value.final.state !== "present" || value.final.hash === snapshot.canonicalInitial.hash || (snapshot.runLocalInitial.state === "present" && value.final.dev === snapshot.runLocalInitial.dev && value.final.ino === snapshot.runLocalInitial.ino)) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "durable auth rotation evidence does not prove an atomic replacement");
  return value as unknown as RotationEvidence;
}
function isAuthObservation(value: unknown): value is AuthObservation {
  if (!isObject(value) || typeof value.state !== "string" || typeof value.hash !== "string") return false;
  if (value.state === "absent") return sameKeys(value, ["state", "hash"]) && value.hash === "absent";
  return value.state === "present" && sameKeys(value, ["state", "hash", "dev", "ino", "size", "mtimeNs"]) && /^[a-f0-9]{64}$/.test(value.hash) && ["dev", "ino", "size", "mtimeNs"].every((key) => typeof value[key] === "string" && /^(?:0|[1-9][0-9]*)$/.test(value[key] as string));
}
async function readdirSafe(path: string): Promise<string[]> { return readdir(path); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function sameEvidence(a: Record<string, unknown>, b: Record<string, unknown>): boolean { const strip = (value: Record<string, unknown>) => { const { createdAt: _createdAt, digest: _digest, ...body } = value; return body; }; return stableJson(strip(a)) === stableJson(strip(b)); }
function isIsoTimestamp(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function isRecoveryStrategy(value: unknown): value is AuthRecoveryStrategy { return value === "write-back-run-local" || value === "keep-canonical-after-login" || value === "release-never-started" || value === "release-clean"; }
function minimalConfig(source: string): string { let inTable = false; const lines = source.split(/\r?\n/).filter((line) => { const value = line.trim(); if (/^(?:\[\[.*\]\]|\[.*\])(?:\s*#.*)?$/.test(value)) { inTable = true; return false; } return !inTable && /^(?:model|model_provider|model_reasoning_effort)\s*=/.test(value); }); return `${lines.join("\n")}${lines.length ? "\n" : ""}`; }
