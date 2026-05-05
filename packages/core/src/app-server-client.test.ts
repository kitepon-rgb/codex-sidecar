import assert from "node:assert/strict";
import test from "node:test";
import {
  AppServerProtocolError,
  buildInitializeDraft,
  buildThreadStartDraft,
  buildTurnStartDraft,
  collectAgentMessageText,
  encodeAppServerMessage,
  findTurnCompletion,
  hasTurnCompleted,
  parseAppServerLine,
  type SidecarRequest,
} from "./index.js";

const sampleRequest: SidecarRequest = {
  workflow: "review",
  projectRoot: "/repo",
  prompt: "Review this diff.",
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

test("encodeAppServerMessage writes one JSON object per line", () => {
  assert.equal(encodeAppServerMessage({ id: 1, method: "initialize", params: { ok: true } }), '{"id":1,"method":"initialize","params":{"ok":true}}\n');
});

test("buildInitializeDraft opts into experimental app-server API", () => {
  assert.deepEqual(buildInitializeDraft("1.2.3"), {
    method: "initialize",
    params: {
      clientInfo: {
        name: "codex-sidecar",
        title: "Codex Sidecar",
        version: "1.2.3",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    },
  });
});

test("buildThreadStartDraft uses strict sidecar defaults", () => {
  assert.deepEqual(buildThreadStartDraft(sampleRequest), {
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "codex-sidecar",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    },
  });
});

test("buildTurnStartDraft encodes text input with generated protocol shape", () => {
  assert.deepEqual(buildTurnStartDraft(sampleRequest, "thread-1"), {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "Review this diff.", text_elements: [] }],
      cwd: "/repo",
      approvalPolicy: "never",
    },
  });
});

test("parseAppServerLine parses initialize response", () => {
  assert.deepEqual(
    parseAppServerLine(
      '{"id":1,"result":{"userAgent":"codex_vscode/0.128.0-alpha.1","codexHome":"/home/kite/.codex","platformFamily":"unix","platformOs":"linux"}}',
    ),
    {
      kind: "response",
      id: 1,
      result: {
        userAgent: "codex_vscode/0.128.0-alpha.1",
        codexHome: "/home/kite/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
    },
  );
});

test("parseAppServerLine parses server notification", () => {
  assert.deepEqual(parseAppServerLine('{"method":"remoteControl/status/changed","params":{"status":"disabled","environmentId":null}}'), {
    kind: "notification",
    method: "remoteControl/status/changed",
    params: {
      status: "disabled",
      environmentId: null,
    },
  });
});

test("parseAppServerLine rejects invalid framing explicitly", () => {
  assert.throws(() => parseAppServerLine("Content-Length: 123"), AppServerProtocolError);
});

test("collectAgentMessageText concatenates matching deltas", () => {
  assert.equal(
    collectAgentMessageText(
      [
        {
          kind: "notification",
          method: "item/agentMessage/delta",
          params: { threadId: "t1", turnId: "u1", itemId: "i1", delta: "hello " },
        },
        {
          kind: "notification",
          method: "item/agentMessage/delta",
          params: { threadId: "t1", turnId: "u1", itemId: "i1", delta: "world" },
        },
        {
          kind: "notification",
          method: "item/agentMessage/delta",
          params: { threadId: "t2", turnId: "u2", itemId: "i2", delta: "ignored" },
        },
      ],
      { threadId: "t1", turnId: "u1" },
    ),
    "hello world",
  );
});

test("findTurnCompletion extracts completed turn state", () => {
  const notifications = [
    {
      kind: "notification" as const,
      method: "turn/completed",
      params: {
        threadId: "t1",
        turn: {
          id: "u1",
          status: "completed",
          error: null,
        },
      },
    },
  ];

  assert.deepEqual(findTurnCompletion(notifications, { threadId: "t1" }), {
    threadId: "t1",
    turnId: "u1",
    status: "completed",
    error: null,
  });
  assert.equal(hasTurnCompleted(notifications, { threadId: "t1", turnId: "u1" }), true);
  assert.equal(hasTurnCompleted(notifications, { threadId: "t2" }), false);
});
