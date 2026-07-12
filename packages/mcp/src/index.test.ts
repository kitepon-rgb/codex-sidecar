import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  handleCodexSidecarToolCall,
  toMcpToolCallResult,
  toolDescriptors,
  type McpStructuredContent,
} from "./index.js";
import {
  WorkAuthRecoveryStrategy,
  type RequestInput,
  type SidecarConfig,
  type SidecarResult,
  type SidecarRunCancelResult,
  type SidecarRunOperationError,
  type SidecarRunPollResult,
  type SidecarRunStartResult,
  type SidecarRunTerminal,
  type WorkAuthRecoveryAck,
  type WorkAuthRecoveryInspection,
  type WorkRecoveryInspection,
} from "codex-sidecar-core";

const key = "abcdefghijklmnopqrstuv";

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

test("durable work tool descriptors separate start input from lookup input", () => {
  const start = requireDescriptor("codex_work_start");
  const result = requireDescriptor("codex_work_result");
  const cancel = requireDescriptor("codex_work_cancel");
  const recovery = requireDescriptor("codex_work_recover");
  const authRecovery = requireDescriptor("codex_work_auth_recover");

  assert.equal(start.requiresExplicitOptIn, true);
  assert.deepEqual(start.inputSchema.required, ["projectRoot", "idempotencyKey"]);
  assert.deepEqual(result.inputSchema.required, ["projectRoot", "idempotencyKey"]);
  assert.deepEqual(cancel.inputSchema.required, ["projectRoot", "idempotencyKey"]);
  assert.equal("prompt" in result.inputSchema.properties, false);
  assert.equal("configFile" in result.inputSchema.properties, false);
  assert.equal("allowWork" in result.inputSchema.properties, false);
  assert.equal("action" in recovery.inputSchema.properties, true);
  assert.equal("strategy" in authRecovery.inputSchema.properties, true);
  assert.deepEqual(
    (authRecovery.inputSchema.properties.strategy as { enum: string[] }).enum,
    Object.values(WorkAuthRecoveryStrategy),
  );
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
  assert.equal(asSidecarResult(result.structuredContent).status, "ok");
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
  const content = asSidecarResult(result.structuredContent);
  assert.equal(content.pass, false);
  assert.equal(content.missingTools?.[0]?.name, "mcp__caveat__caveat_search");
});

test("tool descriptors expose codex_generate as a read-only workflow with an outputContract field", () => {
  const descriptor = toolDescriptors.find((tool) => tool.name === "codex_generate");
  assert.ok(descriptor);
  assert.equal(descriptor.workflow, "generate");
  assert.equal(descriptor.readonly, true);
  assert.equal(descriptor.requiresExplicitOptIn, false);
  const outputContract = descriptor.inputSchema.properties.outputContract as { type: string };
  assert.equal(outputContract.type, "string");
});

test("handleCodexSidecarToolCall routes codex_generate through core with outputContract", async () => {
  let capturedInput: RequestInput | undefined;
  const result = await handleCodexSidecarToolCall(
    "codex_generate",
    {
      projectRoot: "/repo",
      prompt: "Generate two example sentences as JSON.",
      outputContract: '{ "items": [{ "en": string, "ja": string }] }',
      dryRun: true,
    },
    {
      loadConfig: async () => config,
      runRequest: async (_config, input) => {
        capturedInput = input;
        return { ...okResult(input), generated: { items: [{ en: "Hi.", ja: "やあ。" }] } };
      },
    },
  );

  assert.equal(capturedInput?.workflow, "generate");
  assert.equal(capturedInput?.outputContract, '{ "items": [{ "en": string, "ja": string }] }');
  assert.equal(result.isError, false);
  assert.deepEqual(asSidecarResult(result.structuredContent).generated, { items: [{ en: "Hi.", ja: "やあ。" }] });
});

test("handleCodexSidecarToolCall refuses codex_work without explicit opt-in", async () => {
  const result = await handleCodexSidecarToolCall("codex_work", { projectRoot: "/repo", prompt: "Change code." });

  assert.equal(result.isError, true);
  const content = asSidecarResult(result.structuredContent);
  assert.equal(content.status, "refused");
  assert.equal(content.error?.code, "SAFETY_REFUSAL");
});

test("handleCodexSidecarToolCall returns structured input errors", async () => {
  const result = await handleCodexSidecarToolCall("codex_explore", {
    projectRoot: "/repo",
    model: " ",
    turnTimeoutMs: 0,
    modelReasoningEffort: "none",
  });

  assert.equal(result.isError, true);
  const content = asSidecarResult(result.structuredContent);
  assert.equal(content.error?.code, "CONFIG_INVALID");
  assert.match(content.summary, /model must be a non-empty string/);
  assert.match(content.summary, /modelReasoningEffort/);
});

