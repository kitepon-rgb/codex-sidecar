#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  handleCodexSidecarToolCall,
  toolDescriptors,
  type CodexSidecarToolName,
} from "./index.js";
import {
  startCodexSidecarMcpHttpServerFromEnv,
  type CodexSidecarMcpHttpServer,
} from "./server-http.js";

const legacyToolInputSchema = {
  projectRoot: z.string().min(1).describe("Absolute path to the project root containing .codex-sidecar.yml."),
  configFile: z
    .string()
    .optional()
    .describe("Optional config filename relative to projectRoot. Defaults to .codex-sidecar.yml."),
  prompt: z.string().optional().describe("User request or task-specific instruction for Codex."),
  preset: z.string().optional().describe("Optional preset name from .codex-sidecar.yml."),
  outputContract: z
    .string()
    .optional()
    .describe(
      "codex_generate only: JSON output contract/schema the generated JSON must conform to. Injected verbatim into the generation prompt.",
    ),
  model: z.string().min(1).optional().describe("Explicit Codex model to pass to App Server startup."),
  modelReasoningEffort: z
    .enum(["low", "medium", "high", "xhigh"])
    .optional()
    .describe("Explicit Codex model reasoning effort to pass to App Server startup."),
  dryRun: z.boolean().optional().describe("Normalize and safety-check the request without calling Codex."),
  turnTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum milliseconds to wait for the App Server turn to complete."),
  interruptOnTimeout: z
    .boolean()
    .optional()
    .describe("Whether to send App Server turn/interrupt when the turn timeout is reached."),
  allowWork: z
    .boolean()
    .optional()
    .describe("Required explicit opt-in for codex_work. Ignored by read-only tools."),
  preserveWorktree: z
    .boolean()
    .optional()
    .describe("Whether codex_work should keep the isolated worktree for review. Defaults to true."),
  context: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Optional sidecar context blocks, such as Caveat caveat_entry blocks."),
};

const workLookupInputSchema = {
  projectRoot: legacyToolInputSchema.projectRoot,
  idempotencyKey: z
    .string()
    .min(1)
    .describe("Caller-held idempotency key used to find the exact durable work run."),
};

const workStartInputSchema = {
  ...legacyToolInputSchema,
  ...workLookupInputSchema,
  baseRef: z.string().min(1).optional().describe("Optional base ref fixed into the durable work manifest. Defaults to HEAD."),
};

const workRecoveryInputSchema = {
  ...workLookupInputSchema,
  action: z.enum(["quarantine"]).optional().describe("Optional operator mutation. Omit for read-only inspection."),
  confirmNoRunningProcesses: z.boolean().optional().describe("Required and must be true for action=quarantine."),
};

const workAuthRecoveryInputSchema = {
  ...workLookupInputSchema,
  strategy: z
    .enum(["write-back-run-local", "keep-canonical-after-login", "release-never-started", "release-clean"])
    .optional()
    .describe("Optional explicit auth recovery strategy. Omit for read-only inspection."),
  confirmNoRunningProcesses: z.boolean().optional().describe("Required and must be true when strategy is supplied."),
};

export function buildCodexSidecarMcpServer(): McpServer {
  const server = new McpServer(
    { name: "codex-sidecar", version: "0.3.3" },
    { capabilities: { tools: {} } },
  );

  for (const descriptor of toolDescriptors) {
    server.registerTool(
      descriptor.name,
      {
        title: descriptor.name,
        description: descriptor.description,
        inputSchema: inputSchemaForTool(descriptor.name),
      },
      async (args: unknown) => {
        const result = await handleCodexSidecarToolCall(
          descriptor.name as CodexSidecarToolName,
          args,
        );
        return {
          content: result.content,
          structuredContent: result.structuredContent as unknown as Record<string, unknown>,
          isError: result.isError,
        };
      },
    );
  }

  return server;
}

function inputSchemaForTool(toolName: CodexSidecarToolName) {
  switch (toolName) {
    case "codex_work_start": return workStartInputSchema;
    case "codex_work_result":
    case "codex_work_cancel": return workLookupInputSchema;
    case "codex_work_recover": return workRecoveryInputSchema;
    case "codex_work_auth_recover": return workAuthRecoveryInputSchema;
    default: return legacyToolInputSchema;
  }
}

export async function startCodexSidecarMcpStdioServer(): Promise<void> {
  const server = buildCodexSidecarMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function normalizeEntrypointPath(path: string): string {
  return realpathSync(path).replace(/\\/g, "/").toLowerCase();
}

const invokedPath = process.argv[1] ?? "";
const thisPath = fileURLToPath(import.meta.url);

if (invokedPath && normalizeEntrypointPath(invokedPath) === normalizeEntrypointPath(thisPath)) {
  startFromEnv().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[codex-sidecar:mcp:error] ${msg}\n`);
    process.exit(1);
  });
}

async function startFromEnv(): Promise<void> {
  const transport = (process.env.CODEX_SIDECAR_MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http") {
    const http: CodexSidecarMcpHttpServer = await startCodexSidecarMcpHttpServerFromEnv();
    process.stderr.write(
      `[codex-sidecar:mcp:http] listening on ${http.host}:${http.port} (bearer=${http.bearerEnabled ? "enabled" : "disabled"})\n`,
    );
    const onSignal = (sig: NodeJS.Signals): void => {
      process.stderr.write(`[codex-sidecar:mcp:http] received ${sig}, shutting down\n`);
      http.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return;
  }
  if (transport !== "stdio") {
    throw new Error(
      `CODEX_SIDECAR_MCP_TRANSPORT must be "stdio" or "http"; received "${transport}"`,
    );
  }
  await startCodexSidecarMcpStdioServer();
}
