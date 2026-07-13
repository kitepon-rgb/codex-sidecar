import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

const SCHEMA_VERSION = "2" as const;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const IO_TIMEOUT_MS = 2_000;
const MAX_OBSERVATIONS = 1_024;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_PRODUCT_VERSION_LENGTH = 128;
const MAX_CAPTURE_QUEUE = 64;
const RECONCILIATION_BUDGET_MS = 250;
const TRANSIENT_RECEIPT_RETENTION_MS = 30_000;

export type FactoryErrorStatus = "open" | "resolved";
export type FactoryErrorSeverity = "fatal" | "high" | "warn" | "info";

export interface FactoryErrorRecord {
  product_version: string;
  component: string;
  error_code: string;
  message_template: string;
  severity: FactoryErrorSeverity;
  fingerprint: string;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  state_schema_version: typeof SCHEMA_VERSION;
  os: string;
  arch: string;
  status: FactoryErrorStatus;
  resolved_at: string | null;
  reason_code: "operator_resolved" | null;
  sequence: number;
}

interface FactoryErrorStore {
  schema_version: typeof SCHEMA_VERSION;
  product: "codex-sidecar";
  next_sequence: number;
  acknowledged_through: number;
  records: FactoryErrorRecord[];
  observations: Array<{ id: string; fingerprint: string; sequence: number; transient: boolean; created_at: string }>;
}

export interface FactoryErrorSnapshot {
  schema_version: typeof SCHEMA_VERSION;
  cursor: number;
  acknowledged_through: number;
  records: FactoryErrorRecord[];
}

export interface FactoryErrorStoreOptions {
  configPath?: string;
  storePath?: string;
  now?: () => Date;
  productVersion?: string;
  /** @internal Opaque SHA-256 idempotency key for durable failure reconciliation. */
  observationId?: string;
}

export interface FactoryErrorStoreDiagnostics {
  schemaVersion: typeof SCHEMA_VERSION;
  collection: "enabled" | "disabled" | "unverified";
  store: "ready" | "absent" | "unverified";
  pending: number;
}

const DEFINITIONS = {
  CONFIG_INVALID: ["config", "Sidecar configuration is invalid", "high"],
  PRESET_NOT_FOUND: ["config", "Configured Sidecar preset is unavailable", "high"],
  APP_SERVER_UNIMPLEMENTED: ["app-server", "Codex App Server integration is unavailable", "high"],
  APP_SERVER_TIMEOUT: ["app-server", "Codex App Server request timed out", "high"],
  PROTOCOL_ERROR: ["app-server", "Codex App Server protocol contract failed", "high"],
  WORKTREE_ERROR: ["worktree", "Isolated worktree operation failed", "high"],
  RUN_KEY_CONFLICT: ["run-store", "Durable run identity conflicts with stored input", "high"],
  RUN_STORE_CORRUPT: ["run-store", "Durable run store is corrupt", "fatal"],
  RUN_READY_TIMEOUT: ["run-worker", "Durable run worker did not become ready", "high"],
  RUN_ORPHANED: ["run-worker", "Durable run worker became orphaned", "high"],
  RUN_AUTH_UNCERTAIN: ["auth", "Durable authentication state is uncertain", "high"],
  RUN_INTERNAL_ERROR: ["run-worker", "Durable run failed internally", "fatal"],
} as const satisfies Record<string, readonly [string, string, FactoryErrorSeverity]>;

export type CapturableSidecarErrorCode = keyof typeof DEFINITIONS;

let diagnosticEmitted = false;
let queuedCaptures = 0;
let captureTail: Promise<void> = Promise.resolve();

type OwnedFactoryErrorStoreOptions = FactoryErrorStoreOptions & {
  /** @internal Parent-generated receipts are only for timeout reconciliation. */
  transientObservation?: boolean;
};

