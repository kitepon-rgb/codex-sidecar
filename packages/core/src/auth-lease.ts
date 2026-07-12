import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { currentProcessIdentity, matchesProcessIdentity, type ProcessIdentity } from "./process-identity.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MARKERS = ["app-server-started", "app-server-exited", "auth-written-back", "clean-shutdown"] as const;
const AUXILIARY_JOURNAL_RECORDS = ["lease-acquired.json", "snapshot.json", "run-local-rotation.json", "operator-auth-action.json"] as const;
type MarkerKind = typeof MARKERS[number];
export type AuthRecoveryStrategy = "write-back-run-local" | "keep-canonical-after-login" | "release-never-started" | "release-clean";

export interface AuthLeaseOwner { kind: string; id: string; journalPath: string; processIdentity: ProcessIdentity; }
export interface AuthLeaseInput { home: string; cacheRoot: string; owner: AuthLeaseOwner; }
export interface AuthLeaseLocator { home: string; cacheRoot: string; }
export interface AuthLease {
  leaseDirectory: string; currentPath: string; claimPath: string; canonicalAuthPath: string; pathHash: string; token: string; owner: AuthLeaseOwner; createdAt: string;
}
export interface AuthLeaseInspection { state: "available" | "held"; claim?: AuthLease; }
export interface AuthLeaseRecovery { strategy: AuthRecoveryStrategy; confirmNoRunningProcesses: boolean; }
/** Exact durable lease identity supplied by a read-only operator inspection. */
export interface AuthLeaseRecoveryTarget {
  ownerKind: string;
  ownerId: string;
  journalPath: string;
  canonicalAuthPath: string;
  token: string;
}
export interface AuthLeaseWriteBackEvidence { initialAuthHash: string; finalAuthHash: string; canonicalAuthHash: string; }
/** @internal test seam */
export const __authLeaseTestHooks: { afterRecoveryRecord?: () => Promise<void>; beforeReleaseUnlink?: () => Promise<void>; afterMutexClaimPublished?: (operation: MutexOperation) => Promise<void>; afterLeaseMutationBeforeMutexRelease?: (operation: MutexOperation) => Promise<void> } = {};

interface ClaimRecord extends AuthLease { version: 1; kind: "auth-lease-claim"; digest: string; }
interface MarkerRecord { version: 1; kind: MarkerKind | "operator-recovery"; token: string; canonicalAuthPath: string; initialAuthHash?: string; finalAuthHash?: string; canonicalAuthHash?: string; authWrittenBackDigest?: string; strategy?: AuthRecoveryStrategy; generation?: string; mutexToken?: string; targetClaimDigest?: string; createdAt: string; digest: string; }
interface OperatorAuthActionRecord { version: 1; kind: "operator-auth-action"; token: string; canonicalAuthPath: string; strategy: "write-back-run-local" | "keep-canonical-after-login"; canonicalAuthHash: string; snapshotDigest: string; rotationDigest: string | null; createdAt: string; digest: string; }
type MutexOperation = "claim" | "release" | "recover" | "journal";
interface MutexTarget { lease: AuthLease; claimDigest: string; claimDev: string; claimIno: string; }
type MutexBinding =
  | { operation: "claim" | "release"; recoveryStrategy: null; decisionDigest: null; markerKind: null; markerDigest: null; markerName: null }
  | { operation: "recover"; recoveryStrategy: AuthRecoveryStrategy; decisionDigest: string; markerKind: null; markerDigest: null; markerName: null }
  | { operation: "journal"; recoveryStrategy: null; decisionDigest: null; markerKind: MarkerKind; markerDigest: string; markerName: string };
type MutexRecord = { version: 1; kind: "auth-lease-mutex"; generation: string; token: string; owner: AuthLeaseOwner; targetLeaseToken: string; targetClaimDigest: string; targetClaimDev: string; targetClaimIno: string; digest: string } & MutexBinding;
type MutexReleaseRecord = { version: 1; kind: "auth-lease-mutex-released"; generation: string; claimDigest: string; token: string; targetLeaseToken: string; targetClaimDigest: string; targetClaimDev: string; targetClaimIno: string; digest: string } & MutexBinding;
type MutexIntent =
  | { operation: "claim" | "release"; target: MutexTarget }
  | { operation: "recover"; target: MutexTarget; recoveryStrategy: AuthRecoveryStrategy; decisionDigest: string }
  | { operation: "journal"; target: MutexTarget; markerKind: MarkerKind; markerDigest: string; markerName: string };
interface RecoverySettlementExpectation {
  strategy: AuthRecoveryStrategy;
  target?: AuthLeaseRecoveryTarget;
}

export async function claimAuthLease(input: AuthLeaseInput): Promise<AuthLease> {
  unsupported();
  const context = await leaseContext(input);
  await assertCurrentOwner(input.owner);
  await ensureDirectory(join(context.cacheRoot, "codex-sidecar"));
  await ensureDirectory(join(context.cacheRoot, "codex-sidecar", "auth-leases"));
  await ensureDirectory(context.leaseDirectory);
  const { cacheRoot: _cacheRoot, ...identity } = context;
  const lease: AuthLease = { ...identity, currentPath: join(context.leaseDirectory, "current.json"), claimPath: "", token: randomBytes(32).toString("base64url"), owner: context.owner, createdAt: new Date().toISOString() };
  lease.claimPath = join(context.leaseDirectory, `${lease.token}.claim.json`);
  await writeCreateOnly(lease.claimPath, claimRecord(lease));
  return withMutex(context, { operation: "claim", target: await mutexTarget(lease) }, async () => claimAuthLeaseUnlocked(context, lease));
}

