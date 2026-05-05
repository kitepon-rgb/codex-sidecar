import type { AppServerWireNotification } from "./app-server-client.js";

export interface AppServerTurnFilter {
  threadId?: string;
  turnId?: string;
}

export interface AppServerTurnCompletion {
  threadId: string;
  turnId: string;
  status: string;
  error: unknown;
}

export function collectAgentMessageText(
  notifications: readonly AppServerWireNotification[],
  filter: AppServerTurnFilter = {},
): string {
  const completedFinalText = findCompletedFinalAgentMessageText(notifications, filter);
  if (completedFinalText !== undefined) {
    return completedFinalText;
  }

  return notifications
    .filter((notification) => notification.method === "item/agentMessage/delta")
    .map((notification) => notification.params)
    .filter((params): params is Record<string, unknown> => isRecord(params) && matchesTurnFilter(params, filter))
    .map((params) => (typeof params.delta === "string" ? params.delta : ""))
    .join("");
}

export function findTurnCompletion(
  notifications: readonly AppServerWireNotification[],
  filter: AppServerTurnFilter = {},
): AppServerTurnCompletion | undefined {
  for (const notification of notifications) {
    if (notification.method !== "turn/completed" || !isRecord(notification.params)) {
      continue;
    }

    const params = notification.params;
    const turn = params.turn;

    if (!isRecord(turn) || !matchesTurnFilter({ ...params, turnId: turn.id }, filter)) {
      continue;
    }

    if (typeof params.threadId !== "string" || typeof turn.id !== "string" || typeof turn.status !== "string") {
      continue;
    }

    return {
      threadId: params.threadId,
      turnId: turn.id,
      status: turn.status,
      error: turn.error,
    };
  }

  return undefined;
}

export function hasTurnCompleted(
  notifications: readonly AppServerWireNotification[],
  filter: AppServerTurnFilter = {},
): boolean {
  return findTurnCompletion(notifications, filter) !== undefined;
}

function matchesTurnFilter(params: Record<string, unknown>, filter: AppServerTurnFilter): boolean {
  if (filter.threadId !== undefined && params.threadId !== filter.threadId) {
    return false;
  }

  if (filter.turnId !== undefined && params.turnId !== filter.turnId) {
    return false;
  }

  return true;
}

function findCompletedFinalAgentMessageText(
  notifications: readonly AppServerWireNotification[],
  filter: AppServerTurnFilter,
): string | undefined {
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    const notification = notifications[index];
    if (notification.method !== "item/completed" || !isRecord(notification.params)) {
      continue;
    }

    const params = notification.params;
    if (!matchesTurnFilter(params, filter)) {
      continue;
    }

    const item = params.item;
    if (!isRecord(item)) {
      continue;
    }

    if (item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string") {
      return item.text;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
