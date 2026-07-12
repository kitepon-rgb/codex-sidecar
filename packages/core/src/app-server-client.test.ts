import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AppServerProtocolError,
  buildAppServerCommand,
  buildInitializeDraft,
  buildThreadStartDraft,
  buildTurnInterruptDraft,
  buildTurnStartDraft,
  buildStructuredOutputPrompt,
  collectAgentMessageText,
  createIsolatedCodexHome,
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
  turnTimeoutMs: 600_000,
  interruptOnTimeout: true,
  preserveWorktree: true,
  context: [],
  dryRun: false,
};

function mkTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

test("buildAppServerCommand disables inherited MCP servers and plugins", () => {
  const previous = process.env.CODEX_BINARY;
  delete process.env.CODEX_BINARY;
  assert.deepEqual(buildAppServerCommand("stdio://"), {
    command: "codex",
    args: [
      "app-server",
      "-c",
      "mcp_servers={}",
      "-c",
      "plugins={}",
      "--listen",
      "stdio://",
    ],
  });
  process.env.CODEX_BINARY = previous;
});

test("buildAppServerCommand appends explicit model policy overrides", () => {
  const command = buildAppServerCommand({
    listen: "stdio://",
    model: "gpt-5.5",
    modelReasoningEffort: "high",
  });

  assert.deepEqual(command.args, [
    "app-server",
    "-c",
    "mcp_servers={}",
    "-c",
    "plugins={}",
    "-c",
    'model="gpt-5.5"',
    "-c",
    'model_reasoning_effort="high"',
    "--listen",
    "stdio://",
  ]);
});

test("buildAppServerCommand can use an explicit Codex binary", () => {
  const previous = process.env.CODEX_BINARY;
  process.env.CODEX_BINARY = "/opt/codex";
  try {
    assert.equal(buildAppServerCommand("stdio://").command, "/opt/codex");
  } finally {
    process.env.CODEX_BINARY = previous;
  }
});

test("createIsolatedCodexHome carries auth but drops MCP config", () => {
  const source = mkTempDir("codex-source-");
  try {
    writeFileSync(join(source, "auth.json"), "{\"token\":\"redacted\"}", "utf8");
    writeFileSync(join(source, "installation_id"), "install-id", "utf8");
    writeFileSync(
      join(source, "config.toml"),
      [
        'model = "gpt-5.5"',
        'model_provider = "openai"',
        'model_reasoning_effort = "high"',
        "model_context_window = 272000",
        "model_auto_compact_token_limit = 240000",
        "[mcp_servers.codegraph]",
        'command = "codegraph"',
      ].join("\n"),
      "utf8",
    );

    const isolated = createIsolatedCodexHome({ CODEX_HOME: source });
    try {
      assert.equal(isolated.env.CODEX_HOME, isolated.path);
      assert.equal(readFileSync(join(isolated.path, "auth.json"), "utf8"), "{\"token\":\"redacted\"}");
      assert.equal(readFileSync(join(isolated.path, "installation_id"), "utf8"), "install-id");
      assert.equal(
        readFileSync(join(isolated.path, "config.toml"), "utf8"),
        [
          'model = "gpt-5.5"',
          'model_provider = "openai"',
          'model_reasoning_effort = "high"',
          "model_context_window = 272000",
          "model_auto_compact_token_limit = 240000",
          "",
        ].join("\n"),
      );
    } finally {
      isolated.cleanup();
    }
    assert.equal(existsSync(isolated.path), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("createIsolatedCodexHome persists a rotated auth.json back to the source on cleanup", () => {
  const source = mkTempDir("codex-source-");
  try {
    writeFileSync(join(source, "auth.json"), "{\"refresh\":\"R0\"}", "utf8");

    const isolated = createIsolatedCodexHome({ CODEX_HOME: source });
    // Simulate the App Server rotating the refresh token inside the isolated home.
    writeFileSync(join(isolated.path, "auth.json"), "{\"refresh\":\"R1\"}", "utf8");
    isolated.cleanup();

    // The rotated token must survive in the canonical home (no refresh_token_reused).
    assert.equal(readFileSync(join(source, "auth.json"), "utf8"), "{\"refresh\":\"R1\"}");
    assert.equal(existsSync(isolated.path), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("createIsolatedCodexHome leaves the source auth untouched when nothing rotated", () => {
  const source = mkTempDir("codex-source-");
  try {
    writeFileSync(join(source, "auth.json"), "{\"refresh\":\"R0\"}", "utf8");

    const isolated = createIsolatedCodexHome({ CODEX_HOME: source });
    isolated.cleanup(); // no rotation happened

    assert.equal(readFileSync(join(source, "auth.json"), "utf8"), "{\"refresh\":\"R0\"}");
    assert.equal(existsSync(`${join(source, "auth.json")}.codex-sidecar.tmp`), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
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

test("buildTurnStartDraft encodes structured-output text input with generated protocol shape", () => {
  const draft = buildTurnStartDraft(sampleRequest, "thread-1");

  assert.deepEqual(draft, {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: buildStructuredOutputPrompt(sampleRequest), text_elements: [] }],
      cwd: "/repo",
      approvalPolicy: "never",
    },
  });
  assert.match(draft.params.input[0].text, /Return exactly one JSON object/);
  assert.match(draft.params.input[0].text, /findings/);
});

test("buildTurnInterruptDraft encodes turn interrupt request", () => {
  assert.deepEqual(buildTurnInterruptDraft("thread-1", "turn-1"), {
    method: "turn/interrupt",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
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

test("collectAgentMessageText prefers completed final answer over commentary deltas", () => {
  assert.equal(
    collectAgentMessageText(
      [
        {
          kind: "notification",
          method: "item/agentMessage/delta",
          params: { threadId: "t1", turnId: "u1", itemId: "commentary-1", delta: "I will inspect the repo first." },
        },
        {
          kind: "notification",
          method: "item/completed",
          params: {
            threadId: "t1",
            turnId: "u1",
            item: {
              type: "agentMessage",
              id: "commentary-1",
              text: "I will inspect the repo first.",
              phase: "commentary",
            },
          },
        },
        {
          kind: "notification",
          method: "item/completed",
          params: {
            threadId: "t1",
            turnId: "u1",
            item: {
              type: "agentMessage",
              id: "final-1",
              text: "{\"summary\":\"done\"}",
              phase: "final_answer",
            },
          },
        },
      ],
      { threadId: "t1", turnId: "u1" },
    ),
    "{\"summary\":\"done\"}",
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