async function claimAuthLeaseUnlocked(context: Awaited<ReturnType<typeof leaseContext>>, lease: AuthLease): Promise<AuthLease> {
  try {
    await link(lease.claimPath, lease.currentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain("cannot publish auth lease", error);
    await readCurrent(context);
    throw coded("AUTH_LEASE_BUSY", "an auth lease is already held");
  }
  try { await readCurrent(context); } catch (error) { throw uncertain("published auth lease cannot be verified", error); }
  return lease;
}

export async function inspectAuthLease(input: AuthLeaseInput): Promise<AuthLeaseInspection> {
  unsupported();
  const context = await leaseContext(input);
  try { return { state: "held", claim: await readCurrent(context) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "available" }; throw uncertain("cannot inspect auth lease", error); }
}

/** Read-only inspection by canonical auth location, for auth-status/work-auth-recover. */
export async function inspectHeldAuthLease(locator: AuthLeaseLocator): Promise<AuthLeaseInspection> {
  unsupported();
  const context = await leaseLocatorContext(locator);
  try { return { state: "held", claim: await readCurrent(context) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "available" }; throw uncertain("cannot inspect auth lease", error); }
}

export async function releaseAuthLease(lease: AuthLease): Promise<void> {
  unsupported();
  const context = await leaseContext({ home: homeFromAuthPath(lease.canonicalAuthPath), cacheRoot: cacheRootFromLease(lease.leaseDirectory), owner: lease.owner });
  if (context.leaseDirectory !== lease.leaseDirectory || context.canonicalAuthPath !== lease.canonicalAuthPath || !TOKEN.test(lease.token)) throw coded("RUN_AUTH_UNCERTAIN", "lease identity is invalid");
  await assertCurrentOwner(lease.owner);
  await withMutex(context, { operation: "release", target: await mutexTarget(lease) }, async () => releaseAuthLeaseUnlocked(context, lease));
}

async function releaseAuthLeaseUnlocked(context: LeaseLocatorContext, lease: AuthLease): Promise<void> {
  const current = await readCurrent(context);
  if (!sameLease(current, lease)) throw coded("RUN_AUTH_UNCERTAIN", "current lease does not match release owner");
  const [currentStat, claimStat] = await Promise.all([lstat(lease.currentPath, { bigint: true }), lstat(lease.claimPath, { bigint: true })]);
  if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.dev !== claimStat.dev || currentStat.ino !== claimStat.ino) throw coded("RUN_AUTH_UNCERTAIN", "current lease inode changed");
  await __authLeaseTestHooks.beforeReleaseUnlink?.();
  try { await rm(lease.currentPath); } catch (error) { throw uncertain("cannot release auth lease", error); }
}

export async function writeAuthLeaseMarker(lease: AuthLease, kind: MarkerKind, evidence?: AuthLeaseWriteBackEvidence): Promise<void> {
  if (!MARKERS.includes(kind)) throw coded("RUN_AUTH_UNCERTAIN", "unknown auth lease marker");
  await assertCurrentOwner(lease.owner);
  const context = await leaseContext({ home: homeFromAuthPath(lease.canonicalAuthPath), cacheRoot: cacheRootFromLease(lease.leaseDirectory), owner: lease.owner });
  let current: AuthLease;
  try { current = await readCurrent(context); } catch (error) { throw uncertain("marker lease is no longer current", error); }
  if (!sameLease(current, lease)) throw coded("RUN_AUTH_UNCERTAIN", "marker lease is no longer current");
  await assertJournalDirectory(lease.owner.journalPath);
  const createdAt = new Date().toISOString();
  let body: Omit<MarkerRecord, "digest"> = { version: 1, kind, token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, createdAt };
  if (kind === "auth-written-back") {
    const authHash = await authHashEvidence(lease.canonicalAuthPath);
    const values = evidence ?? { initialAuthHash: authHash, finalAuthHash: authHash, canonicalAuthHash: authHash };
    if (values.finalAuthHash !== authHash || values.canonicalAuthHash !== authHash) throw coded("RUN_AUTH_UNCERTAIN", "auth write-back evidence does not match canonical auth");
    body = { ...body, ...values };
  }
  if (kind === "clean-shutdown") {
    const written = await readPrivateJson(join(lease.owner.journalPath, "auth-written-back.json")); assertMarker(written, "auth-written-back");
    body = { ...body, authWrittenBackDigest: written.digest };
  }
  const marker = { ...body, digest: digest(stable(body)) } as MarkerRecord;
  const markerName = `${kind}.json`;
  await withMutex(context, { operation: "journal", target: await mutexTarget(lease), markerKind: kind, markerDigest: marker.digest, markerName }, async () => {
    const latest = await readCurrent(context);
    if (!sameLease(latest, lease)) throw coded("RUN_AUTH_UNCERTAIN", "marker lease is no longer current");
    if (kind === "auth-written-back") {
      const currentHash = await authHashEvidence(lease.canonicalAuthPath);
      if (marker.finalAuthHash !== currentHash || marker.canonicalAuthHash !== currentHash) throw coded("RUN_AUTH_UNCERTAIN", "auth write-back evidence changed before marker publication");
    }
    await writeCreateOnly(join(lease.owner.journalPath, markerName), marker);
  });
}

/** Legacy recovery entrypoint: validates that the caller controls the supplied journal path. */
export async function recoverAuthLease(input: AuthLeaseInput, recovery: AuthLeaseRecovery): Promise<void> {
  unsupported();
  const context = await leaseContext(input);
  await assertCurrentOwner(input.owner);
  return recoverHeldAuthLeaseAt(context, recovery);
}

/**
 * Module-private extension point for the durable-auth implementation. It is
 * deliberately omitted from the package root so callers cannot supply an
 * arbitrary canonical-auth mutation to the public recovery boundary.
 * @internal
 */
export async function recoverHeldAuthLeaseWithJournalAction(
  locator: AuthLeaseLocator,
  recovery: AuthLeaseRecovery,
  expected: AuthLeaseRecoveryTarget,
  action: (lease: AuthLease) => Promise<void>,
): Promise<void> {
  unsupported();
  return recoverHeldAuthLeaseAt(await leaseLocatorContext(locator), recovery, action, expected);
}