export async function captureSidecarRuntimeError(
  errorCode: string,
  options: FactoryErrorStoreOptions = {},
): Promise<{ status: "recorded" | "disabled" | "ignored" | "failed"; fingerprint?: string }> {
  try {
    const deadline = Date.now() + IO_TIMEOUT_MS;
    const fixedNow = options.now?.();
    if (Date.now() >= deadline) throw new Error("factory error capture deadline expired");
    const observationId = options.observationId ?? randomBytes(32).toString("hex");
    const normalized: OwnedFactoryErrorStoreOptions = {
      ...options,
      ...(fixedNow === undefined ? {} : { now: () => fixedNow }),
      observationId,
      transientObservation: options.observationId === undefined,
    };
    return await withAbsoluteDeadline(captureInBoundedWorkerQueue(errorCode, normalized, deadline), deadline);
  } catch {
    emitStoreFailure();
    return { status: "failed" };
  }
}

export async function captureDurableSidecarRuntimeError(runIdentity: string, errorCode: string): Promise<void> {
  if (!Object.hasOwn(DEFINITIONS, errorCode)) return;
  const observationId = createHash("sha256")
    .update(`codex-sidecar-durable\0${runIdentity}\0${errorCode}`)
    .digest("hex");
  await captureSidecarRuntimeError(errorCode, { observationId });
}

export async function captureSidecarRuntimeErrorOwned(
  errorCode: string,
  options: OwnedFactoryErrorStoreOptions,
): Promise<{ status: "recorded" | "disabled" | "ignored" | "failed"; fingerprint?: string }> {
  if (!Object.hasOwn(DEFINITIONS, errorCode)) return { status: "ignored" };
  const collection = await readCollectionState(options.configPath);
  if (collection !== "enabled") return { status: "disabled" };
  try {
    const definition = DEFINITIONS[errorCode as CapturableSidecarErrorCode];
    const productVersion = options.productVersion ?? await readProductVersion();
    assertProductVersion(productVersion);
    const fingerprint = createHash("sha256")
      .update(`codex-sidecar\0${definition[0]}\0${errorCode}\0${definition[1]}`)
      .digest("hex");
    await mutateStore(options, (store) => {
      const now = (options.now ?? (() => new Date()))().toISOString();
      const receiptNow = new Date().toISOString();
      store.observations = store.observations.filter((entry) =>
        !entry.transient || Date.parse(entry.created_at) >= Date.now() - TRANSIENT_RECEIPT_RETENTION_MS);
      if (options.observationId) {
        assertFingerprint(options.observationId);
        if (store.observations.some((entry) => entry.id === options.observationId)) return;
        if (store.observations.length >= MAX_OBSERVATIONS) throw new Error("factory error observation ledger is full");
      }
      const existing = store.records.find((record) => record.fingerprint === fingerprint);
      const sequence = store.next_sequence++;
      if (existing) {
        existing.occurrence_count += 1;
        existing.last_seen = now;
        existing.status = "open";
        existing.resolved_at = null;
        existing.reason_code = null;
        existing.sequence = sequence;
      } else {
        store.records.push({
          product_version: productVersion,
          component: definition[0],
          error_code: errorCode,
          message_template: definition[1],
          severity: definition[2],
          fingerprint,
          occurrence_count: 1,
          first_seen: now,
          last_seen: now,
          state_schema_version: SCHEMA_VERSION,
          os: platform(),
          arch: arch(),
          status: "open",
          resolved_at: null,
          reason_code: null,
          sequence,
        });
      }
      if (options.observationId) store.observations.push({
        id: options.observationId,
        fingerprint,
        sequence,
        transient: options.transientObservation === true,
        created_at: receiptNow,
      });
    });
    return { status: "recorded", fingerprint };
  } catch {
    emitStoreFailure();
    return { status: "failed" };
  }
}

