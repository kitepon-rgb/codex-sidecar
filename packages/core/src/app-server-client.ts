import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAppServerCommand,
  buildInitializeDraft,
  buildThreadStartDraft,
  buildTurnInterruptDraft,
  buildTurnStartDraft,
  type AppServerThreadStartResponse,
  type AppServerTurnStartResponse,
} from "./app-server.js";
import type { AppServerLogEntry } from "./app-server-logs.js";
import type { ModelReasoningEffort, SidecarRequest } from "./types.js";

export type AppServerRequestId = string | number;

export interface AppServerWireRequest {
  kind: "request";
  id: AppServerRequestId;
  method: string;
  params?: unknown;
  trace?: unknown;
}

export interface AppServerWireNotification {
  kind: "notification";
  method: string;
  params?: unknown;
}

export interface AppServerWireResponse<T = unknown> {
  kind: "response";
  id: AppServerRequestId;
  result: T;
}

export interface AppServerWireError {
  kind: "error";
  id: AppServerRequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type AppServerWireMessage<T = unknown> =
  | AppServerWireRequest
  | AppServerWireNotification
  | AppServerWireResponse<T>
  | AppServerWireError;

export interface AppServerInitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface AppServerClientOptions {
  command?: string;
  args?: string[];
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  isolateCodexHome?: boolean;
  requestTimeoutMs?: number;
  onNotification?: (message: AppServerWireNotification) => void;
  onServerRequest?: (message: AppServerWireRequest) => void;
  onProtocolError?: (error: Error) => void;
  onLogEntry?: (entry: Omit<AppServerLogEntry, "timestamp">) => void;
}

export interface IsolatedCodexHome {
  path: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

interface PendingRequest<T = unknown> {
  method: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingNotification {
  predicate: (message: AppServerWireNotification) => boolean;
  resolve: (value: AppServerWireNotification) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class AppServerProtocolError extends Error {
  constructor(message: string) {
    super(`PROTOCOL_ERROR: ${message}`);
  }
}

export class AppServerRequestError extends Error {
  constructor(
    readonly requestId: AppServerRequestId,
    readonly appServerError: AppServerWireError["error"],
  ) {
    super(`PROTOCOL_ERROR: App Server request ${String(requestId)} failed: ${appServerError.message}`);
  }
}

export class AppServerClient {
  readonly notifications: AppServerWireNotification[] = [];
  readonly serverRequests: AppServerWireRequest[] = [];

  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private readonly notificationWaiters = new Set<PendingNotification>();
  private readonly requestTimeoutMs: number;
  private readonly onNotification?: (message: AppServerWireNotification) => void;
  private readonly onServerRequest?: (message: AppServerWireRequest) => void;
  private readonly onProtocolError?: (error: Error) => void;
  private readonly onLogEntry?: (entry: Omit<AppServerLogEntry, "timestamp">) => void;
  private readonly cleanup?: () => void;
  private cleanupCalled = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: AppServerClientOptions,
    startup: { command: string; args: string[] },
    cleanup?: () => void,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onProtocolError = options.onProtocolError;
    this.onLogEntry = options.onLogEntry;
    this.cleanup = cleanup;

    this.log({
      category: "lifecycle",
      event: "process/start",
      data: {
        command: startup.command,
        args: startup.args,
        cwd: options.cwd,
        envProvided: options.env !== undefined,
      },
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      this.log({
        category: "stderr",
        event: "process/stderr",
        data: { chunk },
      });
    });
    child.once("error", (error) => {
      const protocolError = new Error(`PROTOCOL_ERROR: App Server process error: ${error.message}`);
      this.log({
        category: "diagnostic",
        event: "process/error",
        data: { message: protocolError.message },
      });
      this.rejectAll(protocolError);
      this.rejectNotificationWaiters(protocolError);
    });
    child.once("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`PROTOCOL_ERROR: App Server exited before completing pending work: code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.log({
        category: "lifecycle",
        event: "process/exit",
        data: { code, signal, pending: this.pending.size, message: error.message },
      });
      this.rejectAll(error);
      this.rejectNotificationWaiters(error);
    });
  }

