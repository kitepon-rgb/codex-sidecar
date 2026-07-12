import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolDescriptors } from "./index.js";
import { startCodexSidecarMcpHttpServer } from "./server-http.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

test("http transport starts, lists tools, and rejects bad bearer", async () => {
  const bearer = "test-bearer-value";
  const http = await startCodexSidecarMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    bearer,
  });

  try {
    const url = new URL(`http://127.0.0.1:${http.port}/mcp`);

    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    });
    const client = new Client({ name: "codex-sidecar-http-test", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        toolDescriptors.map((tool) => tool.name).slice().sort(),
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await http.close();
  }
});

test("http transport rejects non-initialize POST without session id", async () => {
  const http = await startCodexSidecarMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${http.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(response.status, 400);
  } finally {
    await http.close();
  }
});

test("a durable dry-run started over stdio is recovered by same key over HTTP after config drift", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-mcp-cross-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo, { mode: 0o700 });
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await writeFile(join(repo, ".codex-sidecar.yml"), "project: cross-transport\nallowed_paths:\n  - README.md\n");
  await exec("git", ["add", "README.md", ".codex-sidecar.yml"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });

  const serverPath = new URL("./server.js", import.meta.url).pathname;
  const stdioTransport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const stdioClient = new Client({ name: "codex-sidecar-stdio-cross-test", version: "0.0.0" }, { capabilities: {} });
  let started: Record<string, unknown>;
  try {
    await stdioClient.connect(stdioTransport);
    started = await callToolJson(stdioClient, "codex_work_start", {
      projectRoot: repo,
      idempotencyKey: key,
      allowWork: true,
      dryRun: true,
    });
  } finally {
    await stdioClient.close().catch(() => undefined);
  }
  assert.equal(started!.kind, "run_terminal");
  const runId = started!.runId;

  // A retry must reopen the immutable winner; it cannot need the config that
  // was used only to create the first manifest.
  await writeFile(join(repo, ".codex-sidecar.yml"), "invalid: [\n");
  const http = await startCodexSidecarMcpHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`));
    const client = new Client({ name: "codex-sidecar-http-cross-test", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const retry = await callToolJson(client, "codex_work_start", {
        projectRoot: repo,
        idempotencyKey: key,
        allowWork: true,
        dryRun: true,
      });
      const result = await callToolJson(client, "codex_work_result", {
        projectRoot: repo,
        idempotencyKey: key,
      });
      assert.equal(retry.kind, "run_terminal");
      assert.equal(retry.runId, runId);
      assert.equal(result.kind, "run_terminal");
      assert.equal(result.runId, runId);
      assert.equal((result.result as { status?: string }).status, "dry-run");
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await http.close();
  }
});

test("a non-dry-run survives stdio server loss before its MCP response is delivered and is recovered over HTTP", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-mcp-stdio-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const cache = join(root, "cache");
  await Promise.all([mkdir(repo, { mode: 0o700 }), mkdir(home, { mode: 0o700 }), mkdir(cache, { mode: 0o700 })]);
  await writeFile(join(home, "auth.json"), '{"refresh":"fixture"}\n', { mode: 0o600 });
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await writeFile(join(repo, ".codex-sidecar.yml"), "project: stdio-close\nallowed_paths:\n  - README.md\n");
  await exec("git", ["add", "README.md", ".codex-sidecar.yml"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });

  const fakeCodex = await createDelayedFakeCodex(root);
  const fakeCodexReady = join(root, "fake-codex-ready");
  const serverPath = new URL("./server.js", import.meta.url).pathname;
  const stdioServer = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_BINARY: fakeCodex,
      CODEX_HOME: home,
      XDG_CACHE_HOME: cache,
      FAKE_CODEX_READY_FILE: fakeCodexReady,
      FAKE_CODEX_DELAY_MS: "300",
    },
  });
  t.after(() => { try { stdioServer.kill("SIGKILL"); } catch {} });
  await initializeRawMcpStdioServer(stdioServer);

  // Do not consume the tool response. The fake App Server marker proves that
  // the detached worker has spawned and reached its own ready boundary before
  // this stdio MCP coordinator is forcibly lost.
  stdioServer.stdout.pause();
  writeMcpStdioMessage(stdioServer, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "codex_work_start",
      arguments: {
        projectRoot: repo,
        idempotencyKey: key,
        allowWork: true,
        prompt: "complete after the MCP coordinator disappears",
      },
    },
  });
  await waitForPath(fakeCodexReady);
  assert.equal(stdioServer.kill("SIGKILL"), true);
  await waitForExit(stdioServer);

  const http = await startCodexSidecarMcpHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`));
    const client = new Client({ name: "codex-sidecar-http-stdio-close-test", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const retry = await callToolJson(client, "codex_work_start", {
        projectRoot: repo,
        idempotencyKey: key,
        allowWork: true,
        prompt: "complete after the MCP coordinator disappears",
      });
      assert.equal(retry.kind, "run_handle");
      const runId = retry.runId;
      if (typeof runId !== "string") throw new Error(`expected retry run id: ${JSON.stringify(retry)}`);
      // The response from the original stdio caller was never consumed. A
      // single durable directory named by the retry's runId is the direct
      // cross-process proof that retry reused that original winner rather than
      // spawning a second worker for this idempotency key.
      assert.deepEqual(await durableRunIds(repo), [runId]);
      const terminal = await waitForTerminalResult(client, repo, key);
      assert.equal(terminal.kind, "run_terminal");
      assert.equal(terminal.runId, runId);
      assert.equal(terminal.state, "completed");
      assert.equal((terminal.result as { status?: string }).status, "ok");
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await http.close();
  }
});

