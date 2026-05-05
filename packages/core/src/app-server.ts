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

export interface AppServerInitializeDraft {
  method: typeof APP_SERVER_PROTOCOL_METHODS.initialize;
  params: {
    clientInfo: {
      name: "codex-sidecar";
      title: "Codex Sidecar";
      version: string;
    };
    capabilities: {
      experimentalApi: true;
      optOutNotificationMethods: string[];
    };
  };
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

export interface AppServerThreadStartResponse {
  thread: {
    id: string;
    cwd: string;
    status: string;
  };
  model: string;
  modelProvider: string;
  cwd: string;
}

export interface AppServerTurnStartDraft {
  method: typeof APP_SERVER_PROTOCOL_METHODS.turnStart;
  params: {
    threadId: string;
    input: Array<{ type: "text"; text: string; text_elements: [] }>;
    cwd: string;
    approvalPolicy: "never";
  };
}

export interface AppServerTurnStartResponse {
  turn: {
    id: string;
    status: string;
    error: unknown;
  };
}

export function buildAppServerCommand(listen = "stdio://"): AppServerCommand {
  return {
    command: "codex",
    args: ["app-server", "--listen", listen],
  };
}

export function buildInitializeDraft(version = "0.0.0"): AppServerInitializeDraft {
  return {
    method: APP_SERVER_PROTOCOL_METHODS.initialize,
    params: {
      clientInfo: {
        name: "codex-sidecar",
        title: "Codex Sidecar",
        version,
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    },
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
      input: [{ type: "text", text: request.prompt ?? "", text_elements: [] }],
      cwd: request.projectRoot,
      approvalPolicy: "never",
    },
  };
}
