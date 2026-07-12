import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { claimAuthLease, releaseAuthLease, writeAuthLeaseMarker, type AuthLease } from "./auth-lease.js";
import { currentProcessIdentity } from "./process-identity.js";
import { RunStoreError } from "./run-foundation.js";
import { sha256, stableJson } from "./run-foundation.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;

type AuthObservation =
  | { state: "absent"; hash: "absent" }
  | { state: "present"; hash: string; dev: string; ino: string; size: string; mtimeNs: string };

/** @internal fault-injection seam. */
export const __durableAuthTestHooks: { beforeBoundWriteBack?: () => Promise<void> } = {};

export interface DurableAuthSessionOptions {
  baseEnv?: NodeJS.ProcessEnv;
  cacheRoot?: string;
  sessionRoot?: string;
  ownerKind: "sync-session" | "work-run";
  ownerId?: string;
}

export interface DurableAuthSession {
  id: string;
  root: string;
  codexHome: string;
  journalPath: string;
  env: NodeJS.ProcessEnv;
  lease: AuthLease;
  markAppServerStarted(): Promise<void>;
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
  const journalPath = join(root, "journal"); const codexHome = join(root, "codex-home");
  await ensureDirectory(journalPath); await ensureDirectory(codexHome);
  const owner = { kind: options.ownerKind, id, journalPath, processIdentity: await currentProcessIdentity() };
  const lease = await claimAuthLease({ home: sourceHome, cacheRoot, owner });
  try {
    await writeEvidence(join(journalPath, "lease-acquired.json"), { version: 1, kind: "auth-lease-acquired", token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, createdAt: new Date().toISOString() });
    const initial = await observeStableAuth(lease.canonicalAuthPath);
    await copyOptional(join(sourceHome, "auth.json"), join(codexHome, "auth.json"));
    await copyOptional(join(sourceHome, "installation_id"), join(codexHome, "installation_id"));
    await writePrivate(join(codexHome, "config.toml"), minimalConfig(await readOptional(join(sourceHome, "config.toml"))));
    const localInitial = await observeStableAuth(join(codexHome, "auth.json"));
    if (localInitial.hash !== initial.hash) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "canonical auth changed while the durable snapshot was copied");
    await writeEvidence(join(journalPath, "snapshot.json"), { version: 1, kind: "auth-snapshot", canonicalAuthPath: lease.canonicalAuthPath, canonicalInitial: initial, runLocalInitial: localInitial, createdAt: new Date().toISOString() });
    let started = false; let closed = false;
    return {
      id, root, codexHome, journalPath, lease, env: { ...baseEnv, CODEX_HOME: codexHome },
      async markAppServerStarted() { if (!started) { await writeAuthLeaseMarker(lease, "app-server-started"); started = true; } },
      async closeClean() {
        if (closed) return;
        if (!started) { await releaseAuthLease(lease); closed = true; return; }
        if (started) await writeAuthLeaseMarker(lease, "app-server-exited");
        const final = await observeStableAuth(join(codexHome, "auth.json"));
        let canonical = await observeStableAuth(lease.canonicalAuthPath);
        if (final.hash !== initial.hash) {
          if (final.state !== "present") throw new RunStoreError("RUN_AUTH_UNCERTAIN", "rotated run-local auth is absent");
          if (localInitial.state === "present" && final.dev === localInitial.dev && final.ino === localInitial.ino) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "in-place auth rewrite is not valid rotation evidence");
          if (canonical.hash !== initial.hash && canonical.hash !== final.hash) throw new RunStoreError("RUN_AUTH_UNCERTAIN", "canonical auth changed outside the durable session");
          await writeEvidence(join(journalPath, "run-local-rotation.json"), { version: 1, kind: "auth-run-local-rotation", token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, canonicalInitial: initial, runLocalInitial: localInitial, final, createdAt: new Date().toISOString() });
          if (canonical.hash === initial.hash) { await __durableAuthTestHooks.beforeBoundWriteBack?.(); const bytes = await readBoundAuth(join(codexHome, "auth.json"), final); await atomicWriteBack(bytes, lease.canonicalAuthPath, id); canonical = await observeStableAuth(lease.canonicalAuthPath); }
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

function defaultCacheRoot(env: NodeJS.ProcessEnv): string { if (env.XDG_CACHE_HOME) return env.XDG_CACHE_HOME; return process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"); }
async function ensureCacheRoot(path: string): Promise<string> { await mkdir(path, { recursive: true, mode: DIR_MODE }); return realpath(path); }
async function ensureDirectory(path: string): Promise<void> { try { await mkdir(path, { mode: DIR_MODE }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== DIR_MODE) throw new RunStoreError("RUN_STORE_CORRUPT", `unsafe durable auth directory: ${path}`); }
async function copyOptional(from: string, to: string): Promise<void> { try { await copyFile(from, to, constants.COPYFILE_EXCL); await chmod(to, FILE_MODE); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
async function readOptional(path: string): Promise<string> { try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; } }
async function writePrivate(path: string, value: string): Promise<void> { const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE); try { await handle.writeFile(value); await handle.chmod(FILE_MODE); await handle.sync(); } finally { await handle.close(); } }
async function atomicWriteBack(content: Buffer, target: string, id: string): Promise<void> { const temp = `${target}.codex-sidecar-${id}.tmp`; const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE); try { await handle.writeFile(content); await handle.chmod(FILE_MODE); await handle.sync(); } finally { await handle.close(); } await rename(temp, target); }
async function writeEvidence(path: string, body: object): Promise<void> { await writePrivate(path, `${JSON.stringify({ ...body, digest: sha256(stableJson(body)) })}\n`); }
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
function minimalConfig(source: string): string { let inTable = false; const lines = source.split(/\r?\n/).filter((line) => { const value = line.trim(); if (/^(?:\[\[.*\]\]|\[.*\])(?:\s*#.*)?$/.test(value)) { inTable = true; return false; } return !inTable && /^(?:model|model_provider|model_reasoning_effort|model_context_window|model_auto_compact_token_limit)\s*=/.test(value); }); return `${lines.join("\n")}${lines.length ? "\n" : ""}`; }