  static start(options: AppServerClientOptions = {}): AppServerClient {
    const defaultCommand = buildAppServerCommand({
      model: options.model,
      modelReasoningEffort: options.modelReasoningEffort,
    });
    const command = options.command ?? defaultCommand.command;
    const args = options.args ?? defaultCommand.args;
    const isolated =
      options.env === undefined && options.isolateCodexHome !== false
        ? createIsolatedCodexHome()
        : undefined;
    const env = options.env ?? isolated?.env;
    const effectiveOptions = { ...options, env };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new AppServerClient(child, effectiveOptions, { command, args }, isolated?.cleanup);
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  async initialize(version = "0.0.0"): Promise<AppServerInitializeResult> {
    const draft = buildInitializeDraft(version);
    return this.request<AppServerInitializeResult>(draft.method, draft.params);
  }

  async startThread(request: SidecarRequest): Promise<AppServerThreadStartResponse> {
    const draft = buildThreadStartDraft(request);
    return this.request<AppServerThreadStartResponse>(draft.method, draft.params);
  }

  async startTurn(request: SidecarRequest, threadId: string): Promise<AppServerTurnStartResponse> {
    const draft = buildTurnStartDraft(request, threadId);
    return this.request<AppServerTurnStartResponse>(draft.method, draft.params);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Record<string, never>> {
    const draft = buildTurnInterruptDraft(threadId, turnId);
    return this.request<Record<string, never>>(draft.method, draft.params);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed || this.child.killed) {
      throw new AppServerProtocolError("cannot send request because App Server is closed");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload = params === undefined ? { id, method } : { id, method, params };

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log({
          category: "diagnostic",
          event: "request/timeout",
          direction: "outbound",
          data: { id, method, requestTimeoutMs: this.requestTimeoutMs },
        });
        reject(new AppServerProtocolError(`timeout waiting for ${method} response id=${id}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
    });

    this.log({
      category: "protocol",
      event: "request/send",
      direction: "outbound",
      data: payload,
    });
    this.child.stdin.write(encodeAppServerMessage(payload));
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || this.child.killed) {
      throw new AppServerProtocolError("cannot send notification because App Server is closed");
    }

    const payload = params === undefined ? { method } : { method, params };
    this.log({
      category: "protocol",
      event: "notification/send",
      direction: "outbound",
      data: payload,
    });
    this.child.stdin.write(encodeAppServerMessage(payload));
  }

  waitForNotification(
    predicate: (message: AppServerWireNotification) => boolean,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<AppServerWireNotification> {
    const existing = this.notifications.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    if (this.closed || this.child.killed) {
      throw new AppServerProtocolError("cannot wait for notification because App Server is closed");
    }

    return new Promise((resolve, reject) => {
      const waiter: PendingNotification = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new AppServerProtocolError("timeout waiting for App Server notification"));
        }, timeoutMs),
      };

      this.notificationWaiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      this.cleanupOnce();
      return;
    }

    this.closed = true;
    this.log({
      category: "lifecycle",
      event: "client/close",
      data: { pending: this.pending.size, notificationWaiters: this.notificationWaiters.size },
    });
    this.rejectAll(new AppServerProtocolError("App Server client closed before completing pending requests"));
    this.rejectNotificationWaiters(new AppServerProtocolError("App Server client closed before receiving pending notifications"));
    this.child.stdin.end();

    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }

    await Promise.race([
      once(this.child, "exit"),
      new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      }),
    ]);

    this.cleanupOnce();
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (line.trim() === "") {
        continue;
      }

      try {
        this.log({
          category: "protocol",
          event: "message/receive",
          direction: "inbound",
          data: { line },
        });
        this.handleMessage(parseAppServerLine(line));
      } catch (error) {
        const protocolError = error instanceof Error ? error : new AppServerProtocolError(String(error));
        this.log({
          category: "diagnostic",
          event: "message/parse-error",
          direction: "inbound",
          data: { line, message: protocolError.message },
        });
        this.failProtocolError(protocolError);
        return;
      }
    }
  }

  private cleanupOnce(): void {
    if (this.cleanupCalled) return;
    this.cleanupCalled = true;
    this.cleanup?.();
  }

  private handleMessage(message: AppServerWireMessage): void {
    if (message.kind === "notification") {
      this.notifications.push(message);
      this.onNotification?.(message);
      this.resolveNotificationWaiters(message);
      return;
    }

    if (message.kind === "request") {
      this.serverRequests.push(message);
      this.onServerRequest?.(message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      throw new AppServerProtocolError(`received response for unknown request id=${String(message.id)}`);
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.kind === "error") {
      pending.reject(new AppServerRequestError(message.id, message.error));
      return;
    }

    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(`${error.message}; pending=${pending.method} id=${String(id)}`));
    }
  }

  private failProtocolError(error: Error): void {
    this.onProtocolError?.(error);
    this.log({
      category: "diagnostic",
      event: "protocol/error",
      data: { message: error.message },
    });
    this.rejectAll(error);
    this.rejectNotificationWaiters(error);
    this.closed = true;

    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private resolveNotificationWaiters(message: AppServerWireNotification): void {
    for (const waiter of this.notificationWaiters) {
      if (!waiter.predicate(message)) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  private rejectNotificationWaiters(error: Error): void {
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private log(entry: Omit<AppServerLogEntry, "timestamp">): void {
    this.onLogEntry?.(entry);
  }
}

export function createIsolatedCodexHome(baseEnv: NodeJS.ProcessEnv = process.env): IsolatedCodexHome {
  const sourceHome = baseEnv.CODEX_HOME ?? join(homedir(), ".codex");
  const targetHome = mkdtempSync(join(tmpdir(), "codex-sidecar-home-"));
  chmodSync(targetHome, 0o700);

  const sourceAuth = join(sourceHome, "auth.json");
  const targetAuth = join(targetHome, "auth.json");
  copyIfExists(sourceAuth, targetAuth);
  // Snapshot the copied auth so cleanup can tell whether the App Server rotated it.
  const initialAuth = existsSync(targetAuth) ? readFileSync(targetAuth, "utf8") : undefined;
  copyIfExists(join(sourceHome, "installation_id"), join(targetHome, "installation_id"));
  writeFileSync(
    join(targetHome, "config.toml"),
    minimalCodexConfig(readOptional(join(sourceHome, "config.toml"))),
    "utf8",
  );

  return {
    path: targetHome,
    env: {
      ...baseEnv,
      CODEX_HOME: targetHome,
    },
    cleanup: () => {
      // ChatGPT-account tokens rotate on refresh: the App Server may rewrite
      // auth.json inside the isolated home during the run. If we only deleted the
      // temp home, that rotated refresh token would be lost and the canonical
      // auth.json would keep an already-used refresh token -> next run fails with
      // "refresh_token_reused" 401. Persist the rotated auth back to the source.
      persistRotatedAuth(sourceAuth, targetAuth, initialAuth);
      rmSync(targetHome, { recursive: true, force: true });
    },
  };
}

function persistRotatedAuth(sourceAuth: string, targetAuth: string, initialAuth: string | undefined): void {
  try {
    if (!existsSync(targetAuth)) return;
    const finalAuth = readFileSync(targetAuth, "utf8");
    if (!finalAuth || finalAuth === initialAuth) return;
    // Atomic replace so a partial write is never observed as the canonical auth.json.
    const tmp = `${sourceAuth}.codex-sidecar.tmp`;
    writeFileSync(tmp, finalAuth, { mode: 0o600 });
    renameSync(tmp, sourceAuth);
  } catch (error) {
    // Best-effort recovery: a failed write-back is not fatal (the next run still
    // has the prior token, recoverable via `codex login`). Surface, don't swallow.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[codex-sidecar] failed to persist rotated auth back to ${sourceAuth}: ${message}\n`);
  }
}

function copyIfExists(from: string, to: string): void {
  if (existsSync(from)) copyFileSync(from, to);
}

function readOptional(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function minimalCodexConfig(source: string): string {
  let inTable = false;
  const passthrough = source.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (/^(?:\[\[.*\]\]|\[.*\])(?:\s*#.*)?$/.test(trimmed)) {
      inTable = true;
      return false;
    }
    return !inTable && /^(?:model|model_provider|model_reasoning_effort|model_context_window|model_auto_compact_token_limit)\s*=/.test(trimmed);
  });
  return `${passthrough.join("\n")}${passthrough.length > 0 ? "\n" : ""}`;
}

export function encodeAppServerMessage(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseAppServerLine(line: string): AppServerWireMessage {
  const trimmed = line.trim();

  if (trimmed === "") {
    throw new AppServerProtocolError("empty App Server line");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppServerProtocolError(`invalid JSON line: ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new AppServerProtocolError("App Server line must decode to an object");
  }

  if ("error" in parsed && "id" in parsed) {
    const error = parsed.error;
    if (!isRequestId(parsed.id) || !isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") {
      throw new AppServerProtocolError("invalid App Server error response");
    }

    return {
      kind: "error",
      id: parsed.id,
      error: {
        code: error.code,
        message: error.message,
        data: error.data,
      },
    };
  }

  if ("result" in parsed && "id" in parsed) {
    if (!isRequestId(parsed.id)) {
      throw new AppServerProtocolError("invalid App Server response id");
    }

    return {
      kind: "response",
      id: parsed.id,
      result: parsed.result,
    };
  }

  if ("method" in parsed && typeof parsed.method === "string") {
    if ("id" in parsed) {
      if (!isRequestId(parsed.id)) {
        throw new AppServerProtocolError("invalid App Server request id");
      }

      return {
        kind: "request",
        id: parsed.id,
        method: parsed.method,
        params: parsed.params,
        trace: parsed.trace,
      };
    }

    return {
      kind: "notification",
      method: parsed.method,
      params: parsed.params,
    };
  }

  throw new AppServerProtocolError("unrecognized App Server message shape");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is AppServerRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}
