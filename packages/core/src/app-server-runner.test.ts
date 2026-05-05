import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const eventLogDir = await makeTempLogDir();
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

  const result = await runReadOnlyAppServerRequest(request, { client, eventLogDir });

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "hello world");
  assert.equal(client.closed, false);
  assert.ok(result.rawEventLogRef?.startsWith(eventLogDir));

  const log = await readJsonlLog(result.rawEventLogRef);
  assert.ok(log.some((entry) => entry.event === "run/start"));
  assert.ok(log.some((entry) => entry.event === "turn/started"));
  assert.equal(log.filter((entry) => entry.event === "notification/retained").length, 3);

  await rm(eventLogDir, { recursive: true, force: true });
});

test("runReadOnlyAppServerRequest fails explicitly when assistant text is missing", async () => {
  const eventLogDir = await makeTempLogDir();
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    },
  ]);

  const result = await runReadOnlyAppServerRequest(request, { client, eventLogDir });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "PROTOCOL_ERROR");
  assert.ok(result.rawEventLogRef?.startsWith(eventLogDir));
  assert.equal(result.error?.data?.rawEventLogRef, result.rawEventLogRef);

  const log = await readJsonlLog(result.rawEventLogRef);
  assert.ok(log.some((entry) => entry.event === "run/error"));
  assert.ok(log.some((entry) => entry.event === "notification/retained"));

  await rm(eventLogDir, { recursive: true, force: true });
});

test("runReadOnlyAppServerRequest retains log diagnostics when turn completion wait fails", async () => {
  const eventLogDir = await makeTempLogDir();
  const client = new FakeAppServerClient([]);

  const result = await runReadOnlyAppServerRequest(request, { client, eventLogDir, turnTimeoutMs: 25 });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "PROTOCOL_ERROR");
  assert.ok(result.rawEventLogRef?.startsWith(eventLogDir));

  const log = await readJsonlLog(result.rawEventLogRef);
  assert.ok(log.some((entry) => entry.event === "turn/wait-completion"));
  assert.ok(log.some((entry) => entry.event === "turn/timeout-or-wait-error"));

  await rm(eventLogDir, { recursive: true, force: true });
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

async function makeTempLogDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codex-sidecar-app-server-logs-"));
}

async function readJsonlLog(path: string | undefined): Promise<Array<Record<string, unknown>>> {
  assert.ok(path);
  const source = await readFile(path, "utf8");
  return source
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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
