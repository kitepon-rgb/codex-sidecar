import type { AppServerThreadStartResponse, AppServerTurnStartResponse } from "./app-server.js";
import { AppServerClient, type AppServerInitializeResult, type AppServerWireNotification } from "./app-server-client.js";
import { collectAgentMessageText, findTurnCompletion } from "./app-server-events.js";
import { errorResult, toSidecarError } from "./results.js";
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

  const client = options.client ?? AppServerClient.start();
  const ownsClient = options.client === undefined;

  try {
    await client.initialize(options.version ?? "0.0.0");
    const threadResponse = await client.startThread(request);
    const threadId = threadResponse.thread.id;
    const turnResponse = await client.startTurn(request, threadId);
    const turnId = turnResponse.turn.id;
    const filter = { threadId, turnId };

    await client.waitForNotification(
      (notification) => findTurnCompletion([notification], filter) !== undefined,
      options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    );

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

    return {
      status: "ok",
      workflow: request.workflow,
      summary,
      confidence: {
        level: "medium",
        rationale: "Codex App Server completed a read-only turn and returned assistant message text.",
      },
      recommendedNextAction: recommendedNextAction(request),
      normalizedRequest: request,
      sourceBoundaries: [
        {
          label: "Codex App Server",
          source: "local codex app-server stdio",
          trust: "local",
        },
      ],
      rawEventLogRef: `app-server:thread=${threadId}:turn=${turnId}:notifications=${client.notifications.length}`,
    };
  } catch (error) {
    return errorResult(request, toSidecarError(error));
  } finally {
    if (ownsClient) {
      await client.close?.();
    }
  }
}

function recommendedNextAction(request: SidecarRequest): string {
  switch (request.workflow) {
    case "review":
      return "Inspect the findings and verify any referenced files or tests before changing code.";
    case "explore":
      return "Use the cited context to decide whether a follow-up review, risk-check, or scoped work request is needed.";
    case "opinion":
      return "Compare the recommendation against the project goal, then choose or revise the plan explicitly.";
    case "risk-check":
      return "Verify high-severity risks first and keep source boundaries explicit.";
    case "work":
      return "Review the isolated worktree output before merging.";
  }
}