test("codex_work_start defers config loading until the durable start implementation needs it", async () => {
  let configLoads = 0;
  let capturedInput: Record<string, unknown> | undefined;
  const terminal = terminalResult();
  const result = await handleCodexSidecarToolCall(
    "codex_work_start",
    {
      projectRoot: "/repo",
      idempotencyKey: key,
      prompt: "Change README.",
      allowWork: true,
      dryRun: true,
    },
    {
      loadConfig: async () => {
        configLoads += 1;
        return config;
      },
      startWork: async (configSource, input) => {
        assert.equal(typeof configSource, "function");
        capturedInput = input;
        return terminal;
      },
    },
  );

  assert.equal(configLoads, 0);
  assert.equal(capturedInput?.projectRoot, "/repo");
  assert.equal(capturedInput?.idempotencyKey, key);
  assert.equal(capturedInput?.prompt, "Change README.");
  assert.equal(capturedInput?.dryRun, true);
  assert.deepEqual(result.structuredContent, terminal);

  const refused = await handleCodexSidecarToolCall(
    "codex_work_start",
    { projectRoot: "/repo", idempotencyKey: key, prompt: "Change README." },
  );
  assert.equal(refused.isError, true);
  assert.equal(asRunError(refused.structuredContent).error.code, "RUN_INVALID_INPUT");
});

test("durable work result and cancel only use caller-held lookup identity", async () => {
  const pending: SidecarRunPollResult = {
    kind: "run_pending",
    runId: "run-1",
    state: "running",
    phase: "app-server",
    pollAfterMs: 250,
  };
  const cancellation: SidecarRunCancelResult = {
    kind: "run_cancel_ack",
    runId: "run-1",
    accepted: true,
    terminal: false,
    state: "cancellation_requested",
    mode: "cooperative",
    pollAfterMs: 250,
  };
  let configLoads = 0;
  const dependencies = {
    loadConfig: async () => {
      configLoads += 1;
      return config;
    },
    getWorkResult: async (input: { projectRoot: string; idempotencyKey: string }) => {
      assert.deepEqual(input, { projectRoot: "/repo", idempotencyKey: key });
      return pending;
    },
    cancelWork: async (input: { projectRoot: string; idempotencyKey: string }) => {
      assert.deepEqual(input, { projectRoot: "/repo", idempotencyKey: key });
      return cancellation;
    },
  };

  const result = await handleCodexSidecarToolCall(
    "codex_work_result",
    { projectRoot: "/repo", idempotencyKey: key },
    dependencies,
  );
  const cancel = await handleCodexSidecarToolCall(
    "codex_work_cancel",
    { projectRoot: "/repo", idempotencyKey: key },
    dependencies,
  );

  assert.equal(configLoads, 0);
  assert.deepEqual(result.structuredContent, pending);
  assert.deepEqual(cancel.structuredContent, cancellation);
});

test("durable work recovery is read-only by default and requires explicit quarantine confirmation", async () => {
  const inspection: WorkRecoveryInspection = {
    kind: "work_recovery_inspection",
    runId: "run-1",
    runDirectory: "/repo/.git/codex-sidecar/runs/run-1",
    status: {
      kind: "run_pending",
      runId: "run-1",
      state: "running",
      phase: "app-server",
      pollAfterMs: 250,
    },
    quarantinePublished: false,
    outcome: "inspection",
  };
  let recovered = false;
  const dependencies = {
    inspectWorkRecovery: async () => inspection,
    recoverWork: async (input: { action?: string; confirmNoRunningProcesses?: boolean }) => {
      assert.deepEqual(input, {
        projectRoot: "/repo",
        idempotencyKey: key,
        action: "quarantine",
        confirmNoRunningProcesses: true,
      });
      recovered = true;
      return { ...inspection, quarantinePublished: true, outcome: "quarantined" as const };
    },
  };

  const readOnly = await handleCodexSidecarToolCall(
    "codex_work_recover",
    { projectRoot: "/repo", idempotencyKey: key },
    dependencies,
  );
  assert.deepEqual(readOnly.structuredContent, inspection);
  assert.equal(recovered, false);

  const unconfirmed = await handleCodexSidecarToolCall(
    "codex_work_recover",
    { projectRoot: "/repo", idempotencyKey: key, action: "quarantine" },
    dependencies,
  );
  assert.equal(asRunError(unconfirmed.structuredContent).error.code, "RUN_INVALID_INPUT");
  assert.equal(recovered, false);

  const confirmed = await handleCodexSidecarToolCall(
    "codex_work_recover",
    { projectRoot: "/repo", idempotencyKey: key, action: "quarantine", confirmNoRunningProcesses: true },
    dependencies,
  );
  assert.equal(recovered, true);
  assert.equal((confirmed.structuredContent as WorkRecoveryInspection).outcome, "quarantined");
});

