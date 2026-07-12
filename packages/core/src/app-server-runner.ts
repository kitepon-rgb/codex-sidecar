import type { AppServerThreadStartResponse, AppServerTurnStartResponse } from "./app-server.js";
import { AppServerClient, type AppServerClientOptions, type AppServerInitializeResult, type AppServerWireNotification } from "./app-server-client.js";
import { collectAgentMessageText, findTurnCompletion } from "./app-server-events.js";
import { createAppServerEventLogger, type AppServerEventLogger } from "./app-server-logs.js";
import { buildGenerateResult } from "./generate.js";
import { errorResult, modelPolicyInfo, toSidecarError } from "./results.js";
import { buildDegradedResult, mergeStructuredOutput, parseStructuredSidecarOutput } from "./structured-output.js";
import type { SidecarRequest, SidecarResult } from "./types.js";
import { createDurableAuthSession, type DurableAuthSession } from "./durable-auth-session.js";

export interface AppServerSessionClient {
  readonly notifications: AppServerWireNotification[];
  readonly stderr?: string;
  initialize(version?: string): Promise<AppServerInitializeResult>;
  startThread(request: SidecarRequest): Promise<AppServerThreadStartResponse>;
  startTurn(request: SidecarRequest, threadId: string): Promise<AppServerTurnStartResponse>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  waitForNotification(
    predicate: (message: AppServerWireNotification) => boolean,
    timeoutMs?: number,
  ): Promise<AppServerWireNotification>;
  close?(): Promise<void>;
}

export interface AppServerRunOptions {
  client?: AppServerSessionClient;
  eventLogDir?: string;
  version?: string;
  turnTimeoutMs?: number;
  allowWorkWorkflow?: boolean;
  authCacheRoot?: string;
  authBaseEnv?: NodeJS.ProcessEnv;
  /** @internal deterministic process seam; durable auth still wraps this factory. */
  clientFactory?: (options: AppServerClientOptions) => AppServerSessionClient;
}

