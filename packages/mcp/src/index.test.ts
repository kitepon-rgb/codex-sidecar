import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  handleCodexSidecarToolCall,
  toolDescriptors,
} from "./index.js";
import type { RequestInput, SidecarConfig, SidecarResult } from "codex-sidecar-core";

const config: SidecarConfig = {
  project: "test",
  defaults: {
    readonly: true,
    result_format: "json",
  },
};

test("tool descriptors expose timeout, cancellation, and model policy input schema", () => {
  const descriptor = toolDescriptors.find((tool) => tool.name === "codex_explore");
  assert.ok(descriptor);
  const turnTimeoutMs = descriptor.inputSchema.properties.turnTimeoutMs as { type: string };
  const interruptOnTimeout = descriptor.inputSchema.properties.interruptOnTimeout as { type: string };
  const context = descriptor.inputSchema.properties.context as { type: string };
  const model = descriptor.inputSchema.properties.model as { type: string };
  const modelReasoningEffort = descriptor.inputSchema.properties.modelReasoningEffort as { type: string; enum: string[] };
  assert.equal(turnTimeoutMs.type, "integer");
  assert.equal(interruptOnTimeout.type, "boolean");
  assert.equal(context.type, "array");
  assert.equal(model.type, "string");
  assert.deepEqual(modelReasoningEffort.enum, ["low", "medium", "high", "xhigh"]);
});

test("tool descriptors expose codex_auditor as a read-only workflow", () => {
  const descriptor = toolDescriptors.find((tool) => tool.name === "codex_auditor");
  assert.ok(descriptor);
  assert.equal(descriptor.workflow, "auditor");
  assert.equal(descriptor.readonly, true);
  assert.equal(descriptor.requiresExplicitOptIn, false);
});

test("handleCodexSidecarToolCall runs read-only tools through core", async () => {
  let capturedInput: RequestInput | undefined;
  const result = await handleCodexSidecarToolCall(
    "codex_explore",
    {
      projectRoot: "/repo",
      prompt: "Explain.",
      dryRun: true,
      model: "gpt-5.5",
      modelReasoningEffort: "high",
      turnTimeoutMs: 123,
      interruptOnTimeout: false,
      context: [
        {
          kind: "caveat_entry",
          source: "caveat",
          summary: "Remember the local hook caveat.",
        },
      ],
    },
    {
      loadConfig: async () => config,
      runRequest: async (_config, input) => {
        capturedInput = input;
        return okResult(input);
      },
    },
  );

  assert.equal(capturedInput?.workflow, "explore");
  assert.equal(capturedInput?.model, "gpt-5.5");
  assert.equal(capturedInput?.modelReasoningEffort, "high");
  assert.equal(capturedInput?.turnTimeoutMs, 123);
  assert.equal(capturedInput?.interruptOnTimeout, false);
  assert.deepEqual(capturedInput?.context, [
    {
      kind: "caveat_entry",
      source: "caveat",
      trust: "local",
      summary: "Remember the local hook caveat.",
    },
  ]);
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.status, "ok");
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? "{}"), result.structuredContent);
});

test("handleCodexSidecarToolCall routes codex_auditor through core", async () => {
  let capturedInput: RequestInput | undefined;
  const result = await handleCodexSidecarToolCall(
    "codex_auditor",
    {
      projectRoot: "/repo",
      prompt: "Judge whether Caveat should be called.",
      dryRun: true,
    },
    {
      loadConfig: async () => config,
      runRequest: async (_config, input) => {
        capturedInput = input;
        return {
          ...okResult(input),
          pass: false,
          missingTools: [{ name: "mcp__caveat__caveat_search", reason: "Known traps requested." }],
        };
      },
    },
  );

  assert.equal(capturedInput?.workflow, "auditor");
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.pass, false);
  assert.equal(result.structuredContent.missingTools?.[0]?.name, "mcp__caveat__caveat_search");
});

test("handleCodexSidecarToolCall refuses codex_work without explicit opt-in", async () => {
  const result = await handleCodexSidecarToolCall("codex_work", { projectRoot: "/repo", prompt: "Change code." });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, "refused");
  assert.equal(result.structuredContent.error?.code, "SAFETY_REFUSAL");
});

test("handleCodexSidecarToolCall returns structured input errors", async () => {
  const result = await handleCodexSidecarToolCall("codex_explore", {
    projectRoot: "/repo",
    model: " ",
    turnTimeoutMs: 0,
    modelReasoningEffort: "none",
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, "CONFIG_INVALID");
  assert.match(result.structuredContent.summary, /model must be a non-empty string/);
  assert.match(result.structuredContent.summary, /modelReasoningEffort/);
});

test("stdio server starts when invoked through a symlinked bin path", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-sidecar-mcp-"));
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "server.js");
  const linkedPath = join(tempDir, "codex-sidecar-mcp");
  symlinkSync(serverPath, linkedPath);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [linkedPath],
  });
  const client = new Client({ name: "codex-sidecar-test", version: "0.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const tools = await client.listTools();

    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      toolDescriptors.map((tool) => tool.name),
    );
  } finally {
    await client.close().catch(() => undefined);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function okResult(input: RequestInput): SidecarResult {
  return {
    status: "ok",
    workflow: input.workflow,
    summary: "ok",
    confidence: { level: "high" },
    recommendedNextAction: "done",
    normalizedRequest: {
      workflow: input.workflow,
      projectRoot: input.projectRoot,
      prompt: input.prompt,
      model: input.model,
      modelReasoningEffort: input.modelReasoningEffort,
      readonly: true,
      requireWorktree: false,
      focus: [],
      allowedPaths: [],
      denyPaths: [],
      safetyProfile: "generic",
      resultFormat: "json",
      turnTimeoutMs: input.turnTimeoutMs ?? 600_000,
      interruptOnTimeout: input.interruptOnTimeout ?? true,
      preserveWorktree: input.preserveWorktree ?? true,
      context: [],
      dryRun: input.dryRun ?? false,
    },
  };
}
