import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DEFAULT_TURN_TIMEOUT_MS, WORKFLOWS, type ResultFormat, type SafetyProfileName, type SidecarContextBlock, type SidecarRequest } from "./types.js";
import { promisify } from "node:util";
import type { NewRunSnapshot, RunStartInput, SidecarRunManifest, StoredRun } from "./run-types.js";
import { currentProcessIdentity } from "./process-identity.js";
import type { LaunchClaim } from "./run-types.js";
import { publishRecord, readClaim as readLaunchClaim } from "./run-records.js";
import { RunStoreError, sha256, stableJson } from "./run-foundation.js";

export { RunStoreError, sha256, stableJson } from "./run-foundation.js";

const execFileAsync = promisify(execFile);
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Opens a deterministic run. `prepareNewRun` is intentionally deferred until no
 * winner exists, so retries never reload config/presets or resolve HEAD again.
 */
export async function openOrCreateRun(
  input: RunStartInput,
  prepareNewRun: () => Promise<NewRunSnapshot>,
): Promise<StoredRun> {
  assertIdempotencyKey(input.idempotencyKey);
  const callerWorktreePath = await canonicalPath(input.projectRoot);
  const projectStoreIdentity = await resolveGitCommonDir(callerWorktreePath);
  const storeRoot = join(projectStoreIdentity, "codex-sidecar", "runs");
  await ensureStoreRoot(storeRoot);

  const baseRef = input.baseRef ?? "HEAD";
  const rawInput = canonicalRawInput(input.rawInput, callerWorktreePath, baseRef);
  const rawInputDigest = sha256(stableJson(rawInput));
  const runId = sha256(`${projectStoreIdentity}\0${input.idempotencyKey}`);
  const runDirectory = join(storeRoot, runId);

  const existing = await readExisting(runDirectory);
  if (existing) {
    assertMatchingExisting(existing, runDirectory, runId, projectStoreIdentity, sha256(input.idempotencyKey), rawInputDigest);
    return { storeRoot, runDirectory, manifest: existing, created: false, claim: await readClaim(runDirectory) };
  }

  const snapshot = await prepareNewRun();
  const objectFormat = await resolveObjectFormat(callerWorktreePath);
  const baseCommit = await resolveCommit(callerWorktreePath, baseRef, objectFormat);
  const normalizedRequest = await canonicalizeNormalizedRequest(snapshot.normalizedRequest, callerWorktreePath);
  const normalizedRequestDigest = sha256(stableJson(normalizedRequest));
  const manifestPayload: Omit<SidecarRunManifest, "manifestDigest"> = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    projectStoreIdentity,
    callerWorktreePath,
    baseRef,
    baseCommit,
    objectFormat,
    idempotencyKeyDigest: sha256(input.idempotencyKey),
    rawInput,
    rawInputDigest,
    normalizedRequest,
    normalizedRequestDigest,
  };
  const manifest: SidecarRunManifest = {
    ...manifestPayload,
    manifestDigest: sha256(stableJson(manifestPayload)),
  };

  const tempDirectory = join(storeRoot, `.tmp-${runId}-${randomBytes(12).toString("hex")}`);
  try {
    await ensureDirectory(tempDirectory);
    const claimBody = { version: 1 as const, kind: "claim" as const, generation: 1, token: randomBytes(32).toString("base64url"), owner: await currentProcessIdentity(), createdAt: new Date().toISOString() };
    const claim: LaunchClaim = { ...claimBody, digest: sha256(stableJson(claimBody)) };
    await ensureDirectory(join(tempDirectory, "launch.lock"));
    await publishRecord(join(tempDirectory, "launch.lock"), "claim.json", claim);
    await publishRecord(join(tempDirectory, "launch.lock"), "heartbeat.json", {
      kind: "heartbeat", generation: claim.generation, token: claim.token, owner: claim.owner, updatedAt: claim.createdAt,
    });
    await writePrivateFile(join(tempDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    try {
      await rename(tempDirectory, runDirectory);
      return { storeRoot, runDirectory, manifest, created: true, claim };
    } catch (error) {
      if (!(await exists(runDirectory))) {
        throw error;
      }
      const winner = await readManifest(runDirectory);
      assertMatchingExisting(winner, runDirectory, runId, projectStoreIdentity, sha256(input.idempotencyKey), rawInputDigest);
      return { storeRoot, runDirectory, manifest: winner, created: false, claim: await readClaim(runDirectory) };
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function readClaim(runDirectory: string): Promise<LaunchClaim> {
  return readLaunchClaim(join(runDirectory, "launch.lock"));
}

/** @internal Worker-only durable run read; callers must already have crossed the permit boundary. */
export async function readStoredRunDirectory(runDirectory: string): Promise<Pick<StoredRun, "runDirectory" | "manifest" | "claim">> {
  return { runDirectory, manifest: await readManifest(runDirectory), claim: await readClaim(runDirectory) };
}

function canonicalRawInput(rawInput: RunStartInput["rawInput"], callerWorktreePath: string, baseRef: string): Record<string, unknown> {
  const callerInput = jsonValue(rawInput, "raw input");
  if (!isPlainObject(callerInput)) throw new RunStoreError("RUN_INVALID_INPUT", "raw input must be an object");
  const allowed = new Set([
    "workflow", "prompt", "preset", "outputContract", "readonly", "requireWorktree", "focus", "allowedPaths", "denyPaths",
    "safetyProfile", "model", "modelReasoningEffort", "resultFormat", "turnTimeoutMs", "interruptOnTimeout", "preserveWorktree", "context", "dryRun",
  ]);
  for (const key of Object.keys(callerInput)) {
    if (!allowed.has(key)) throw new RunStoreError("RUN_INVALID_INPUT", `unknown raw work-start field: ${key}`);
  }
  if (callerInput.workflow !== undefined && callerInput.workflow !== "work") {
    throw new RunStoreError("RUN_INVALID_INPUT", "work start workflow must be work");
  }
  return removeUndefined({
    ...callerInput,
    workflow: "work",
    projectRoot: callerWorktreePath,
    baseRef,
    turnTimeoutMs: callerInput.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    interruptOnTimeout: callerInput.interruptOnTimeout ?? true,
    preserveWorktree: callerInput.preserveWorktree ?? true,
    context: callerInput.context ?? [],
    dryRun: callerInput.dryRun ?? false,
  });
}

function assertIdempotencyKey(key: string): void {
  const base64Url = /^[A-Za-z0-9_-]{22,128}$/;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!base64Url.test(key) && !uuid.test(key)) {
    throw new RunStoreError("RUN_INVALID_INPUT", "idempotencyKey must be 22–128 base64url characters or a UUID");
  }
}

async function resolveGitCommonDir(projectRoot: string): Promise<string> {
  const output = await git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return canonicalPath(output.trim());
}

async function resolveObjectFormat(projectRoot: string): Promise<"sha1" | "sha256"> {
  const objectFormat = (await git(projectRoot, ["rev-parse", "--show-object-format"])).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new RunStoreError("RUN_INTERNAL_ERROR", `unsupported git object format: ${objectFormat}`);
  }
  return objectFormat;
}

async function resolveCommit(projectRoot: string, baseRef: string, objectFormat: "sha1" | "sha256"): Promise<string> {
  const commit = (await git(projectRoot, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])).trim();
  if (!isObjectId(commit, objectFormat)) throw new RunStoreError("RUN_INTERNAL_ERROR", "git returned an invalid commit object ID");
  return commit;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RunStoreError("RUN_INTERNAL_ERROR", `git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RunStoreError("RUN_INVALID_INPUT", `cannot canonicalize path ${path}: ${detail}`);
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new RunStoreError("RUN_STORE_CORRUPT", `store component is not a real directory: ${path}`);
  }
  if ((directory.mode & 0o777) !== DIRECTORY_MODE) {
    throw new RunStoreError("RUN_STORE_CORRUPT", `store directory mode is not 700: ${path}`);
  }
}

async function ensureStoreRoot(storeRoot: string): Promise<void> {
  const namespaceDirectory = dirname(storeRoot);
  if (dirname(namespaceDirectory) === namespaceDirectory) {
    throw new RunStoreError("RUN_INTERNAL_ERROR", "refusing to create a run store at the filesystem root");
  }
  await ensureDirectory(namespaceDirectory);
  await ensureDirectory(storeRoot);
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

async function readExisting(runDirectory: string): Promise<SidecarRunManifest | undefined> {
  if (!(await exists(runDirectory))) return undefined;
  return readManifest(runDirectory);
}

async function readManifest(runDirectory: string): Promise<SidecarRunManifest> {
  try {
    const directory = await lstat(runDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("run path is not a directory");
    assertMode(directory.mode, DIRECTORY_MODE, "run directory");
    const manifestPath = join(runDirectory, "manifest.json");
    const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const manifestFile = await handle.stat();
      if (!manifestFile.isFile()) throw new Error("manifest path is not a regular file");
      assertMode(manifestFile.mode, FILE_MODE, "manifest file");
      const parsed: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      return assertManifest(parsed);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new RunStoreError("RUN_STORE_CORRUPT", `cannot read manifest for ${runDirectory}: ${detail}`);
  }
}

function assertManifest(value: unknown): SidecarRunManifest {
  if (!isPlainObject(value)) throw new Error("manifest is not an object");
  const manifest = value as Record<string, unknown>;
  const keys = ["version", "runId", "createdAt", "projectStoreIdentity", "callerWorktreePath", "baseRef", "baseCommit", "objectFormat", "idempotencyKeyDigest", "rawInput", "rawInputDigest", "normalizedRequest", "normalizedRequestDigest", "manifestDigest"];
  assertExactKeys(manifest, keys, "manifest");
  if (manifest.version !== 1 || !isSha256(manifest.runId) || !isIsoTimestamp(manifest.createdAt) ||
    typeof manifest.projectStoreIdentity !== "string" || typeof manifest.callerWorktreePath !== "string" || typeof manifest.baseRef !== "string" ||
    (manifest.objectFormat !== "sha1" && manifest.objectFormat !== "sha256") || !isObjectId(manifest.baseCommit, manifest.objectFormat) ||
    !isSha256(manifest.idempotencyKeyDigest) || !isSha256(manifest.rawInputDigest) || !isSha256(manifest.normalizedRequestDigest) ||
    !isSha256(manifest.manifestDigest) || !isPlainObject(manifest.rawInput)) {
    throw new Error("manifest has an invalid shape");
  }
  const normalizedRequest = assertSidecarRequest(manifest.normalizedRequest);
  if (sha256(stableJson(manifest.rawInput)) !== manifest.rawInputDigest) throw new Error("raw input digest mismatch");
  if (sha256(stableJson(normalizedRequest)) !== manifest.normalizedRequestDigest) throw new Error("normalized request digest mismatch");
  const { manifestDigest, ...manifestPayload } = manifest;
  if (sha256(stableJson(manifestPayload)) !== manifestDigest) throw new Error("manifest digest mismatch");
  return { ...manifest, normalizedRequest } as SidecarRunManifest;
}

function assertMatchingExisting(manifest: SidecarRunManifest, runDirectory: string, runId: string, projectStoreIdentity: string, idempotencyKeyDigest: string, rawInputDigest: string): void {
  if (basename(runDirectory) !== runId || manifest.runId !== runId || manifest.projectStoreIdentity !== projectStoreIdentity || manifest.idempotencyKeyDigest !== idempotencyKeyDigest) {
    throw new RunStoreError("RUN_STORE_CORRUPT", "manifest does not match its deterministic run identity");
  }
  if (manifest.rawInputDigest !== rawInputDigest) {
    throw new RunStoreError("RUN_KEY_CONFLICT", "idempotencyKey was reused with different raw start input");
  }
  if (manifest.rawInput.projectRoot !== manifest.callerWorktreePath || manifest.rawInput.baseRef !== manifest.baseRef ||
    manifest.normalizedRequest.workflow !== "work" || manifest.normalizedRequest.projectRoot !== manifest.callerWorktreePath ||
    manifest.normalizedRequest.readonly || !manifest.normalizedRequest.requireWorktree) {
    throw new RunStoreError("RUN_STORE_CORRUPT", "manifest execution snapshot is inconsistent with its raw identity");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function jsonValue(value: unknown, label: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RunStoreError("RUN_INVALID_INPUT", `${label} must be JSON-serializable`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => {
    if (entry === undefined) throw new RunStoreError("RUN_INVALID_INPUT", `${label}[${index}] must not be undefined`);
    return jsonValue(entry, `${label}[${index}]`);
  });
  if (!isPlainObject(value)) throw new RunStoreError("RUN_INVALID_INPUT", `${label} must be JSON-serializable`);
  return removeUndefined(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry === undefined ? undefined : jsonValue(entry, `${label}.${key}`)])));
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} has unknown or missing keys`);
}

function isSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function isObjectId(value: unknown, objectFormat: "sha1" | "sha256"): value is string { return typeof value === "string" && new RegExp(`^[0-9a-f]{${objectFormat === "sha1" ? 40 : 64}}$`).test(value); }
function isIsoTimestamp(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function assertMode(mode: number, expected: number, label: string): void { if ((mode & 0o777) !== expected) throw new Error(`${label} mode is not ${expected.toString(8)}`); }

function assertSidecarRequest(value: unknown): SidecarRequest {
  if (!isPlainObject(value)) throw new Error("normalized request is not an object");
  const keys = ["workflow", "projectRoot", "prompt", "preset", "outputContract", "readonly", "requireWorktree", "focus", "allowedPaths", "denyPaths", "safetyProfile", "model", "modelReasoningEffort", "resultFormat", "turnTimeoutMs", "interruptOnTimeout", "preserveWorktree", "context", "dryRun"];
  // Optional SidecarRequest properties may be absent after JSON serialization.
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("normalized request has unknown keys");
  const request = value as Partial<SidecarRequest>;
  if (!WORKFLOWS.includes(request.workflow as SidecarRequest["workflow"]) || typeof request.projectRoot !== "string" ||
    !isOptionalString(request.prompt) || !isOptionalString(request.preset) || !isOptionalString(request.outputContract) || typeof request.readonly !== "boolean" || typeof request.requireWorktree !== "boolean" ||
    !isStringArray(request.focus) || !isStringArray(request.allowedPaths) || !isStringArray(request.denyPaths) || !isSafetyProfile(request.safetyProfile) || !isOptionalString(request.model) ||
    !isOptionalReasoningEffort(request.modelReasoningEffort) || !isResultFormat(request.resultFormat) || !Number.isInteger(request.turnTimeoutMs) || (request.turnTimeoutMs ?? 0) < 1 ||
    typeof request.interruptOnTimeout !== "boolean" || typeof request.preserveWorktree !== "boolean" || !isContextArray(request.context) || typeof request.dryRun !== "boolean") throw new Error("normalized request has an invalid shape");
  return request as SidecarRequest;
}

async function canonicalizeNormalizedRequest(value: unknown, callerWorktreePath: string): Promise<SidecarRequest> {
  const request = assertSidecarRequest(jsonValue(value, "normalized request"));
  if (request.workflow !== "work" || request.readonly || !request.requireWorktree) {
    throw new RunStoreError("RUN_INTERNAL_ERROR", "normalized work-start request violates worktree safety requirements");
  }
  const normalizedProjectRoot = await canonicalPath(request.projectRoot);
  if (normalizedProjectRoot !== callerWorktreePath) {
    throw new RunStoreError("RUN_INTERNAL_ERROR", "normalized work-start request targets a different project root");
  }
  return { ...request, projectRoot: callerWorktreePath };
}
function isOptionalString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }
function isSafetyProfile(value: unknown): value is SafetyProfileName { return ["generic", "mcp-oauth-service", "claude-hook-package", "markdown-memory-repo", "python-mcp-service", "node-mcp-service", "dockerized-public-endpoint"].includes(value as string); }
function isOptionalReasoningEffort(value: unknown): boolean { return value === undefined || value === "low" || value === "medium" || value === "high" || value === "xhigh"; }
function isResultFormat(value: unknown): value is ResultFormat { return value === "json" || value === "json-with-prose"; }
function isContextArray(value: unknown): value is SidecarContextBlock[] {
  const kinds = ["relay_entry", "throughline_handoff", "caveat_entry", "smartclaude_cost_hint", "codegraph_context", "manual_note"];
  const trusts = ["local", "user-provided", "project", "external"];
  return Array.isArray(value) && value.every((entry) => isPlainObject(entry) &&
    Object.keys(entry).every((key) => ["kind", "source", "trust", "summary", "references", "data"].includes(key)) &&
    kinds.includes(entry.kind as string) && typeof entry.source === "string" && trusts.includes(entry.trust as string) &&
    typeof entry.summary === "string" && (entry.references === undefined || isFileReferenceArray(entry.references)) &&
    (entry.data === undefined || isJsonValue(entry.data)));
}

function isFileReferenceArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((reference) => isPlainObject(reference) &&
    Object.keys(reference).every((key) => ["path", "line", "label"].includes(key)) &&
    typeof reference.path === "string" && (reference.line === undefined || typeof reference.line === "number") &&
    (reference.label === undefined || typeof reference.label === "string"));
}

function isJsonValue(value: unknown): boolean {
  try {
    jsonValue(value, "context data");
    return true;
  } catch {
    return false;
  }
}