export async function runReadOnlyAppServerRequest(
  request: SidecarRequest,
  options: AppServerRunOptions = {},
): Promise<SidecarResult> {
  if ((!request.readonly || request.workflow === "work") && options.allowWorkWorkflow !== true) {
    return errorResult(
      request,
      toSidecarError(new Error("APP_SERVER_UNIMPLEMENTED: write-capable App Server execution is not wired yet")),
    );
  }

  let logger: AppServerEventLogger | undefined;
  let client: AppServerSessionClient | undefined;
  let ownsClient = false;
  let authSession: DurableAuthSession | undefined;

  try {
    logger = await createAppServerEventLogger(request, { logDir: options.eventLogDir });
    logger.write({
      category: "lifecycle",
      event: "run/start",
      data: {
        workflow: request.workflow,
        projectRoot: request.projectRoot,
        readonly: request.readonly,
        resultFormat: request.resultFormat,
        model: request.model,
        modelReasoningEffort: request.modelReasoningEffort,
        modelPolicySource: request.model || request.modelReasoningEffort ? "explicit" : "inherited",
        turnTimeoutMs: request.turnTimeoutMs,
        interruptOnTimeout: request.interruptOnTimeout,
      },
    });

    if (options.client === undefined) {
      authSession = await createDurableAuthSession({ ownerKind: "sync-session", cacheRoot: options.authCacheRoot, baseEnv: options.authBaseEnv });
      await authSession.markAppServerStarted();
    }
    client =
      options.client ??
      (options.clientFactory ?? AppServerClient.start)({
        model: request.model,
        modelReasoningEffort: request.modelReasoningEffort,
        env: authSession?.env,
        onLogEntry: (entry) => logger?.write(entry),
      });
    ownsClient = options.client === undefined;

    logger.write({ category: "lifecycle", event: "initialize/start" });
    await client.initialize(options.version ?? "0.0.0");
    logger.write({ category: "lifecycle", event: "initialize/complete" });

    logger.write({ category: "lifecycle", event: "thread/start" });
    const threadResponse = await client.startThread(request);
    const threadId = threadResponse.thread.id;
    logger.write({
      category: "lifecycle",
      event: "thread/complete",
      data: { threadId, status: threadResponse.thread.status },
    });

    logger.write({
      category: "lifecycle",
      event: "turn/start",
      data: { threadId },
    });
    const turnResponse = await client.startTurn(request, threadId);
    const turnId = turnResponse.turn.id;
    const filter = { threadId, turnId };
    logger.write({
      category: "lifecycle",
      event: "turn/started",
      data: { threadId, turnId, status: turnResponse.turn.status },
    });

    const turnTimeoutMs = options.turnTimeoutMs ?? request.turnTimeoutMs;
    logger.write({
      category: "lifecycle",
      event: "turn/wait-completion",
      data: { threadId, turnId, turnTimeoutMs },
    });

    try {
      await client.waitForNotification(
        (notification) => findTurnCompletion([notification], filter) !== undefined,
        turnTimeoutMs,
      );
    } catch (error) {
      logger.write({
        category: "diagnostic",
        event: "turn/timeout-or-wait-error",
        data: {
          threadId,
          turnId,
          turnTimeoutMs,
          interruptOnTimeout: request.interruptOnTimeout,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      if (request.interruptOnTimeout) {
        await interruptTurnAfterTimeout(client, logger, threadId, turnId);
      }
      throw new Error(`APP_SERVER_TIMEOUT: App Server turn timed out after ${turnTimeoutMs}ms for thread=${threadId} turn=${turnId}`);
    }

    // Persist any atomic auth rotation while this coordinator still owns the
    // App Server handle. A later abnormal loss may recover only this evidence.
    await authSession?.recordRunLocalRotation();

    const completion = findTurnCompletion(client.notifications, filter);
    if (!completion) {
      throw new Error(`PROTOCOL_ERROR: turn/completed notification was not retained for thread=${threadId} turn=${turnId}`);
    }

    if (completion.status === "interrupted") {
      throw new Error(`APP_SERVER_CANCELLED: App Server turn was interrupted for thread=${threadId} turn=${turnId}`);
    }

    if (completion.status !== "completed") {
      throw new Error(`PROTOCOL_ERROR: App Server turn ended with status=${completion.status}`);
    }

    const summary = collectAgentMessageText(client.notifications, filter).trim();
    if (!summary) {
      throw new Error(`PROTOCOL_ERROR: App Server turn completed without assistant message text for thread=${threadId} turn=${turnId}`);
    }

    if (request.workflow === "generate") {
      return buildGenerateResult(request, summary, logger.ref);
    }

    const parseResult = parseStructuredSidecarOutput(request, summary);

    if (parseResult.status === "partial") {
      // JSON parsed with a valid core, but workflow fields drifted from the
      // schema. Surface the raw report and the exact violations instead of
      // discarding a completed turn. No prose fallback: JSON.parse failures and
      // a missing core still throw PROTOCOL_ERROR upstream in parseStructuredSidecarOutput.
      return buildDegradedResult(request, parseResult, {
        normalizedRequest: request,
        modelPolicy: modelPolicyInfo(request),
        rawEventLogRef: logger.ref,
      });
    }

    const merged = mergeStructuredOutput(request, parseResult.output, {
      status: "ok",
      workflow: request.workflow,
      normalizedRequest: request,
      modelPolicy: modelPolicyInfo(request),
      rawEventLogRef: logger.ref,
    });
    if (parseResult.normalizationNotes.length > 0) {
      merged.normalizationNotes = parseResult.normalizationNotes;
    }
    return merged;
  } catch (error) {
    logger?.write({
      category: "diagnostic",
      event: "run/error",
      data: { message: error instanceof Error ? error.message : String(error) },
    });

    const result = errorResult(request, toSidecarError(error));
    if (logger) {
      result.rawEventLogRef = logger.ref;
      if (result.error) {
        result.error.data = {
          ...(result.error.data ?? {}),
          rawEventLogRef: logger.ref,
          stderr: client?.stderr,
        };
      }
    }

    return result;
  } finally {
    if (logger && client) {
      writeRetainedClientDiagnostics(logger, client);
    }

    let cleanupError: unknown;
    if (ownsClient && client) {
      try { await client.close?.(); } catch (error) { cleanupError = error; }
    }
    if (!cleanupError && authSession) {
      try { await authSession.closeClean(); } catch (error) { cleanupError = error; }
    }
    await logger?.close();
    if (cleanupError) {
      const result = errorResult(request, toSidecarError(cleanupError));
      if (logger) result.rawEventLogRef = logger.ref;
      return result;
    }
  }
}

function writeRetainedClientDiagnostics(logger: AppServerEventLogger, client: AppServerSessionClient): void {
  logger.write({
    category: "diagnostic",
    event: "client/retained-state",
    data: {
      notifications: client.notifications.length,
      stderrBytes: client.stderr?.length ?? 0,
    },
  });

  for (const notification of client.notifications) {
    logger.write({
      category: "protocol",
      event: "notification/retained",
      direction: "inbound",
      data: notification,
    });
  }
}

async function interruptTurnAfterTimeout(
  client: AppServerSessionClient,
  logger: AppServerEventLogger,
  threadId: string,
  turnId: string,
): Promise<void> {
  logger.write({
    category: "lifecycle",
    event: "turn/interrupt/start",
    data: { threadId, turnId },
  });

  try {
    await client.interruptTurn(threadId, turnId);
    logger.write({
      category: "lifecycle",
      event: "turn/interrupt/complete",
      data: { threadId, turnId },
    });
  } catch (error) {
    logger.write({
      category: "diagnostic",
      event: "turn/interrupt/error",
      data: {
        threadId,
        turnId,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
