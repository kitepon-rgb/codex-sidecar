import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sha256, stableJson, RunStoreError } from "./run-foundation.js";
import type { ProcessIdentity } from "./process-identity.js";
import type { LaunchClaim } from "./run-types.js";
import type { SidecarResult } from "./types.js";
import { withRunTransition } from "./run-transition.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface RecordEnvelope {
  version: 1;
  kind: "claim" | "heartbeat" | "spawn" | "boot" | "ready" | "failure" | "cancel" | "execution-started" | "quarantine" | "result" | "terminal" | "cleanup";
  generation: number;
  token: string;
  digest: string;
  [key: string]: unknown;
}

export interface CancelRecord { version: 1; kind: "cancel"; observedGeneration: number | null; observedToken: string | null; createdAt: string; digest: string; }
export interface ExecutionStartedRecord extends RecordEnvelope { kind: "execution-started"; createdAt: string; }
export interface QuarantineRecord extends RecordEnvelope { kind: "quarantine"; createdAt: string; }
export interface ResultRecord extends RecordEnvelope { kind: "result"; result: SidecarResult; createdAt: string; }
export interface TerminalRecord extends RecordEnvelope { kind: "terminal"; state: "completed" | "failed" | "cancelled"; resultDigest: string; createdAt: string; }
export interface CleanupRecord extends RecordEnvelope { kind: "cleanup"; state: "completed" | "failed" | "not-requested"; createdAt: string; }

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

/** Commits the deterministic terminal fact after a durable result survived a crash. */
export async function promoteResultToTerminal(runDirectory: string, generation: number, token: string): Promise<TerminalRecord> {
  return withRunTransition(runDirectory, () => promoteResultToTerminalUnlocked(runDirectory, generation, token));
}

async function promoteResultToTerminalUnlocked(runDirectory: string, generation: number, token: string): Promise<TerminalRecord> {
  const result = await readRecord(runDirectory, "result.json");
  if (!result || result.kind !== "result" || result.generation !== generation || result.token !== token) throw new RunStoreError("RUN_STORE_CORRUPT", "result does not belong to the requested terminal");
  const existing = await readRecord(runDirectory, "terminal.json");
  if (existing) return terminalForResult(existing, result);
  const state = (result as ResultRecord).result.status === "failed" || (result as ResultRecord).result.status === "refused" ? "failed" : "completed";
  try { await publishRecord(runDirectory, "terminal.json", { kind: "terminal", generation, token, state, resultDigest: result.digest, createdAt: (result as ResultRecord).createdAt }); }
  catch (error) {
    const winner = await readRecord(runDirectory, "terminal.json");
    if (!winner) throw error;
    return terminalForResult(winner, result);
  }
  const terminal = await readRecord(runDirectory, "terminal.json");
  if (!terminal) throw new RunStoreError("RUN_STORE_CORRUPT", "terminal publish disappeared");
  return terminalForResult(terminal, result);
}