test("durable work auth recovery accepts exactly the shared four strategies", async () => {
  const inspection: WorkAuthRecoveryInspection = {
    kind: "work_auth_inspection",
    runId: "run-1",
    runDirectory: "/repo/.git/codex-sidecar/runs/run-1",
    expectedJournalPath: "/repo/.git/codex-sidecar/runs/run-1/auth",
    ownership: "available",
    auth: { state: "available" },
  };
  const recovered: WorkAuthRecoveryStrategy[] = [];
  let inspectionCalls = 0;
  const ack: Omit<WorkAuthRecoveryAck, "strategy"> = {
    kind: "work_auth_recovery_ack",
    outcome: "recovered",
    runId: "run-1",
    runDirectory: "/repo/.git/codex-sidecar/runs/run-1",
    expectedJournalPath: "/repo/.git/codex-sidecar/runs/run-1/auth",
    target: {
      ownerKind: "work-run",
      ownerId: "run-1",
      journalPath: "/repo/.git/codex-sidecar/runs/run-1/auth",
      canonicalAuthPath: "/home/test/.codex/auth.json",
      token: "A".repeat(43),
    },
    operatorRecoveryRecordPath: "/repo/.git/codex-sidecar/runs/run-1/auth/operator-recovery.json",
  };
  const dependencies = {
    inspectWorkAuthRecovery: async () => {
      inspectionCalls += 1;
      return inspection;
    },
    recoverWorkAuth: async (input: { strategy: WorkAuthRecoveryStrategy; confirmNoRunningProcesses: boolean }) => {
      recovered.push(input.strategy);
      return { ...ack, strategy: input.strategy };
    },
  };

  for (const strategy of Object.values(WorkAuthRecoveryStrategy)) {
    const result = await handleCodexSidecarToolCall(
      "codex_work_auth_recover",
      { projectRoot: "/repo", idempotencyKey: key, strategy, confirmNoRunningProcesses: true },
      dependencies,
    );
    assert.deepEqual(result.structuredContent, { ...ack, strategy });
  }
  assert.deepEqual(recovered, Object.values(WorkAuthRecoveryStrategy));
  assert.equal(inspectionCalls, 0, "mutation must return its bound ack without a post-recovery inspection");

  const readOnly = await handleCodexSidecarToolCall(
    "codex_work_auth_recover",
    { projectRoot: "/repo", idempotencyKey: key },
    dependencies,
  );
  assert.deepEqual(readOnly.structuredContent, inspection);
  assert.equal(inspectionCalls, 1);

  const unknown = await handleCodexSidecarToolCall(
    "codex_work_auth_recover",
    { projectRoot: "/repo", idempotencyKey: key, strategy: "not-a-strategy", confirmNoRunningProcesses: true },
    dependencies,
  );
  assert.equal(asRunError(unknown.structuredContent).error.code, "RUN_INVALID_INPUT");
});

test("MCP marks failed durable terminal results as tool errors", () => {
  const failed: SidecarRunTerminal = {
    kind: "run_terminal",
    runId: "run-1",
    state: "failed",
    result: { ...okResult({ workflow: "work", projectRoot: "/repo" }), status: "failed" },
    cleanup: "not-requested",
  };
  const cancelled: SidecarRunTerminal = {
    ...failed,
    state: "cancelled",
    result: { ...failed.result, status: "failed" },
  };
  assert.equal(toMcpToolCallResult(failed).isError, true);
  assert.equal(toMcpToolCallResult(cancelled).isError, false);
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
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    assert.equal(client.getServerVersion()?.version, manifest.version);
    const tools = await client.listTools();

    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      toolDescriptors.map((tool) => tool.name),
    );
    const start = tools.tools.find((tool) => tool.name === "codex_work_start");
    const result = tools.tools.find((tool) => tool.name === "codex_work_result");
    assert.ok(start);
    assert.ok(result);
    const startSchema = start.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    const resultSchema = result.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    assert.deepEqual(startSchema.required, ["projectRoot", "idempotencyKey"]);
    assert.deepEqual(resultSchema.required, ["projectRoot", "idempotencyKey"]);
    assert.equal("prompt" in (resultSchema.properties ?? {}), false);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function requireDescriptor(name: string) {
  const descriptor = toolDescriptors.find((tool) => tool.name === name);
  assert.ok(descriptor, `missing descriptor: ${name}`);
  return descriptor;
}

function asSidecarResult(content: McpStructuredContent): SidecarResult {
  assert.ok("status" in content && "workflow" in content, "expected SidecarResult structured content");
  return content as SidecarResult;
}

function asRunError(content: McpStructuredContent): SidecarRunOperationError {
  assert.ok("kind" in content && content.kind === "run_error", "expected run_error structured content");
  return content as SidecarRunOperationError;
}

function terminalResult(): SidecarRunStartResult {
  return {
    kind: "run_terminal",
    runId: "run-1",
    state: "completed",
    result: okResult({ workflow: "work", projectRoot: "/repo", prompt: "Change README.", dryRun: true }),
    cleanup: "not-requested",
  };
}

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
