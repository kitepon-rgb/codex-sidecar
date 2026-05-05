import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  buildAppServerCommand,
  buildInitializeDraft,
  buildThreadStartDraft,
  buildTurnStartDraft,
  type AppServerThreadStartResponse,
  type AppServerTurnStartResponse,
} from "./app-server.js";
import type { SidecarRequest } from "./types.js";

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
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onNotification?: (message: AppServerWireNotification) => void;
  onServerRequest?: (message: AppServerWireRequest) => void;
  onProtocolError?: (error: Error) => void;
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

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: AppServerClientOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onProtocolError = options.onProtocolError;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });
    child.once("error", (error) => {
      const protocolError = new Error(`PROTOCOL_ERROR: App Server process error: ${error.message}`);
      this.rejectAll(protocolError);
      this.rejectNotificationWaiters(protocolError);
    });
    child.once("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`PROTOCOL_ERROR: App Server exited before completing pending work: code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.rejectAll(error);
      this.rejectNotificationWaiters(error);
    });
  }

  static start(options: AppServerClientOptions = {}): AppServerClient {
    const defaultCommand = buildAppServerCommand();
    const command = options.command ?? defaultCommand.command;
    const args = options.args ?? defaultCommand.args;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new AppServerClient(child, options);
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
        reject(new AppServerProtocolError(`timeout waiting for ${method} response id=${id}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
    });

    this.child.stdin.write(encodeAppServerMessage(payload));
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || this.child.killed) {
      throw new AppServerProtocolError("cannot send notification because App Server is closed");
    }

    const payload = params === undefined ? { method } : { method, params };
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
      return;
    }

    this.closed = true;
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
        this.handleMessage(parseAppServerLine(line));
      } catch (error) {
        this.failProtocolError(error instanceof Error ? error : new AppServerProtocolError(String(error)));
        return;
      }
    }
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
