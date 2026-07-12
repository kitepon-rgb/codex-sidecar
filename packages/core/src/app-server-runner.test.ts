import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runReadOnlyAppServerRequest, type AppServerSessionClient, type AppServerWireNotification, type SidecarRequest } from "./index.js";
import { createDurableAuthSession } from "./durable-auth-session.js";
import type { AppServerClientOptions } from "./app-server-client.js";

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
  turnTimeoutMs: 600_000,
  interruptOnTimeout: true,
  preserveWorktree: true,
  context: [],
  dryRun: false,
};

test("runReadOnlyAppServerRequest returns assistant text from completed turn", async () => {
  const eventLogDir = await makeTempLogDir();
  const assistantJson = JSON.stringify({
    summary: "hello world",
    confidence: { level: "medium", rationale: "fake structured output" },
    recommendedNextAction: "Use the explanation to choose a next step.",
    openQuestions: [],
    fileReferences: [{ path: "README.md", line: 1, label: "overview" }],
    sourceBoundaries: [{ label: "local repo", source: "fake fixture", trust: "local" }],
  });
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: assistantJson.slice(0, 30) },
    },
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: assistantJson.slice(30) },
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
  assert.equal(result.confidence.level, "medium");
  assert.equal(result.fileReferences?.[0]?.path, "README.md");
  assert.equal(result.sourceBoundaries?.some((boundary) => boundary.label === "Codex App Server"), true);
  assert.equal(client.closed, false);
  assert.ok(result.rawEventLogRef?.startsWith(eventLogDir));

  const log = await readJsonlLog(result.rawEventLogRef);
  assert.ok(log.some((entry) => entry.event === "run/start"));
  assert.ok(log.some((entry) => entry.event === "turn/started"));
  assert.equal(log.filter((entry) => entry.event === "notification/retained").length, 3);

  await rm(eventLogDir, { recursive: true, force: true });
});

test("runReadOnlyAppServerRequest normalizes review-specific structured fields", async () => {
  const eventLogDir = await makeTempLogDir();
  const reviewRequest: SidecarRequest = { ...request, workflow: "review", prompt: "Review the diff." };
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: JSON.stringify({
          summary: "One finding.",
          confidence: { level: "high" },
          recommendedNextAction: "Fix the referenced line.",
          openQuestions: [],
          fileReferences: [{ path: "src/app.ts", line: 10 }],
          sourceBoundaries: [],
          findings: [
            {
              severity: "high",
              title: "Bug",
              detail: "A real issue.",
              evidence: "Observed in diff.",
              file: "src/app.ts",
              line: 10,
              confidence: { level: "high" },
              basis: "observed",
            },
          ],
          missingTests: ["Add regression test."],
          residualRisks: [],
        }),
      },
    },
    {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    },
  ]);

  const result = await runReadOnlyAppServerRequest(reviewRequest, { client, eventLogDir });

  assert.equal(result.status, "ok");
  assert.equal(result.findings?.[0]?.severity, "high");
  assert.equal(result.missingTests?.[0], "Add regression test.");

  await rm(eventLogDir, { recursive: true, force: true });
});

test("runReadOnlyAppServerRequest returns status=partial when the work report drifts from the schema", async () => {
  const eventLogDir = await makeTempLogDir();
  const workRequest: SidecarRequest = { ...request, workflow: "work", prompt: "Implement the change." };
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: JSON.stringify({
          summary: "Implemented; verification partly blocked.",
          confidence: { level: "medium" },
          recommendedNextAction: "Review the worktree diff.",
          openQuestions: [],
          fileReferences: [],
          sourceBoundaries: [],
          tests: [{ command: "node --test", status: "failed", summary: "EPERM" }],
          risks: [
            {
              severity: "blocker",
              title: "Verification blocked",
              detail: "Sandbox denied writes.",
              affectedFiles: ["spike/session-end-logger.mjs"],
              confidence: "high",
              basis: "Observed EPERM on all three invocations.",
            },
          ],
        }),
      },
    },
    {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    },
  ]);

  const result = await runReadOnlyAppServerRequest(workRequest, { client, eventLogDir, allowWorkWorkflow: true });

  assert.equal(result.status, "partial");
  assert.equal(result.error?.code, "PROTOCOL_ERROR");
  assert.match(result.error?.message ?? "", /partially invalid/);
  // Raw report preserved for salvage; typed workflow fields omitted (no fabrication).
  assert.equal((result.unvalidatedReport as { risks?: unknown[] }).risks?.length, 1);
  assert.equal(result.risks, undefined);
  // Lossless coercions disclosed even on a degraded run.
  assert.ok((result.normalizationNotes ?? []).some((note) => note.includes("affectedFiles")));
  assert.ok(result.rawEventLogRef?.startsWith(eventLogDir));

  await rm(eventLogDir, { recursive: true, force: true });
});