function terminalForResult(terminal: RecordEnvelope, result: RecordEnvelope): TerminalRecord {
  if (terminal.kind !== "terminal" || terminal.generation !== result.generation || terminal.token !== result.token || terminal.resultDigest !== result.digest) throw new RunStoreError("RUN_STORE_CORRUPT", "terminal does not bind the durable result");
  return terminal as TerminalRecord;
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
  if (record.version !== 1 || typeof record.kind !== "string" || typeof record.digest !== "undefined" && typeof record.digest !== "string") {
    throw new Error("invalid record envelope");
  }
  const keys = schemaKeys(record.kind);
  const expectedKeys = record.digest === undefined ? keys?.filter((key) => key !== "digest") : keys;
  if (expectedKeys && !sameKeys(record, expectedKeys)) throw new Error(`invalid ${record.kind} record keys`);
  if (expectedKind && record.kind !== expectedKind) throw new Error(`record kind must be ${expectedKind}`);
  if (record.kind !== "cancel" && (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1 || typeof record.token !== "string" || !TOKEN.test(record.token))) throw new Error("invalid record generation or token");
  if ("owner" in record && !isProcessIdentity(record.owner)) throw new Error("invalid record owner");
  if ("processIdentity" in record && !isProcessIdentity(record.processIdentity)) throw new Error("invalid record process identity");
  if (record.kind === "spawn" || record.kind === "boot" || record.kind === "ready" || record.kind === "failure") {
    if (!isPositiveInteger(record.pid) || !isPositiveInteger(record.pgid)) throw new Error("invalid child process identifiers");
  }
  if (record.kind === "failure" && record.reason !== "early-exit" && record.reason !== "ready-timeout" && record.reason !== "ready-invalid" && record.reason !== "spawn-publish-failed") throw new Error("invalid failure reason");
  if (record.kind === "cancel" && (record.observedGeneration !== null && (!Number.isSafeInteger(record.observedGeneration) || (record.observedGeneration as number) < 1) || record.observedToken !== null && (typeof record.observedToken !== "string" || !TOKEN.test(record.observedToken)))) throw new Error("invalid cancel observation");
  if (record.kind === "result") assertSidecarResult(record.result);
  if (record.kind === "terminal" && (record.state !== "completed" && record.state !== "failed" && record.state !== "cancelled" || typeof record.resultDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.resultDigest))) throw new Error("invalid terminal record");
  if (record.kind === "cleanup" && record.state !== "completed" && record.state !== "failed" && record.state !== "not-requested") throw new Error("invalid cleanup record");
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
    case "cancel": return ["version", "kind", "observedGeneration", "observedToken", "createdAt", "digest"];
    case "execution-started":
    case "quarantine": return [...base, "createdAt"];
    case "result": return [...base, "result", "createdAt"];
    case "terminal": return [...base, "state", "resultDigest", "createdAt"];
    case "cleanup": return [...base, "state", "createdAt"];
    default: throw new Error(`unsupported record kind: ${kind}`);
  }
}