export async function resolveSidecarRuntimeError(
  fingerprint: string,
  options: FactoryErrorStoreOptions = {},
): Promise<boolean> {
  assertFingerprint(fingerprint);
  let changed = false;
  await mutateStore(options, (store) => {
    const record = store.records.find((candidate) => candidate.fingerprint === fingerprint);
    if (!record || record.status === "resolved") return;
    record.status = "resolved";
    record.resolved_at = (options.now ?? (() => new Date()))().toISOString();
    record.reason_code = "operator_resolved";
    record.sequence = store.next_sequence++;
    changed = true;
  });
  return changed;
}

export async function reopenSidecarRuntimeError(
  fingerprint: string,
  options: FactoryErrorStoreOptions = {},
): Promise<boolean> {
  assertFingerprint(fingerprint);
  let changed = false;
  await mutateStore(options, (store) => {
    const record = store.records.find((candidate) => candidate.fingerprint === fingerprint);
    if (!record || record.status === "open") return;
    record.status = "open";
    record.resolved_at = null;
    record.reason_code = null;
    record.sequence = store.next_sequence++;
    changed = true;
  });
  return changed;
}

export async function readSidecarRuntimeErrors(
  options: FactoryErrorStoreOptions = {},
): Promise<FactoryErrorSnapshot> {
  const store = await readStore(options.storePath ?? defaultStorePath(), true);
  return {
    schema_version: SCHEMA_VERSION,
    cursor: store.next_sequence - 1,
    acknowledged_through: store.acknowledged_through,
    records: structuredClone(store.records),
  };
}

export async function acknowledgeSidecarRuntimeErrors(
  cursor: number,
  options: FactoryErrorStoreOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("cursor must be a non-negative safe integer");
  await mutateStore(options, (store) => {
    if (cursor > store.next_sequence - 1) throw new RangeError("cursor is newer than the store");
    store.acknowledged_through = Math.max(store.acknowledged_through, cursor);
  });
}

export async function compactSidecarRuntimeErrors(
  options: FactoryErrorStoreOptions & { retentionMs?: number } = {},
): Promise<number> {
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new TypeError("retentionMs must be a non-negative safe integer");
  let removed = 0;
  await mutateStore(options, (store) => {
    const cutoff = (options.now ?? (() => new Date()))().getTime() - retentionMs;
    const retained = store.records.filter((record) => {
      const removable = record.status === "resolved" &&
        record.sequence <= store.acknowledged_through &&
        Date.parse(record.last_seen) <= cutoff;
      if (removable) removed += 1;
      return !removable;
    });
    store.records = retained;
    const retainedFingerprints = new Set(retained.map((record) => record.fingerprint));
    store.observations = store.observations.filter((entry) => retainedFingerprints.has(entry.fingerprint));
  });
  return removed;
}

export async function inspectSidecarRuntimeErrorStore(
  options: FactoryErrorStoreOptions = {},
): Promise<FactoryErrorStoreDiagnostics> {
  const collection = await readCollectionState(options.configPath);
  const storePath = options.storePath ?? defaultStorePath();
  try {
    const store = await readStore(storePath, false);
    if (!store) return { schemaVersion: SCHEMA_VERSION, collection, store: "absent", pending: 0 };
    return {
      schemaVersion: SCHEMA_VERSION,
      collection,
      store: "ready",
      pending: store.records.filter((record) => record.sequence > store.acknowledged_through).length,
    };
  } catch {
    return { schemaVersion: SCHEMA_VERSION, collection, store: "unverified", pending: 0 };
  }
}

async function mutateStore(options: FactoryErrorStoreOptions, mutate: (store: FactoryErrorStore) => void): Promise<void> {
  const storePath = options.storePath ?? defaultStorePath();
  await ensurePrivateDirectory(dirname(storePath));
  await withLock(`${storePath}.lock.sqlite`, async () => {
    const store = await readStore(storePath, true);
    mutate(store);
    validateStore(store);
    await atomicWrite(storePath, store);
  });
}

