import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerClient } from "./app-server-client.js";
import { matchesProcessIdentity, processStartIdentity } from "./process-identity.js";
import {
  AppServerProtocolError,
  buildAppServerCommand,
  buildInitializeDraft,
  buildThreadStartDraft,
  buildTurnInterruptDraft,
  buildTurnStartDraft,
  buildStructuredOutputPrompt,
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
  turnTimeoutMs: 600_000,
  interruptOnTimeout: true,
  preserveWorktree: true,
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

test("AppServerClient.start refuses to bypass DurableAuthSession", () => {
  assert.throws(() => AppServerClient.start(), /DurableAuthSession CODEX_HOME/);
});

test("AppServerClient.close escalates TERM to KILL and confirms the owned child disappeared", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "app-server-close-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, "pid");
  const client = AppServerClient.start({
    command: process.execPath,
    args: ["--input-type=module", "-e", `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`],
    env: { ...process.env, CODEX_HOME: root },
  });
  const pid = await waitForPid(pidPath); const identity = { pid, startIdentity: await processStartIdentity(pid) };
  await client.close();
  assert.equal(await matchesProcessIdentity(identity), false);
});

test("AppServerClient.close fails closed when an already-exited owner still has a stdio-holding descendant", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "app-server-close-descendant-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, "descendant.pid"); let descendantPid: number | undefined;
  t.after(() => { if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} } });
  const client = AppServerClient.start({
    command: process.execPath,
    args: ["--input-type=module", "-e", `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const descendant=spawn(process.execPath,['--input-type=module','-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'}); writeFileSync(${JSON.stringify(pidPath)},String(descendant.pid)); setTimeout(()=>process.exit(0),50)`],
    env: { ...process.env, CODEX_HOME: root },
  });
  descendantPid = await waitForPid(pidPath); await new Promise((resolve) => setTimeout(resolve, 120));
  await assert.rejects(() => client.close(), /did not exit and close after SIGKILL/);
});

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { return Number.parseInt(await readFile(path, "utf8"), 10); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("child pid file timed out");
}

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