async function recoverHeldAuthLeaseAt(
  context: Awaited<ReturnType<typeof leaseLocatorContext>>,
  recovery: AuthLeaseRecovery,
  action?: (lease: AuthLease) => Promise<void>,
  expected?: AuthLeaseRecoveryTarget,
): Promise<void> {
  if (!recovery.confirmNoRunningProcesses) throw coded("RUN_AUTH_UNCERTAIN", "operator confirmation is required");
  const mutexDirectory = join(context.leaseDirectory, "mutex"); await ensureDirectory(mutexDirectory);
  const settlementExpectation: RecoverySettlementExpectation = { strategy: recovery.strategy, target: expected };
  if (await settleHighest(context, mutexDirectory, settlementExpectation) === "recovery-completed") return;
  let held: AuthLease;
  try { held = await readCurrent(context); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (expected) assertExpectedRecoveryTarget(held, expected);
  const target = await mutexTarget(held);
  // An action may create its own operator-auth-action record, but it must
  // still prove the immutable lifecycle boundary before it is allowed to
  // mutate canonical auth.
  if (action) await assertRecoveryJournal(target.lease, recovery.strategy);
  else await assertRecoveryEvidence(target.lease, recovery.strategy);
  const decisionDigest = digest(stable({ token: target.lease.token, canonicalAuthPath: target.lease.canonicalAuthPath, strategy: recovery.strategy, targetClaimDigest: target.claimDigest, targetClaimDev: target.claimDev, targetClaimIno: target.claimIno }));
  const recoveryContext = { ...context, owner: held.owner };
  await withMutex(recoveryContext, { operation: "recover", target, recoveryStrategy: recovery.strategy, decisionDigest }, async (barrier) => {
    const current = await readCurrent(context);
    if (!sameLease(current, target.lease) || !await exactCurrentTarget(current, barrier) || expected && !matchesExpectedRecoveryTarget(current, expected)) throw coded("RUN_AUTH_UNCERTAIN", "recovery target changed before the operator action");
    if (await matchesProcessIdentity(current.owner.processIdentity)) throw coded("RUN_AUTH_UNCERTAIN", "lease owner process is still running");
    await assertJournalDirectory(current.owner.journalPath);
    if (action) await assertRecoveryJournal(current, recovery.strategy);
    await action?.(current);
    await assertRecoveryEvidence(current, recovery.strategy);
    const recordPath = join(current.owner.journalPath, "operator-recovery.json");
    try { await writeCreateOnly(recordPath, recoveryMarker(current, recovery.strategy, barrier, target)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain("cannot create operator recovery record", error);
      const existing = await readPrivateJson(recordPath); assertMarker(existing);
      if (existing.kind !== "operator-recovery" || existing.token !== current.token || existing.canonicalAuthPath !== current.canonicalAuthPath || existing.strategy !== recovery.strategy || existing.generation !== barrier.generation || existing.mutexToken !== barrier.token || existing.targetClaimDigest !== target.claimDigest) throw coded("RUN_AUTH_UNCERTAIN", "operator recovery record conflicts with current lease");
    }
    await __authLeaseTestHooks.afterRecoveryRecord?.();
    await releaseAuthLeaseUnlocked(recoveryContext, current);
  }, settlementExpectation);
}

async function withMutex<T>(
  context: Awaited<ReturnType<typeof leaseContext>>,
  intent: MutexIntent,
  action: (barrier: MutexRecord) => Promise<T>,
  settlementExpectation?: RecoverySettlementExpectation,
): Promise<T> {
  const directory = join(context.leaseDirectory, "mutex"); await ensureDirectory(directory);
  await settleHighest(context, directory, settlementExpectation);
  const generation = await nextGeneration(directory);
  const owner = await currentProcessIdentity();
  const binding: MutexBinding = intent.operation === "recover"
    ? { operation: "recover", recoveryStrategy: intent.recoveryStrategy, decisionDigest: intent.decisionDigest, markerKind: null, markerDigest: null, markerName: null }
    : intent.operation === "journal"
      ? { operation: "journal", recoveryStrategy: null, decisionDigest: null, markerKind: intent.markerKind, markerDigest: intent.markerDigest, markerName: intent.markerName }
      : { operation: intent.operation, recoveryStrategy: null, decisionDigest: null, markerKind: null, markerDigest: null, markerName: null };
  const { target } = intent;
  const body = { version: 1 as const, kind: "auth-lease-mutex" as const, generation, token: randomBytes(32).toString("base64url"), owner: { kind: "process", id: String(owner.pid), journalPath: context.owner.journalPath, processIdentity: owner }, targetLeaseToken: target.lease.token, targetClaimDigest: target.claimDigest, targetClaimDev: target.claimDev, targetClaimIno: target.claimIno, ...binding };
  const record: MutexRecord = { ...body, digest: digest(stable(body)) };
  await publishMutex(directory, `${generation}.claim.json`, record);
  await assertHighest(directory, record);
  await __authLeaseTestHooks.afterMutexClaimPublished?.(intent.operation);
  try { const result = await action(record); await assertHighest(directory, record); await __authLeaseTestHooks.afterLeaseMutationBeforeMutexRelease?.(intent.operation); await publishRelease(directory, record); return result; }
  catch (error) {
    await assertHighest(directory, record);
    // A published recovery decision is a write-ahead boundary. Never erase that
    // uncertainty merely because the initiating call observed an exception.
    if (record.operation !== "recover" || !await recoveryDecisionExists(record, target.lease)) await publishRelease(directory, record);
    throw error;
  }
}

type MutexSettlement = "none" | "barrier-cleared" | "recovery-completed";
async function settleHighest(
  context: Awaited<ReturnType<typeof leaseLocatorContext>>,
  directory: string,
  expectation?: RecoverySettlementExpectation,
): Promise<MutexSettlement> {
  const highest = await highestMutex(directory); if (!highest || highest.released) return "none";
  if (await matchesProcessIdentity(highest.claim.owner.processIdentity)) throw coded("RUN_AUTH_UNCERTAIN", "auth lease mutex owner is still running");
  let current: AuthLease | undefined;
  try { current = await readCurrent(context); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const exact = current !== undefined && current.token === highest.claim.targetLeaseToken && await exactCurrentTarget(current, highest.claim);
  if (highest.claim.operation === "claim") { if (current && !exact) throw coded("RUN_AUTH_UNCERTAIN", "abandoned claim has foreign current"); }
  else if (highest.claim.operation === "release") { if (current && !exact) throw coded("RUN_AUTH_UNCERTAIN", "abandoned release has foreign current"); }
  else if (highest.claim.operation === "recover") {
    if (expectation && highest.claim.recoveryStrategy !== expectation.strategy) throw coded("RUN_AUTH_UNCERTAIN", "abandoned recovery strategy conflicts with requested strategy");
    if (current && !exact) throw coded("RUN_AUTH_UNCERTAIN", "abandoned recovery has foreign current");
    {
      const target = await immutableMutexTarget(context, highest.claim);
      if (expectation?.target && !matchesExpectedRecoveryTarget(target, expectation.target)) {
        throw coded("RUN_AUTH_UNCERTAIN", "abandoned recovery belongs to a different durable auth target");
      }
      let decision: MarkerRecord;
      try { decision = await readPrivateJson(join(target.owner.journalPath, "operator-recovery.json")) as MarkerRecord; assertMarker(decision); }
      catch (error) { if (current && (error as NodeJS.ErrnoException).code === "ENOENT") { await publishRelease(directory, highest.claim); return "barrier-cleared"; } throw error; }
      if (decision.kind !== "operator-recovery" || decision.token !== target.token || decision.canonicalAuthPath !== target.canonicalAuthPath || decision.generation !== highest.claim.generation || decision.mutexToken !== highest.claim.token || decision.targetClaimDigest !== highest.claim.targetClaimDigest || decision.strategy !== highest.claim.recoveryStrategy || digest(stable({ token: target.token, canonicalAuthPath: target.canonicalAuthPath, strategy: decision.strategy, targetClaimDigest: highest.claim.targetClaimDigest, targetClaimDev: highest.claim.targetClaimDev, targetClaimIno: highest.claim.targetClaimIno })) !== highest.claim.decisionDigest) throw coded("RUN_AUTH_UNCERTAIN", "abandoned recovery decision conflicts");
      if (current) {
        if (!sameLease(current, target)) throw coded("RUN_AUTH_UNCERTAIN", "abandoned recovery target conflicts");
      await assertRecoveryEvidence(current, decision.strategy); await releaseAuthLeaseUnlocked(context, current);
      } else await assertRecoveryEvidence(target, decision.strategy);
    }
  } else {
    const target = await immutableMutexTarget(context, highest.claim);
    if (!current || !exact || !sameLease(current, target)) throw coded("RUN_AUTH_UNCERTAIN", "abandoned journal target is no longer current");
    if (highest.claim.markerName !== `${highest.claim.markerKind}.json`) throw coded("RUN_AUTH_UNCERTAIN", "abandoned journal marker binding conflicts");
    const markerPath = join(target.owner.journalPath, highest.claim.markerName);
    try {
      const marker = await readPrivateJson(markerPath); assertMarker(marker, highest.claim.markerKind);
      if (marker.digest !== highest.claim.markerDigest || marker.token !== target.token || marker.canonicalAuthPath !== target.canonicalAuthPath) throw coded("RUN_AUTH_UNCERTAIN", "abandoned journal marker conflicts");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await publishRelease(directory, highest.claim);
  return highest.claim.operation === "recover" ? "recovery-completed" : "barrier-cleared";
}

async function highestMutex(directory: string): Promise<{ claim: MutexRecord; released?: MutexReleaseRecord } | undefined> {
  const names = await readdir(directory); const files = names.filter((name) => /^\d{20}\.(claim|released)\.json$/.test(name));
  for (const name of names) if (!files.includes(name) && !/^\.tmp-[A-Za-z0-9_-]+$/.test(name)) throw coded("RUN_AUTH_UNCERTAIN", "unknown auth lease mutex artifact");
  if (!files.length) return undefined;
  const generations = new Map<string, { claim?: MutexRecord; released?: MutexReleaseRecord }>();
  for (const name of files) { const generation = name.slice(0, 20); const slot = generations.get(generation) ?? {}; if (name.endsWith("claim.json")) { if (slot.claim) throw coded("RUN_AUTH_UNCERTAIN", "duplicate mutex claim"); const v = await readPrivateJson(join(directory, name)); assertMutex(v); if (v.generation !== generation) throw coded("RUN_AUTH_UNCERTAIN", "mutex generation mismatch"); slot.claim = v; } else { if (slot.released) throw coded("RUN_AUTH_UNCERTAIN", "duplicate mutex release"); const v = await readPrivateJson(join(directory, name)); assertMutexRelease(v); if (v.generation !== generation) throw coded("RUN_AUTH_UNCERTAIN", "mutex release generation mismatch"); slot.released = v; } generations.set(generation, slot); }
  const ordered = [...generations.keys()].sort(); for (let i = 0; i < ordered.length; i++) { if (BigInt(ordered[i]!) !== BigInt(i + 1)) throw coded("RUN_AUTH_UNCERTAIN", "mutex generation gap"); const slot = generations.get(ordered[i]!)!; if (!slot.claim) throw coded("RUN_AUTH_UNCERTAIN", "mutex release without claim"); if (slot.released && !sameMutexRelease(slot.claim, slot.released)) throw coded("RUN_AUTH_UNCERTAIN", "mutex release does not bind claim"); }
  const last = generations.get(ordered.at(-1)!)!; return { claim: last.claim!, released: last.released };
}
async function nextGeneration(directory: string): Promise<string> { const highest = await highestMutex(directory); return String(highest ? BigInt(highest.claim.generation) + 1n : 1n).padStart(20, "0"); }
async function assertHighest(directory: string, record: MutexRecord): Promise<void> { const highest = await highestMutex(directory); if (!highest || highest.released || stable(highest.claim) !== stable(record)) throw coded("RUN_AUTH_UNCERTAIN", "auth lease mutex barrier changed"); }
async function publishMutex(directory: string, name: string, value: MutexRecord): Promise<void> { await publishPrivate(directory, name, value); }
async function publishRelease(directory: string, claim: MutexRecord): Promise<void> { const body = { version: 1 as const, kind: "auth-lease-mutex-released" as const, generation: claim.generation, claimDigest: claim.digest, token: claim.token, operation: claim.operation, targetLeaseToken: claim.targetLeaseToken, targetClaimDigest: claim.targetClaimDigest, targetClaimDev: claim.targetClaimDev, targetClaimIno: claim.targetClaimIno, recoveryStrategy: claim.recoveryStrategy, decisionDigest: claim.decisionDigest, markerKind: claim.markerKind, markerDigest: claim.markerDigest, markerName: claim.markerName }; await publishPrivate(directory, `${claim.generation}.released.json`, { ...body, digest: digest(stable(body)) }); }
async function publishPrivate(directory: string, name: string, value: object): Promise<void> { const finalPath = join(directory, name); const temp = join(directory, `.tmp-${randomBytes(16).toString("base64url")}`); await writeCreateOnly(temp, value); try { await link(temp, finalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const existing = await readPrivateJson(finalPath); if (stable(existing) !== stable(value)) throw coded("RUN_AUTH_UNCERTAIN", "mutex artifact conflicts"); } finally { await rm(temp, { force: true }); } }
async function mutexTarget(lease: AuthLease): Promise<MutexTarget> { const record = await readPrivateJson(lease.claimPath); assertClaim(record); const info = await lstat(lease.claimPath, { bigint: true }); return { lease, claimDigest: record.digest, claimDev: info.dev.toString(), claimIno: info.ino.toString() }; }
async function immutableMutexTarget(context: { leaseDirectory: string; canonicalAuthPath: string }, record: MutexRecord): Promise<AuthLease> { if (!record.targetLeaseToken || !record.targetClaimDigest || record.targetClaimDev === null || record.targetClaimIno === null) throw coded("RUN_AUTH_UNCERTAIN", "mutex target is absent"); const path = join(context.leaseDirectory, `${record.targetLeaseToken}.claim.json`); const claim = await readPrivateJson(path); assertClaim(claim); const info = await lstat(path, { bigint: true }); if (claim.claimPath !== path || claim.canonicalAuthPath !== context.canonicalAuthPath || claim.digest !== record.targetClaimDigest || info.dev.toString() !== record.targetClaimDev || info.ino.toString() !== record.targetClaimIno) throw coded("RUN_AUTH_UNCERTAIN", "immutable mutex target conflicts"); return stripClaim(claim); }
async function exactCurrentTarget(current: AuthLease, record: MutexRecord): Promise<boolean> { try { const claim = await readPrivateJson(current.claimPath); assertClaim(claim); const info = await lstat(current.claimPath, { bigint: true }); return claim.digest === record.targetClaimDigest && info.dev.toString() === record.targetClaimDev && info.ino.toString() === record.targetClaimIno; } catch { return false; } }
function assertExpectedRecoveryTarget(lease: AuthLease, expected: AuthLeaseRecoveryTarget): void {
  if (!matchesExpectedRecoveryTarget(lease, expected)) throw coded("RUN_AUTH_UNCERTAIN", "durable auth recovery target changed after inspection");
}
function matchesExpectedRecoveryTarget(lease: AuthLease, expected: AuthLeaseRecoveryTarget): boolean {
  return lease.owner.kind === expected.ownerKind && lease.owner.id === expected.ownerId && lease.owner.journalPath === expected.journalPath && lease.canonicalAuthPath === expected.canonicalAuthPath && lease.token === expected.token;
}
async function recoveryDecisionExists(record: MutexRecord, lease: AuthLease): Promise<boolean> {
  if (record.operation !== "recover") return false;
  try { const value = await readPrivateJson(join(lease.owner.journalPath, "operator-recovery.json")); assertMarker(value); return value.kind === "operator-recovery"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; return true; }
}

type LeaseLocatorContext = { leaseDirectory: string; canonicalAuthPath: string; pathHash: string; cacheRoot: string };

async function leaseLocatorContext(input: AuthLeaseLocator): Promise<LeaseLocatorContext> {
  if (!isAbsolute(input.home) || !isAbsolute(input.cacheRoot)) throw coded("RUN_AUTH_UNCERTAIN", "home and cache root must be absolute");
  const [home, cacheRoot] = await Promise.all([realpath(input.home), realpath(input.cacheRoot)]);
  const canonicalAuthPath = join(home, "auth.json");
  const pathHash = digest(canonicalAuthPath);
  return { leaseDirectory: join(cacheRoot, "codex-sidecar", "auth-leases", pathHash), canonicalAuthPath, pathHash, cacheRoot };
}

async function leaseContext(input: AuthLeaseInput): Promise<LeaseLocatorContext & { owner: AuthLeaseOwner }> {
  const context = await leaseLocatorContext(input);
  await assertJournalDirectory(input.owner.journalPath);
  assertOwner(input.owner);
  return { ...context, owner: { ...input.owner, journalPath: await realpath(input.owner.journalPath) } };
}

async function assertCurrentOwner(owner: AuthLeaseOwner): Promise<void> {
  const current = await currentProcessIdentity();
  if (owner.processIdentity.pid !== current.pid || owner.processIdentity.startIdentity !== current.startIdentity) throw coded("RUN_AUTH_UNCERTAIN", "claim owner must be the current process identity");
}

async function readCurrent(context: { leaseDirectory: string; canonicalAuthPath: string; pathHash: string }): Promise<AuthLease> {
  try { return await readCurrentStrict(context); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "RUN_AUTH_UNCERTAIN" || (error as NodeJS.ErrnoException).code === "ENOENT") throw error; throw uncertain("cannot read current auth lease", error); }
}

async function readCurrentStrict(context: { leaseDirectory: string; canonicalAuthPath: string; pathHash: string }): Promise<AuthLease> {
  const path = join(context.leaseDirectory, "current.json");
  const value = await readPrivateJson(path);
  assertClaim(value);
  if (value.canonicalAuthPath !== context.canonicalAuthPath || value.pathHash !== context.pathHash || value.leaseDirectory !== context.leaseDirectory || value.currentPath !== path || value.claimPath !== join(context.leaseDirectory, `${value.token}.claim.json`)) throw coded("RUN_AUTH_UNCERTAIN", "auth lease identity mismatch");
  const claim = await readPrivateJson(value.claimPath);
  assertClaim(claim);
  const [a, b] = await Promise.all([lstat(path, { bigint: true }), lstat(value.claimPath, { bigint: true })]);
  if (a.dev !== b.dev || a.ino !== b.ino || stable(value) !== stable(claim)) throw coded("RUN_AUTH_UNCERTAIN", "auth lease current is not its immutable claim");
  return stripClaim(value);
}

async function assertRecoveryJournal(lease: AuthLease, strategy: AuthRecoveryStrategy): Promise<void> {
  const names = await readdir(lease.owner.journalPath);
  for (const name of names) if (name.endsWith(".json") && ![...MARKERS.map((kind) => `${kind}.json`), ...AUXILIARY_JOURNAL_RECORDS, "operator-recovery.json"].includes(name)) throw coded("RUN_AUTH_UNCERTAIN", "unknown auth lease journal record");
  const marker = async (kind: MarkerKind): Promise<MarkerRecord | undefined> => {
    try { const value = await readPrivateJson(join(lease.owner.journalPath, `${kind}.json`)); assertMarker(value, kind); return value; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw uncertain("invalid auth lease journal", error); }
  };
  const started = await marker("app-server-started");
  if (strategy === "release-never-started") {
    if (started || await marker("app-server-exited") || await marker("auth-written-back") || await marker("clean-shutdown")) throw coded("RUN_AUTH_UNCERTAIN", "journal shows app-server activity");
    return;
  }
  if (strategy === "write-back-run-local" || strategy === "keep-canonical-after-login") {
    if (!started) throw coded("RUN_AUTH_UNCERTAIN", "operator auth recovery requires app-server-started evidence");
    return;
  }
  const exited = await marker("app-server-exited"); const written = await marker("auth-written-back"); const clean = await marker("clean-shutdown");
  if (!started || !exited || !written || !clean) throw coded("RUN_AUTH_UNCERTAIN", "clean shutdown journal is incomplete");
  for (const value of [started, exited, written, clean]) if (value.token !== lease.token || value.canonicalAuthPath !== lease.canonicalAuthPath) throw coded("RUN_AUTH_UNCERTAIN", "clean shutdown markers belong to another lease");
  if (Date.parse(started.createdAt) > Date.parse(exited.createdAt) || Date.parse(exited.createdAt) > Date.parse(written.createdAt) || Date.parse(written.createdAt) > Date.parse(clean.createdAt) || !written.initialAuthHash || !written.finalAuthHash || !written.canonicalAuthHash || clean.authWrittenBackDigest !== written.digest) throw coded("RUN_AUTH_UNCERTAIN", "clean shutdown journal causality is invalid");
}

async function assertRecoveryEvidence(lease: AuthLease, strategy: AuthRecoveryStrategy): Promise<void> {
  await assertRecoveryJournal(lease, strategy);
  if (strategy === "release-never-started") return;
  if (strategy === "write-back-run-local" || strategy === "keep-canonical-after-login") {
    const action = await readOperatorAuthAction(lease);
    if (action.strategy !== strategy || action.token !== lease.token || action.canonicalAuthPath !== lease.canonicalAuthPath || action.canonicalAuthHash !== await authHashEvidence(lease.canonicalAuthPath)) throw coded("RUN_AUTH_UNCERTAIN", "operator auth action evidence does not match canonical auth");
    await assertJournalDigest(join(lease.owner.journalPath, "snapshot.json"), action.snapshotDigest);
    if (strategy === "write-back-run-local") {
      if (!action.rotationDigest) throw coded("RUN_AUTH_UNCERTAIN", "write-back recovery lacks rotation evidence");
      await assertJournalDigest(join(lease.owner.journalPath, "run-local-rotation.json"), action.rotationDigest);
    } else if (action.rotationDigest !== null) throw coded("RUN_AUTH_UNCERTAIN", "keep-canonical recovery must not use run-local rotation evidence");
    return;
  }
  try {
    const written = await readPrivateJson(join(lease.owner.journalPath, "auth-written-back.json")); assertMarker(written, "auth-written-back");
    const currentEvidence = await authHashEvidence(lease.canonicalAuthPath);
    if (written.finalAuthHash !== currentEvidence || written.canonicalAuthHash !== currentEvidence) throw coded("RUN_AUTH_UNCERTAIN", "clean recovery auth evidence does not match canonical auth");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "RUN_AUTH_UNCERTAIN") throw error;
    throw uncertain("cannot verify clean recovery auth evidence", error);
  }
}

async function readOperatorAuthAction(lease: AuthLease): Promise<OperatorAuthActionRecord> {
  try { const value = await readPrivateJson(join(lease.owner.journalPath, "operator-auth-action.json")); assertOperatorAuthAction(value); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw coded("RUN_AUTH_UNCERTAIN", "operator auth action evidence is missing"); throw error; }
}

async function assertJournalDigest(path: string, expected: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw coded("RUN_AUTH_UNCERTAIN", "invalid bound journal digest");
  const value = await readPrivateJson(path);
  if (!object(value) || typeof value.digest !== "string") throw coded("RUN_AUTH_UNCERTAIN", "bound journal record is invalid");
  const { digest: actual, ...body } = value;
  if (actual !== expected || actual !== digest(stable(body))) throw coded("RUN_AUTH_UNCERTAIN", "bound journal record changed");
}

function claimRecord(lease: AuthLease): ClaimRecord { const body = { version: 1 as const, kind: "auth-lease-claim" as const, ...lease }; return { ...body, digest: digest(stable(body)) }; }
function markerRecord(kind: MarkerKind | "operator-recovery", lease: AuthLease, strategy?: AuthRecoveryStrategy): MarkerRecord { const body = { version: 1 as const, kind, token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, ...(strategy ? { strategy } : {}), createdAt: new Date().toISOString() }; return { ...body, digest: digest(stable(body)) }; }
function recoveryMarker(lease: AuthLease, strategy: AuthRecoveryStrategy, barrier: MutexRecord, target: MutexTarget): MarkerRecord { const body = { version: 1 as const, kind: "operator-recovery" as const, token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, strategy, generation: barrier.generation, mutexToken: barrier.token, targetClaimDigest: target.claimDigest, createdAt: new Date().toISOString() }; return { ...body, digest: digest(stable(body)) }; }
function stripClaim(record: ClaimRecord): AuthLease { const { version: _version, kind: _kind, digest: _digest, ...lease } = record; return lease; }
function assertClaim(value: unknown): asserts value is ClaimRecord { if (!object(value) || !sameKeys(value, ["version", "kind", "leaseDirectory", "currentPath", "claimPath", "canonicalAuthPath", "pathHash", "token", "owner", "createdAt", "digest"]) || value.version !== 1 || value.kind !== "auth-lease-claim" || typeof value.leaseDirectory !== "string" || typeof value.currentPath !== "string" || typeof value.claimPath !== "string" || typeof value.canonicalAuthPath !== "string" || !/^[a-f0-9]{64}$/.test(String(value.pathHash)) || !TOKEN.test(String(value.token)) || !date(value.createdAt) || !object(value.owner) || typeof value.digest !== "string") throw coded("RUN_AUTH_UNCERTAIN", "invalid auth lease claim"); assertOwner(value.owner as AuthLeaseOwner); const { digest: actual, ...body } = value; if (actual !== digest(stable(body))) throw coded("RUN_AUTH_UNCERTAIN", "auth lease digest mismatch"); }
function assertMutex(value: unknown): asserts value is MutexRecord { assertMutexShape(value, false); assertOwner((value as MutexRecord).owner); }
function assertMutexRelease(value: unknown): asserts value is MutexReleaseRecord { assertMutexShape(value, true); }
function assertMutexShape(value: unknown, released: boolean): void {
  const common = ["version", "kind", "generation", "token", ...(released ? ["claimDigest"] : ["owner"]), "operation", "targetLeaseToken", "targetClaimDigest", "targetClaimDev", "targetClaimIno", "recoveryStrategy", "decisionDigest", "markerKind", "markerDigest", "markerName", "digest"];
  if (!object(value) || !sameKeys(value, common) || value.version !== 1 || value.kind !== (released ? "auth-lease-mutex-released" : "auth-lease-mutex") || !/^\d{20}$/.test(String(value.generation)) || !TOKEN.test(String(value.token)) || released && !/^[a-f0-9]{64}$/.test(String(value.claimDigest)) || !released && !object(value.owner) || !["claim", "release", "recover", "journal"].includes(String(value.operation)) || !TOKEN.test(String(value.targetLeaseToken)) || !/^[a-f0-9]{64}$/.test(String(value.targetClaimDigest)) || !/^(?:0|[1-9][0-9]*)$/.test(String(value.targetClaimDev)) || !/^(?:0|[1-9][0-9]*)$/.test(String(value.targetClaimIno)) || typeof value.digest !== "string") throw coded("RUN_AUTH_UNCERTAIN", `invalid auth lease mutex${released ? " release" : ""}`);
  const recover = value.operation === "recover";
  const journal = value.operation === "journal";
  if (recover ? (!isRecoveryStrategy(value.recoveryStrategy) || !/^[a-f0-9]{64}$/.test(String(value.decisionDigest))) : value.recoveryStrategy !== null || !recover && value.decisionDigest !== null) throw coded("RUN_AUTH_UNCERTAIN", "invalid auth lease recovery mutex binding");
  if (journal ? (!MARKERS.includes(value.markerKind as MarkerKind) || value.markerName !== `${String(value.markerKind)}.json` || !/^[a-f0-9]{64}$/.test(String(value.markerDigest))) : value.markerKind !== null || !journal && (value.markerDigest !== null || value.markerName !== null)) throw coded("RUN_AUTH_UNCERTAIN", "invalid auth lease journal mutex binding");
  const { digest: actual, ...body } = value; if (actual !== digest(stable(body))) throw coded("RUN_AUTH_UNCERTAIN", `auth lease mutex${released ? " release" : ""} digest mismatch`);
}
function sameMutexRelease(claim: MutexRecord, release: MutexReleaseRecord): boolean { return release.claimDigest === claim.digest && release.token === claim.token && release.operation === claim.operation && release.targetLeaseToken === claim.targetLeaseToken && release.targetClaimDigest === claim.targetClaimDigest && release.targetClaimDev === claim.targetClaimDev && release.targetClaimIno === claim.targetClaimIno && release.recoveryStrategy === claim.recoveryStrategy && release.decisionDigest === claim.decisionDigest && release.markerKind === claim.markerKind && release.markerDigest === claim.markerDigest && release.markerName === claim.markerName; }
function assertMarker(value: unknown, expected?: MarkerKind): asserts value is MarkerRecord { if (!object(value) || value.version !== 1 || (value.kind !== "operator-recovery" && !MARKERS.includes(value.kind as MarkerKind)) || expected && value.kind !== expected || !TOKEN.test(String(value.token)) || typeof value.canonicalAuthPath !== "string" || !date(value.createdAt) || typeof value.digest !== "string") throw coded("RUN_AUTH_UNCERTAIN", "invalid auth lease marker"); const keys = value.kind === "operator-recovery" ? ["version", "kind", "token", "canonicalAuthPath", "strategy", "generation", "mutexToken", "targetClaimDigest", "createdAt", "digest"] : value.kind === "auth-written-back" ? ["version", "kind", "token", "canonicalAuthPath", "initialAuthHash", "finalAuthHash", "canonicalAuthHash", "createdAt", "digest"] : value.kind === "clean-shutdown" ? ["version", "kind", "token", "canonicalAuthPath", "authWrittenBackDigest", "createdAt", "digest"] : ["version", "kind", "token", "canonicalAuthPath", "createdAt", "digest"];
  if (!sameKeys(value, keys) || value.kind === "operator-recovery" && (!isRecoveryStrategy(value.strategy) || !/^\d{20}$/.test(String(value.generation)) || !TOKEN.test(String(value.mutexToken)) || !/^[a-f0-9]{64}$/.test(String(value.targetClaimDigest))) || value.kind === "auth-written-back" && (!/^(absent|[a-f0-9]{64})$/.test(String(value.initialAuthHash)) || !/^(absent|[a-f0-9]{64})$/.test(String(value.finalAuthHash)) || !/^(absent|[a-f0-9]{64})$/.test(String(value.canonicalAuthHash))) || value.kind === "clean-shutdown" && !/^[a-f0-9]{64}$/.test(String(value.authWrittenBackDigest))) throw coded("RUN_AUTH_UNCERTAIN", "invalid auth lease marker schema"); const { digest: actual, ...body } = value; if (actual !== digest(stable(body))) throw coded("RUN_AUTH_UNCERTAIN", "auth lease marker digest mismatch"); }
function assertOperatorAuthAction(value: unknown): asserts value is OperatorAuthActionRecord { if (!object(value) || !sameKeys(value, ["version", "kind", "token", "canonicalAuthPath", "strategy", "canonicalAuthHash", "snapshotDigest", "rotationDigest", "createdAt", "digest"]) || value.version !== 1 || value.kind !== "operator-auth-action" || !TOKEN.test(String(value.token)) || typeof value.canonicalAuthPath !== "string" || (value.strategy !== "write-back-run-local" && value.strategy !== "keep-canonical-after-login") || !/^[a-f0-9]{64}$/.test(String(value.canonicalAuthHash)) || !/^[a-f0-9]{64}$/.test(String(value.snapshotDigest)) || value.strategy === "write-back-run-local" && !/^[a-f0-9]{64}$/.test(String(value.rotationDigest)) || value.strategy === "keep-canonical-after-login" && value.rotationDigest !== null || !date(value.createdAt) || typeof value.digest !== "string") throw coded("RUN_AUTH_UNCERTAIN", "invalid operator auth action record"); const { digest: actual, ...body } = value; if (actual !== digest(stable(body))) throw coded("RUN_AUTH_UNCERTAIN", "operator auth action digest mismatch"); }
function isRecoveryStrategy(value: unknown): value is AuthRecoveryStrategy { return value === "write-back-run-local" || value === "keep-canonical-after-login" || value === "release-never-started" || value === "release-clean"; }
async function writeCreateOnly(path: string, value: object): Promise<void> { const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE); try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.chmod(FILE_MODE); await handle.sync(); } finally { await handle.close(); } }
async function readPrivateJson(path: string): Promise<unknown> { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const info = await handle.stat(); if (!info.isFile() || (info.mode & 0o777) !== FILE_MODE) throw coded("RUN_AUTH_UNCERTAIN", "unsafe auth lease file"); return JSON.parse(await handle.readFile({ encoding: "utf8" })); } finally { await handle.close(); } }
async function ensureDirectory(path: string): Promise<void> { try { await mkdir(path, { mode: DIR_MODE }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain("cannot create auth lease directory", error); } const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== DIR_MODE) throw coded("RUN_AUTH_UNCERTAIN", "unsafe auth lease directory"); }
async function assertJournalDirectory(path: string): Promise<void> { if (!isAbsolute(path) || resolve(path) !== path) throw coded("RUN_AUTH_UNCERTAIN", "journal path must be canonical and absolute"); const [resolved, info] = await Promise.all([realpath(path), lstat(path)]); if (resolved !== path || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== DIR_MODE || typeof process.getuid === "function" && info.uid !== process.getuid()) throw coded("RUN_AUTH_UNCERTAIN", "journal directory is not owner-controlled"); }
function assertOwner(owner: AuthLeaseOwner): void { const value = owner as unknown as Record<string, unknown>; if (!object(value) || !sameKeys(value, ["kind", "id", "journalPath", "processIdentity"]) || typeof owner.kind !== "string" || !owner.kind || typeof owner.id !== "string" || !owner.id || typeof owner.journalPath !== "string" || !object(owner.processIdentity) || !Number.isInteger(owner.processIdentity.pid) || owner.processIdentity.pid <= 0 || typeof owner.processIdentity.startIdentity !== "string" || !owner.processIdentity.startIdentity) throw coded("RUN_AUTH_UNCERTAIN", "invalid auth lease owner"); }
function sameLease(a: AuthLease, b: AuthLease): boolean { return stable(a) === stable(b); }
function homeFromAuthPath(path: string): string { if (basename(path) !== "auth.json") throw coded("RUN_AUTH_UNCERTAIN", "invalid canonical auth path"); return resolve(path, ".."); }
function cacheRootFromLease(path: string): string { return resolve(path, "../../.."); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sameKeys(value: Record<string, unknown>, keys: string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
async function authHashEvidence(path: string): Promise<string> { try { return digest(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw uncertain("cannot read auth hash evidence", error); } }
function coded(code: string, message: string): Error { return Object.assign(new Error(`${code}: ${message}`), { code }); }
function uncertain(message: string, cause: unknown): Error { return coded("RUN_AUTH_UNCERTAIN", `${message}: ${cause instanceof Error ? cause.message : String(cause)}`); }
function unsupported(): void { if (process.platform === "win32") throw coded("RUN_UNSUPPORTED_PLATFORM", "auth leases require POSIX hard links"); }