async function readCollectionState(configPath = defaultConfigPath()): Promise<"enabled" | "disabled" | "unverified"> {
  try {
    const value = JSON.parse(await readRegularUtf8(configPath)) as unknown;
    if (!isFactoryReporterConfig(value)) return "unverified";
    return value.collection.enabled ? "enabled" : "disabled";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "disabled" : "unverified";
  }
}

async function readProductVersion(): Promise<string> {
  const value = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as unknown;
  if (!isRecord(value) || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version)) {
    throw new Error("invalid package version");
  }
  return value.version;
}

async function readStore(path: string, absentAsEmpty: true): Promise<FactoryErrorStore>;
async function readStore(path: string, absentAsEmpty: false): Promise<FactoryErrorStore | undefined>;
async function readStore(path: string, absentAsEmpty: boolean): Promise<FactoryErrorStore | undefined> {
  try {
    await assertPrivateDirectory(dirname(path));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe store file");
    await assertPrivateFile(path, info);
    const bytes = await withTimeout(readFile(path, "utf8"), IO_TIMEOUT_MS);
    if (Buffer.byteLength(bytes, "utf8") > MAX_STORE_BYTES) throw new Error("factory error store exceeds size limit");
    const store = migrateLegacyStore(JSON.parse(bytes) as unknown);
    validateStore(store);
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && absentAsEmpty) return emptyStore();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function emptyStore(): FactoryErrorStore {
  return { schema_version: SCHEMA_VERSION, product: "codex-sidecar", next_sequence: 1, acknowledged_through: 0, records: [], observations: [] };
}

function migrateLegacyStore(value: unknown): FactoryErrorStore {
  if (!isRecord(value) || value.schema_version !== "1") return value as FactoryErrorStore;
  if (!exactKeys(value, ["schema_version", "product", "next_sequence", "acknowledged_through", "records", "observations"])
    || value.product !== "codex-sidecar" || !Number.isSafeInteger(value.next_sequence)
    || !Array.isArray(value.records) || !Array.isArray(value.observations)) {
    throw new Error("invalid legacy factory error store");
  }
  const legacyKeys = [
    "arch", "component", "error_code", "fingerprint", "first_seen", "last_seen", "message_template", "occurrence_count",
    "os", "product_version", "sequence", "severity", "state_schema_version", "status",
  ];
  let nextSequence = value.next_sequence as number;
  const records = value.records.map((record) => {
    if (!isRecord(record) || !exactKeys(record, legacyKeys) || record.state_schema_version !== "1") {
      throw new Error("invalid legacy factory error record");
    }
    const wasResolved = record.status === "resolved";
    return {
      ...record,
      state_schema_version: SCHEMA_VERSION,
      status: wasResolved ? "open" : record.status,
      resolved_at: null,
      reason_code: null,
      sequence: wasResolved ? nextSequence++ : record.sequence,
    } as FactoryErrorRecord;
  });
  return {
    schema_version: SCHEMA_VERSION,
    product: "codex-sidecar",
    next_sequence: nextSequence,
    acknowledged_through: value.acknowledged_through as number,
    records,
    observations: value.observations as FactoryErrorStore["observations"],
  };
}

function validateStore(value: FactoryErrorStore): void {
  if (!isRecord(value) || !exactKeys(value as unknown as Record<string, unknown>, ["schema_version", "product", "next_sequence", "acknowledged_through", "records", "observations"]) ||
      value.schema_version !== SCHEMA_VERSION || value.product !== "codex-sidecar" ||
      !Number.isSafeInteger(value.next_sequence) || value.next_sequence < 1 ||
      !Number.isSafeInteger(value.acknowledged_through) || value.acknowledged_through < 0 ||
      value.acknowledged_through >= value.next_sequence ||
      !Array.isArray(value.records) || !Array.isArray(value.observations) || value.observations.length > MAX_OBSERVATIONS) throw new Error("invalid factory error store");
  const fingerprints = new Set<string>();
  const sequences = new Set<number>();
  for (const record of value.records) {
    if (!isRecord(record) || Object.keys(record).sort().join(",") !== [
      "arch", "component", "error_code", "fingerprint", "first_seen", "last_seen", "message_template", "occurrence_count",
      "os", "product_version", "reason_code", "resolved_at", "sequence", "severity", "state_schema_version", "status",
    ].sort().join(",") || !Object.hasOwn(DEFINITIONS, String(record.error_code)) ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence >= value.next_sequence ||
      !Number.isSafeInteger(record.occurrence_count) || record.occurrence_count < 1 ||
      !["open", "resolved"].includes(String(record.status))) throw new Error("invalid factory error record");
    const definition = DEFINITIONS[record.error_code as CapturableSidecarErrorCode];
    const expectedFingerprint = createHash("sha256")
      .update(`codex-sidecar\0${definition[0]}\0${record.error_code}\0${definition[1]}`)
      .digest("hex");
    if (record.component !== definition[0] || record.message_template !== definition[1] ||
        record.severity !== definition[2] || record.fingerprint !== expectedFingerprint ||
        record.state_schema_version !== SCHEMA_VERSION ||
        typeof record.product_version !== "string" || record.product_version.length > MAX_PRODUCT_VERSION_LENGTH || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(record.product_version) ||
        typeof record.os !== "string" || !/^[a-z0-9_-]{1,32}$/.test(record.os) ||
        typeof record.arch !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(record.arch) ||
        !isCanonicalUtc(record.first_seen) || !isCanonicalUtc(record.last_seen) ||
        Date.parse(record.first_seen) > Date.parse(record.last_seen) ||
        (record.status === "open" && (record.resolved_at !== null || record.reason_code !== null)) ||
        (record.status === "resolved" && (!isCanonicalUtc(record.resolved_at)
          || Date.parse(record.resolved_at) < Date.parse(record.last_seen)
          || record.reason_code !== "operator_resolved")) ||
        fingerprints.has(record.fingerprint) || sequences.has(record.sequence)) {
      throw new Error("invalid factory error record");
    }
    fingerprints.add(record.fingerprint);
    sequences.add(record.sequence);
  }
  const observationIds = new Set<string>();
  for (const observation of value.observations) {
    if (!isRecord(observation) || !exactKeys(observation, ["id", "fingerprint", "sequence", "transient", "created_at"]) ||
        typeof observation.id !== "string" || !/^[a-f0-9]{64}$/.test(observation.id) ||
        typeof observation.fingerprint !== "string" || !fingerprints.has(observation.fingerprint) ||
        !Number.isSafeInteger(observation.sequence) || observation.sequence < 1 || observation.sequence >= value.next_sequence ||
        typeof observation.transient !== "boolean" || !isCanonicalUtc(observation.created_at) ||
        observationIds.has(observation.id)) throw new Error("invalid factory error observation");
    observationIds.add(observation.id);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe store directory");
  if (platform() !== "win32") await chmod(path, DIR_MODE);
  else await applyAndVerifyWindowsAcl(path, true);
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe store directory");
  if (platform() === "win32") await verifyWindowsAcl(path, true);
  else assertPosixOwnershipAndMode(info, DIR_MODE);
}

async function assertPrivateFile(path: string, providedInfo?: Stats): Promise<void> {
  const info = providedInfo ?? await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe store file");
  if (platform() === "win32") await verifyWindowsAcl(path, false);
  else assertPosixOwnershipAndMode(info, FILE_MODE);
}

async function atomicWrite(path: string, value: FactoryErrorStore): Promise<void> {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_STORE_BYTES) throw new Error("factory error store exceeds size limit");
  const temporary = join(dirname(path), `.factory-errors-${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (platform() !== "win32") await chmod(temporary, FILE_MODE);
    else await applyAndVerifyWindowsAcl(temporary, false);
    await rename(temporary, path);
    await assertPrivateFile(path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  try {
    const info = await lstat(path);
    await assertPrivateFile(path, info);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const database = new DatabaseSync(path);
  let active = false;
  try {
    if (platform() === "win32") await applyAndVerifyWindowsAcl(path, false);
    else await chmod(path, FILE_MODE);
    await assertPrivateFile(path);
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=750; BEGIN IMMEDIATE");
    active = true;
    const result = await operation();
    database.exec("COMMIT");
    active = false;
    return result;
  } finally {
    if (active) { try { database.exec("ROLLBACK"); } catch {} }
    database.close();
  }
}

function defaultConfigPath(): string {
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dotagents", "factory-reporter", "config.json");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dotagents", "factory-reporter.json");
}

function defaultStorePath(): string {
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "codex-sidecar", "factory-runtime-errors-v1.json");
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "codex-sidecar", "factory-runtime-errors-v1.json");
}

function assertFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("fingerprint must be lowercase SHA-256");
}

function emitStoreFailure(): void {
  if (diagnosticEmitted) return;
  diagnosticEmitted = true;
  process.stderr.write("[codex-sidecar:factory-error-store] local structured error store unavailable\n");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFactoryReporterConfig(value: unknown): value is {
  schema_version: "1.0";
  host: { id: string; profile: string };
  collection: { enabled: boolean };
  reporting: { enabled: boolean; endpoint?: string; credential_file?: string };
} {
  if (!isRecord(value) || exactKeys(value, ["schema_version", "host", "collection", "reporting"]) === false || value.schema_version !== "1.0") return false;
  if (!isRecord(value.host) || !exactKeys(value.host, ["id", "profile"]) ||
      typeof value.host.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.host.id) ||
      !["server", "mac", "wsl", "windows-native"].includes(String(value.host.profile))) return false;
  if (!isRecord(value.collection) || !exactKeys(value.collection, ["enabled"]) || typeof value.collection.enabled !== "boolean") return false;
  if (!isRecord(value.reporting) || !exactKeys(value.reporting, ["enabled", "endpoint", "credential_file"], true) || typeof value.reporting.enabled !== "boolean") return false;
  if (value.reporting.endpoint !== undefined) {
    if (typeof value.reporting.endpoint !== "string" || value.reporting.endpoint.length > 2048) return false;
    try {
      const endpoint = new URL(value.reporting.endpoint);
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return false;
    } catch { return false; }
  }
  if (value.reporting.credential_file !== undefined &&
      (typeof value.reporting.credential_file !== "string" || value.reporting.credential_file.length < 1 || value.reporting.credential_file.length > 4096)) return false;
  if (value.reporting.enabled && (value.reporting.endpoint === undefined || value.reporting.credential_file === undefined)) return false;
  return true;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional = false): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(required);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!optional && required.some((key) => !keys.includes(key))) return false;
  if (optional && !keys.includes("enabled")) return false;
  return true;
}

async function readRegularUtf8(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe configuration file");
  return withTimeout(readFile(path, "utf8"), IO_TIMEOUT_MS);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("factory error store I/O timed out")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function captureInIsolatedWorker(
  errorCode: string,
  options: OwnedFactoryErrorStoreOptions,
  deadline: number,
): Promise<{ status: "recorded" | "disabled" | "ignored" | "failed"; fingerprint?: string }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("factory error capture deadline expired");
  const nowIso = options.now?.().toISOString();
  const workerOptions = {
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.storePath === undefined ? {} : { storePath: options.storePath }),
    ...(options.productVersion === undefined ? {} : { productVersion: options.productVersion }),
    ...(options.observationId === undefined ? {} : { observationId: options.observationId }),
    ...(options.transientObservation === undefined ? {} : { transientObservation: options.transientObservation }),
    ...(nowIso === undefined ? {} : { nowIso }),
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./factory-error-store-worker.js", import.meta.url), {
      workerData: { errorCode, options: workerOptions },
    });
    worker.unref();
    let settled = false;
    const operationRemaining = deadline - Date.now() - RECONCILIATION_BUDGET_MS;
    if (operationRemaining <= 0) {
      settled = true;
      void worker.terminate();
      reject(new Error("factory error capture deadline expired"));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate().then(async () => {
        const receipt = await committedObservation(options.storePath ?? defaultStorePath(), options.observationId!);
        if (receipt) resolve({ status: "recorded", fingerprint: receipt });
        else reject(new Error("factory error worker timed out before commit"));
      }, reject);
    }, operationRemaining);
    worker.once("message", (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().finally(() => resolve(value as Awaited<ReturnType<typeof captureSidecarRuntimeErrorOwned>>));
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`factory error worker exited ${code}`));
    });
  });
}

async function withAbsoluteDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("factory error capture deadline expired");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("factory error capture deadline expired")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function captureInBoundedWorkerQueue(
  errorCode: string,
  options: OwnedFactoryErrorStoreOptions,
  deadline: number,
): Promise<{ status: "recorded" | "disabled" | "ignored" | "failed"; fingerprint?: string }> {
  if (queuedCaptures >= MAX_CAPTURE_QUEUE) throw new Error("factory error capture queue is full");
  queuedCaptures += 1;
  const rawRun = captureTail.then(
    () => captureInIsolatedWorker(errorCode, options, deadline),
    () => captureInIsolatedWorker(errorCode, options, deadline),
  );
  const run = withAbsoluteDeadline(rawRun, deadline);
  captureTail = run.then(() => undefined, () => undefined);
  try {
    return await run;
  } finally {
    queuedCaptures -= 1;
  }
}

async function committedObservation(storePath: string, observationId: string): Promise<string | undefined> {
  try {
    const store = await readStore(storePath, false);
    return store?.observations.find((entry) => entry.id === observationId)?.fingerprint;
  } catch {
    return undefined;
  }
}

function assertProductVersion(value: string): void {
  if (value.length > MAX_PRODUCT_VERSION_LENGTH || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("invalid product version");
  }
}

function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertPosixOwnershipAndMode(info: Stats, expectedMode: number): void {
  if ((info.mode & 0o777) !== expectedMode) throw new Error("unsafe store permissions");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("unsafe store owner");
}

async function applyAndVerifyWindowsAcl(path: string, directory: boolean): Promise<void> {
  await runWindowsAclScript(path, directory, true);
}

async function verifyWindowsAcl(path: string, directory: boolean): Promise<void> {
  await runWindowsAclScript(path, directory, false);
}

async function runWindowsAclScript(path: string, directory: boolean, apply: boolean): Promise<void> {
  const script = apply ? WINDOWS_ACL_APPLY_SCRIPT : WINDOWS_ACL_VERIFY_SCRIPT;
  await runBoundedChild("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], false, {
    ...process.env, FACTORY_ACL_PATH: path, FACTORY_ACL_DIRECTORY: directory ? "1" : "0",
  });
}

async function runBoundedChild(command: string, args: string[], capture: boolean, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore", windowsHide: true });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; if (stdout.length > 512) child.kill(); });
    const timer = setTimeout(() => child.kill(), Math.floor(IO_TIMEOUT_MS / 2));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !signal && stdout.length <= 512) resolve(stdout.trim());
      else reject(new Error("bounded child process failed"));
    });
  });
}

const WINDOWS_ACL_VERIFY_SCRIPT = String.raw`
$p=$env:FACTORY_ACL_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=Get-Acl -LiteralPath $p
$owner=(New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid){exit 41}; $rules=@($acl.Access); if($rules.Count -ne 1){exit 42}
$r=$rules[0]; if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid -or $r.AccessControlType -ne 'Allow' -or ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){exit 43}
`;

const WINDOWS_ACL_APPLY_SCRIPT = String.raw`
$p=$env:FACTORY_ACL_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){$acl.RemoveAccessRuleAll($r)}
$flags=if($env:FACTORY_ACL_DIRECTORY -eq '1'){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.SetOwner($sid); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl
` + WINDOWS_ACL_VERIFY_SCRIPT;