test("runReadOnlyAppServerRequest returns the raw payload for the generate workflow", async () => {
  const eventLogDir = await makeTempLogDir();
  const generateRequest: SidecarRequest = {
    ...request,
    workflow: "generate",
    prompt: "Generate two example sentences as JSON.",
    outputContract: '{ "items": [{ "en": string, "ja": string }] }',
  };
  const generatedJson = JSON.stringify({
    items: [
      { en: "I go to school every day.", ja: "私は毎日学校に行きます。" },
      { en: "She likes music.", ja: "彼女は音楽が好きです。" },
    ],
  });
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: generatedJson },
    },
    {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    },
  ]);

  const result = await runReadOnlyAppServerRequest(generateRequest, { client, eventLogDir });

  assert.equal(result.status, "ok");
  assert.equal(result.workflow, "generate");
  assert.deepEqual(result.generated, JSON.parse(generatedJson));
  assert.equal(result.sourceBoundaries?.[0]?.trust, "generated");
  assert.ok(result.rawEventLogRef?.startsWith(eventLogDir));

  await rm(eventLogDir, { recursive: true, force: true });
});

test("runReadOnlyAppServerRequest fails the generate workflow on non-JSON output", async () => {
  const eventLogDir = await makeTempLogDir();
  const generateRequest: SidecarRequest = { ...request, workflow: "generate", prompt: "Generate JSON." };
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Sure, here is the JSON you asked for." },
    },
    {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    },
  ]);

  const result = await runReadOnlyAppServerRequest(generateRequest, { client, eventLogDir });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "PROTOCOL_ERROR");
  assert.match(result.error?.message ?? "", /generate output was not valid JSON/);

  await rm(eventLogDir, { recursive: true, force: true });
});

test("runReadOnlyAppServerRequest fails explicitly on malformed structured output", async () => {
  const eventLogDir = await makeTempLogDir();
  const client = new FakeAppServerClient([
    {
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "plain prose is invalid" },
    },
    {
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
    },
  ]);

  const result = await runReadOnlyAppServerRequest(request, { client, eventLogDir });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "PROTOCOL_ERROR");
  assert.match(result.error?.message ?? "", /assistant output was not valid JSON/);
  assert.ok(result.rawEventLogRef?.startsWith(eventLogDir));

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

  const result = await runReadOnlyAppServerRequest({ ...request, turnTimeoutMs: 25 }, { client, eventLogDir });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "APP_SERVER_TIMEOUT");
  assert.ok(result.rawEventLogRef?.startsWith(eventLogDir));
  assert.equal(client.interruptedTurns.length, 1);
  assert.equal(result.normalizedRequest?.turnTimeoutMs, 25);

  const log = await readJsonlLog(result.rawEventLogRef);
  assert.ok(log.some((entry) => entry.event === "turn/wait-completion"));
  assert.ok(log.some((entry) => entry.event === "turn/timeout-or-wait-error"));
  assert.ok(log.some((entry) => entry.event === "turn/interrupt/complete"));

  await rm(eventLogDir, { recursive: true, force: true });
});

