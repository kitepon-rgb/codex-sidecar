import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "text" && "text" in value && typeof value.text === "string";
}
