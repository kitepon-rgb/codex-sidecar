import type { SidecarRequest } from "./types.js";

export const APP_SERVER_PROTOCOL_METHODS = {
  initialize: "initialize",
  threadStart: "thread/start",
  turnStart: "turn/start",
  reviewStart: "review/start",
} as const;

export interface AppServerCommand {
  command: "codex";
  args: string[];
}

export interface AppServerThreadStartDraft {
  method: typeof APP_SERVER_PROTOCOL_METHODS.threadStart;
  params: {
    cwd: string;
    approvalPolicy: "never";
    sandbox: "read-only" | "workspace-write";
    serviceName: "codex-sidecar";
    ephemeral: true;
    experimentalRawEvents: false;
    persistExtendedHistory: false;
  };
}

export interface AppServerTurnStartDraft {
  method: typeof APP_SERVER_PROTOCOL_METHODS.turnStart;
  params: {
    threadId: string;
    input: Array<{ text: string }>;
    cwd: string;
    approvalPolicy: "never";
  };
}

export function buildAppServerCommand(listen = "stdio://"): AppServerCommand {
  return {
    command: "codex",
    args: ["app-server", "--listen", listen],
  };
}

export function buildThreadStartDraft(request: SidecarRequest): AppServerThreadStartDraft {
  return {
    method: APP_SERVER_PROTOCOL_METHODS.threadStart,
    params: {
      cwd: request.projectRoot,
      approvalPolicy: "never",
      sandbox: request.readonly ? "read-only" : "workspace-write",
      serviceName: "codex-sidecar",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    },
  };
}

export function buildTurnStartDraft(request: SidecarRequest, threadId: string): AppServerTurnStartDraft {
  return {
    method: APP_SERVER_PROTOCOL_METHODS.turnStart,
    params: {
      threadId,
      input: [{ text: request.prompt ?? "" }],
      cwd: request.projectRoot,
      approvalPolicy: "never",
    },
  };
}