test("runReadOnlyAppServerRequest can leave timed-out turns uninterrupted when requested", async () => {
  const eventLogDir = await makeTempLogDir();
  const client = new FakeAppServerClient([]);

  const result = await runReadOnlyAppServerRequest(
    { ...request, turnTimeoutMs: 25, interruptOnTimeout: false },
    { client, eventLogDir },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "APP_SERVER_TIMEOUT");
  assert.equal(client.interruptedTurns.length, 0);
  assert.equal(result.normalizedRequest?.interruptOnTimeout, false);

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

test("owned read-only App Server calls use and release a durable isolated auth session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-runner-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); const cache = join(root, "cache"); const logs = join(root, "logs");
  await mkdir(home, { mode: 0o700 }); await mkdir(cache, { mode: 0o700 }); await mkdir(logs, { mode: 0o700 });
  await chmod(home, 0o700); await chmod(cache, 0o700);
  await writeFile(join(home, "auth.json"), '{"refresh":"canonical"}\n', { mode: 0o600 });
  await writeFile(join(home, "config.toml"), 'model = "gpt-5.6"\nmodel_context_window = 272000\nmodel_auto_compact_token_limit = 240000\n[mcp_servers.forbidden]\ncommand="x"\n', { mode: 0o600 });
  const assistantJson = JSON.stringify({ summary: "durable", confidence: { level: "high" }, recommendedNextAction: "none", openQuestions: [], fileReferences: [], sourceBoundaries: [] });
  const client = new FakeAppServerClient([
    { kind: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: assistantJson } },
    { kind: "notification", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } },
  ]);
  let factoryOptions: AppServerClientOptions | undefined;
  const result = await runReadOnlyAppServerRequest(request, {
    eventLogDir: logs,
    authCacheRoot: await realpath(cache),
    authBaseEnv: { ...process.env, CODEX_HOME: await realpath(home) },
    clientFactory: (options) => { factoryOptions = options; return client; },
  });
  assert.equal(result.status, "ok"); assert.equal(client.closed, true);
  assert.ok(factoryOptions?.env?.CODEX_HOME); assert.notEqual(factoryOptions?.env?.CODEX_HOME, await realpath(home));
  const isolatedConfig = await readFile(join(factoryOptions!.env!.CODEX_HOME!, "config.toml"), "utf8");
  assert.match(isolatedConfig, /model = "gpt-5\.6"/);
  assert.doesNotMatch(isolatedConfig, /model_context_window|model_auto_compact_token_limit|mcp_servers/);
  const next = await createDurableAuthSession({ baseEnv: { ...process.env, CODEX_HOME: await realpath(home) }, cacheRoot: await realpath(cache), ownerKind: "sync-session", ownerId: "after-runner" });
  await next.closeClean();
});

test("unconfirmed App Server close keeps the durable auth lease held", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-runner-close-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); const cache = join(root, "cache"); const logs = join(root, "logs");
  await mkdir(home, { mode: 0o700 }); await mkdir(cache, { mode: 0o700 }); await mkdir(logs, { mode: 0o700 }); await chmod(home, 0o700); await chmod(cache, 0o700);
  await writeFile(join(home, "auth.json"), '{"refresh":"canonical"}\n', { mode: 0o600 });
  const assistantJson = JSON.stringify({ summary: "done", confidence: { level: "high" }, recommendedNextAction: "none", openQuestions: [], fileReferences: [], sourceBoundaries: [] });
  const client = new FailingCloseClient([
    { kind: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: assistantJson } },
    { kind: "notification", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } },
  ]);
  const baseEnv = { ...process.env, CODEX_HOME: await realpath(home) }; const authCacheRoot = await realpath(cache);
  const result = await runReadOnlyAppServerRequest(request, { eventLogDir: logs, authCacheRoot, authBaseEnv: baseEnv, clientFactory: () => client });
  assert.equal(result.status, "failed");
  await assert.rejects(() => createDurableAuthSession({ baseEnv, cacheRoot: authCacheRoot, ownerKind: "sync-session", ownerId: "must-remain-busy" }), { code: "AUTH_LEASE_BUSY" });
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
  readonly interruptedTurns: Array<{ threadId: string; turnId: string }> = [];
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

  async interruptTurn(threadId: string, turnId: string) {
    this.interruptedTurns.push({ threadId, turnId });
    return {};
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

class FailingCloseClient extends FakeAppServerClient {
  override async close() { throw new Error("App Server close was not confirmed"); }
}