function assertAttemptIdentity(generation: number, token: string): void {
  if (!Number.isSafeInteger(generation) || generation < 1 || !TOKEN.test(token)) {
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
    case "cancel.json": return "cancel";
    case "execution-started.json": return "execution-started";
    case "quarantine.json": return "quarantine";
    case "result.json": return "result";
    case "terminal.json": return "terminal";
    case "cleanup.json": return "cleanup";
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

function assertSidecarResult(value: unknown): asserts value is SidecarResult {
  if (!isObject(value)) throw new Error("invalid result payload");
  const allowed = [
    "status", "workflow", "summary", "confidence", "recommendedNextAction", "findings", "risks", "pass", "missingTools",
    "openQuestions", "missingTests", "residualRisks", "fileReferences", "changedFiles", "tests", "worktreePath", "worktreePreserved",
    "sourceBoundaries", "costNotes", "recommendation", "objections", "assumptions", "failureModes", "generated", "normalizationNotes",
    "unvalidatedReport", "rawEventLogRef", "normalizedRequest", "modelPolicy", "error",
  ];
  if (!onlyKeys(value, allowed) || !["ok", "partial", "failed", "refused", "dry-run"].includes(String(value.status)) || value.workflow !== "work" || typeof value.summary !== "string" || typeof value.recommendedNextAction !== "string" || !confidence(value.confidence)) throw new Error("invalid result payload");
  const stringArrays = ["openQuestions", "missingTests", "residualRisks", "changedFiles", "objections", "assumptions", "failureModes", "normalizationNotes"];
  for (const key of stringArrays) if (value[key] !== undefined && !strings(value[key])) throw new Error(`invalid result ${key}`);
  if (value.findings !== undefined && (!Array.isArray(value.findings) || !value.findings.every(finding))) throw new Error("invalid result findings");
  if (value.risks !== undefined && (!Array.isArray(value.risks) || !value.risks.every(risk))) throw new Error("invalid result risks");
  if (value.missingTools !== undefined && (!Array.isArray(value.missingTools) || !value.missingTools.every((v) => isObject(v) && sameKeys(v, ["name", "reason"]) && typeof v.name === "string" && typeof v.reason === "string"))) throw new Error("invalid result missingTools");
  if (value.fileReferences !== undefined && (!Array.isArray(value.fileReferences) || !value.fileReferences.every(fileReference))) throw new Error("invalid result fileReferences");
  if (value.tests !== undefined && (!Array.isArray(value.tests) || !value.tests.every(testRecord))) throw new Error("invalid result tests");
  if (value.sourceBoundaries !== undefined && (!Array.isArray(value.sourceBoundaries) || !value.sourceBoundaries.every(sourceBoundary))) throw new Error("invalid result sourceBoundaries");
  if (value.pass !== undefined && typeof value.pass !== "boolean" || value.worktreePreserved !== undefined && typeof value.worktreePreserved !== "boolean") throw new Error("invalid result boolean");
  for (const key of ["worktreePath", "recommendation", "rawEventLogRef"] as const) if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`invalid result ${key}`);
  if (value.costNotes !== undefined && (!isObject(value.costNotes) || !onlyKeys(value.costNotes, ["shouldCallCodex", "rationale", "estimatedInputTokens"]) || value.costNotes.shouldCallCodex !== undefined && typeof value.costNotes.shouldCallCodex !== "boolean" || value.costNotes.rationale !== undefined && typeof value.costNotes.rationale !== "string" || value.costNotes.estimatedInputTokens !== undefined && (!Number.isSafeInteger(value.costNotes.estimatedInputTokens) || (value.costNotes.estimatedInputTokens as number) < 0))) throw new Error("invalid result costNotes");
  if (value.modelPolicy !== undefined && (!isObject(value.modelPolicy) || !onlyKeys(value.modelPolicy, ["source", "model", "modelReasoningEffort"]) || !["explicit", "inherited"].includes(String(value.modelPolicy.source)) || value.modelPolicy.model !== undefined && typeof value.modelPolicy.model !== "string" || value.modelPolicy.modelReasoningEffort !== undefined && !["low", "medium", "high", "xhigh"].includes(String(value.modelPolicy.modelReasoningEffort)))) throw new Error("invalid result modelPolicy");
  if (value.error !== undefined && (!isObject(value.error) || !onlyKeys(value.error, ["code", "message", "data"]) || !errorCode(value.error.code) || typeof value.error.message !== "string" || value.error.data !== undefined && !isObject(value.error.data))) throw new Error("invalid result error");
  if (value.normalizedRequest !== undefined && !sidecarRequest(value.normalizedRequest)) throw new Error("invalid result normalizedRequest");
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function workflow(value: unknown): boolean { return ["review", "explore", "work", "opinion", "risk-check", "auditor", "generate"].includes(String(value)); }
function errorCode(value: unknown): boolean { return ["CONFIG_INVALID", "CONFIG_NOT_FOUND", "PRESET_NOT_FOUND", "SAFETY_REFUSAL", "APP_SERVER_UNIMPLEMENTED", "APP_SERVER_TIMEOUT", "APP_SERVER_CANCELLED", "AUTH_LEASE_BUSY", "PROTOCOL_ERROR", "WORKTREE_ERROR", "RUN_NOT_FOUND", "RUN_KEY_CONFLICT", "RUN_STORE_CORRUPT", "RUN_READY_TIMEOUT", "RUN_ORPHANED", "RUN_AUTH_UNCERTAIN", "RUN_UNSUPPORTED_PLATFORM", "RUN_INVALID_INPUT", "RUN_INTERNAL_ERROR"].includes(String(value)); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((v) => typeof v === "string"); }
function confidence(value: unknown): boolean { return isObject(value) && onlyKeys(value, ["level", "rationale"]) && ["low", "medium", "high", "unknown"].includes(String(value.level)) && (value.rationale === undefined || typeof value.rationale === "string"); }
function fileReference(value: unknown): boolean { return isObject(value) && onlyKeys(value, ["path", "line", "label"]) && typeof value.path === "string" && (value.line === undefined || Number.isSafeInteger(value.line) && (value.line as number) > 0) && (value.label === undefined || typeof value.label === "string"); }
function finding(value: unknown): boolean { return isObject(value) && onlyKeys(value, ["severity", "title", "detail", "evidence", "file", "line", "confidence", "basis"]) && ["critical", "high", "medium", "low"].includes(String(value.severity)) && typeof value.title === "string" && typeof value.detail === "string" && (value.evidence === undefined || typeof value.evidence === "string") && (value.file === undefined || typeof value.file === "string") && (value.line === undefined || Number.isSafeInteger(value.line) && (value.line as number) > 0) && confidence(value.confidence) && ["observed", "inferred", "hypothetical"].includes(String(value.basis)); }
function risk(value: unknown): boolean { return isObject(value) && onlyKeys(value, ["severity", "title", "detail", "affectedFiles", "suggestedVerification", "confidence", "basis"]) && ["critical", "high", "medium", "low"].includes(String(value.severity)) && typeof value.title === "string" && typeof value.detail === "string" && Array.isArray(value.affectedFiles) && value.affectedFiles.every(fileReference) && (value.suggestedVerification === undefined || typeof value.suggestedVerification === "string") && confidence(value.confidence) && ["observed", "inferred", "hypothetical"].includes(String(value.basis)); }
function testRecord(value: unknown): boolean { return isObject(value) && onlyKeys(value, ["command", "status", "summary"]) && typeof value.command === "string" && ["passed", "failed", "not-run"].includes(String(value.status)) && (value.summary === undefined || typeof value.summary === "string"); }
function sourceBoundary(value: unknown): boolean { return isObject(value) && onlyKeys(value, ["label", "source", "trust", "notes"]) && typeof value.label === "string" && typeof value.source === "string" && ["official", "unofficial", "local", "generated", "inferred", "unknown"].includes(String(value.trust)) && (value.notes === undefined || typeof value.notes === "string"); }
function sidecarRequest(value: unknown): boolean {
  if (!isObject(value) || !onlyKeys(value, ["workflow", "projectRoot", "prompt", "preset", "outputContract", "readonly", "requireWorktree", "focus", "allowedPaths", "denyPaths", "safetyProfile", "model", "modelReasoningEffort", "resultFormat", "turnTimeoutMs", "interruptOnTimeout", "preserveWorktree", "context", "dryRun"])) return false;
  return value.workflow === "work" && typeof value.projectRoot === "string" && typeof value.readonly === "boolean" && typeof value.requireWorktree === "boolean" && strings(value.focus) && strings(value.allowedPaths) && strings(value.denyPaths) && ["generic", "mcp-oauth-service", "claude-hook-package", "markdown-memory-repo", "python-mcp-service", "node-mcp-service", "dockerized-public-endpoint"].includes(String(value.safetyProfile)) && ["json", "json-with-prose"].includes(String(value.resultFormat)) && Number.isSafeInteger(value.turnTimeoutMs) && (value.turnTimeoutMs as number) > 0 && typeof value.interruptOnTimeout === "boolean" && typeof value.preserveWorktree === "boolean" && Array.isArray(value.context) && value.context.every(contextBlock) && typeof value.dryRun === "boolean" && ["prompt", "preset", "outputContract", "model"].every((key) => value[key] === undefined || typeof value[key] === "string") && (value.modelReasoningEffort === undefined || ["low", "medium", "high", "xhigh"].includes(String(value.modelReasoningEffort)));
}
function contextBlock(value: unknown): boolean { return isObject(value) && onlyKeys(value, ["kind", "source", "trust", "summary", "references", "data"]) && ["relay_entry", "throughline_handoff", "caveat_entry", "smartclaude_cost_hint", "codegraph_context", "manual_note"].includes(String(value.kind)) && typeof value.source === "string" && ["local", "user-provided", "project", "external"].includes(String(value.trust)) && typeof value.summary === "string" && (value.references === undefined || Array.isArray(value.references) && value.references.every(fileReference)); }

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function corrupt(message: string, error: unknown): RunStoreError {
  return new RunStoreError("RUN_STORE_CORRUPT", `${message}: ${error instanceof Error ? error.message : String(error)}`);
}
