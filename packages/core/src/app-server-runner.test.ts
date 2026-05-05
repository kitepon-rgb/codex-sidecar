import assert from "node:assert/strict";
import test from "node:test";
import { runReadOnlyAppServerRequest, type AppServerSessionClient, type AppServerWireNotification, type SidecarRequest } from "./index.js";

const request: SidecarRequest = {
  workflow: "explore",
  projectRoot: "/repo",
  prompt: "Explain the repo.",
  readonly: true,
  requireWorktree: false,
  focus: [],
  allowedPaths: [],
  denyPaths: [],
  safetyProfile: "generic",
  resultFormat: "json",
  context: [],
  dryRun: false,
};

test("runReadOnlyAppServerRequest returns assistant text from completed turn", async () => {
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello " },
    },
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "world" },
    },
    {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    },
  ]);

  const result = await runReadOnlyAppServerRequest(request, { client });

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "hello world");
  assert.equal(client.closed, false);
  assert.equal(result.rawEventLogRef, "app-server:thread=thread-1:turn=turn-1:notifications=3");
});

test("runReadOnlyAppServerRequest fails explicitly when assistant text is missing", async () => {
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    },
  ]);

  const result = await runReadOnlyAppServerRequest(request, { client });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "PROTOCOL_ERROR");
});

test("runReadOnlyAppServerRequest fails write-capable requests before App Server fallback", async () => {
  const result = await runReadOnlyAppServerRequest(
    {
      ...request,
      workflow: "work",
      readonly: false,
      requireWorktree: true,
      allowedPaths: ["src/**"],
    },
    { client: new FakeAppServerClient([]) },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "APP_SERVER_UNIMPLEMENTED");
});

class FakeAppServerClient implements AppServerSessionClient {
  readonly stderr = "";
  readonly notifications: AppServerWireNotification[] = [];
  closed = false;

  constructor(private readonly queuedNotifications: AppServerWireNotification[]) {}

  async initialize() {
    return {
      userAgent: "fake",
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "linux",
    };
  }

  async startThread() {
    return {
      thread: {
        id: "thread-1",
        cwd: "/repo",
        status: "idle",
      },
      model: "fake",
      modelProvider: "fake",
      cwd: "/repo",
    };
  }

  async startTurn() {
    return {
      turn: {
        id: "turn-1",
        status: "running",
        error: null,
      },
    };
  }

  async waitForNotification(predicate: (message: AppServerWireNotification) => boolean) {
    for (const notification of this.queuedNotifications) {
      this.notifications.push(notification);
      if (predicate(notification)) {
        return notification;
      }
    }

    throw new Error("PROTOCOL_ERROR: fake notification queue exhausted");
  }

  async close() {
    this.closed = true;
  }
}
