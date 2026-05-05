import type { AppServerThreadStartResponse, AppServerTurnStartResponse } from "./app-server.js";
import { AppServerClient, type AppServerInitializeResult, type AppServerWireNotification } from "./app-server-client.js";
import { collectAgentMessageText, findTurnCompletion } from "./app-server-events.js";
import { createAppServerEventLogger, type AppServerEventLogger } from "./app-server-logs.js";
import { errorResult, toSidecarError } from "./results.js";
import { mergeStructuredOutput, parseStructuredSidecarOutput } from "./structured-output.js";
import type { SidecarRequest, SidecarResult } from "./types.js";

export interface AppServerSessionClient {
  readonly notifications: AppServerWireNotification[];
  readonly stderr?: string;
  initialize(version?: string): Promise<AppServerInitializeResult>;
  startThread(request: SidecarRequest): Promise<AppServerThreadStartResponse>;
  startTurn(request: SidecarRequest, threadId: string): Promise<AppServerTurnStartResponse>;
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
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

export async function runReadOnlyAppServerRequest(
  request: SidecarRequest,
  options: AppServerRunOptions = {},
): Promise<SidecarResult> {
  if (!request.readonly || request.workflow === "work") {
    return errorResult(
      request,
      toSidecarError(new Error("APP_SERVER_UNIMPLEMENTED: write-capable App Server execution is not wired yet")),
    );
  }

  let logger: AppServerEventLogger | undefined;
  let client: AppServerSessionClient | undefined;
  let ownsClient = false;

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
      },
    });

    client =
      options.client ??
      AppServerClient.start({
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

    const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
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
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    const completion = findTurnCompletion(client.notifications, filter);
    if (!completion) {
      throw new Error(`PROTOCOL_ERROR: turn/completed notification was not retained for thread=${threadId} turn=${turnId}`);
    }

    if (completion.status !== "completed") {
      throw new Error(`PROTOCOL_ERROR: App Server turn ended with status=${completion.status}`);
    }

    const summary = collectAgentMessageText(client.notifications, filter).trim();
    if (!summary) {
      throw new Error(`PROTOCOL_ERROR: App Server turn completed without assistant message text for thread=${threadId} turn=${turnId}`);
    }

    const structuredOutput = parseStructuredSidecarOutput(request, summary);

    return mergeStructuredOutput(request, structuredOutput, {
      status: "ok",
      workflow: request.workflow,
      normalizedRequest: request,
      rawEventLogRef: logger.ref,
    });
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

    if (ownsClient && client) {
      await client.close?.();
    }

    await logger?.close();
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