async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true);
  assert.ok(Array.isArray(result.content));
  const text = result.content.find((item: unknown): item is { type: "text"; text: string } => isTextContent(item));
  assert.ok(text);
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function waitForTerminalResult(client: Client, projectRoot: string, idempotencyKey: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    last = await callToolJson(client, "codex_work_result", { projectRoot, idempotencyKey });
    if (last.kind === "run_terminal") return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`durable work did not reach a terminal result: ${JSON.stringify(last)}`);
}

async function initializeRawMcpStdioServer(server: ReturnType<typeof spawn>): Promise<void> {
  writeMcpStdioMessage(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex-sidecar-raw-stdio-test", version: "0.0.0" },
    },
  });
  const initialized = await readMcpStdioMessage(server);
  assert.equal(initialized.id, 1);
  writeMcpStdioMessage(server, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

function writeMcpStdioMessage(server: ReturnType<typeof spawn>, message: Record<string, unknown>): void {
  assert.ok(server.stdin);
  assert.equal(server.stdin.write(`${JSON.stringify(message)}\n`), true);
}

async function readMcpStdioMessage(server: ReturnType<typeof spawn>): Promise<Record<string, unknown>> {
  assert.ok(server.stdout);
  const stdout = server.stdout;
  const line = await new Promise<string>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(output.slice(0, newline));
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onExit = (): void => { cleanup(); reject(new Error("stdio MCP server exited before initialize response")); };
    const cleanup = (): void => {
      stdout.off("data", onData);
      server.off("error", onError);
      server.off("exit", onExit);
    };
    stdout.on("data", onData);
    server.once("error", onError);
    server.once("exit", onExit);
  });
  return JSON.parse(line) as Record<string, unknown>;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`path was not created: ${path}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("stdio MCP server did not exit")); }, 10_000);
    const onExit = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function durableRunIds(projectRoot: string): Promise<string[]> {
  const { stdout } = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: projectRoot });
  return (await readdir(join(stdout.trim(), "codex-sidecar", "runs")))
    .filter((entry) => !entry.startsWith(".tmp-"))
    .sort();
}

async function createDelayedFakeCodex(root: string): Promise<string> {
  const binary = join(root, "fake-codex");
  const source = `#!${process.execPath}
const readline = require("node:readline");
const { writeFileSync } = require("node:fs");
const report = JSON.stringify({
  summary: "fixture work complete",
  confidence: { level: "high", rationale: "fixture App Server" },
  recommendedNextAction: "review the worktree",
  openQuestions: [],
  fileReferences: [],
  sourceBoundaries: [],
  tests: [],
  risks: [],
});
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function reply(id, result) { send({ id, result }); }
function notify(method, params) { send({ method, params }); }
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.FAKE_CODEX_READY_FILE) writeFileSync(process.env.FAKE_CODEX_READY_FILE, "ready\\n");
    reply(message.id, { userAgent: "fixture", codexHome: process.env.CODEX_HOME || "", platformFamily: "unix", platformOs: process.platform });
    return;
  }
  if (message.method === "thread/start") {
    reply(message.id, { thread: { id: "thread-1", cwd: message.params.cwd, status: "idle" }, model: "fixture", modelProvider: "fixture", cwd: message.params.cwd });
    return;
  }
  if (message.method === "turn/start") {
    reply(message.id, { turn: { id: "turn-1", status: "in_progress", error: null } });
    setTimeout(() => {
      notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: report });
      notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } });
    }, Number(process.env.FAKE_CODEX_DELAY_MS || 300));
  }
});
`;
  await writeFile(binary, source, { mode: 0o700 });
  return binary;
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "text" && "text" in value && typeof value.text === "string";
}
