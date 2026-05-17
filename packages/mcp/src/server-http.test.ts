import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolDescriptors } from "./index.js";
import { startCodexSidecarMcpHttpServer } from "./server-http.js";

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
