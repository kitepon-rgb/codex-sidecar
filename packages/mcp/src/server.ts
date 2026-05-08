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

const toolInputSchema = {
  projectRoot: z.string().min(1).describe("Absolute path to the project root containing .codex-sidecar.yml."),
  configFile: z
    .string()
    .optional()
    .describe("Optional config filename relative to projectRoot. Defaults to .codex-sidecar.yml."),
  prompt: z.string().optional().describe("User request or task-specific instruction for Codex."),
  preset: z.string().optional().describe("Optional preset name from .codex-sidecar.yml."),
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

export async function startCodexSidecarMcpStdioServer(): Promise<void> {
  const server = new McpServer(
    { name: "codex-sidecar", version: "0.3.1" },
    { capabilities: { tools: {} } },
  );

  for (const descriptor of toolDescriptors) {
    server.registerTool(
      descriptor.name,
      {
        title: descriptor.name,
        description: descriptor.description,
        inputSchema: toolInputSchema,
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function normalizeEntrypointPath(path: string): string {
  return realpathSync(path).replace(/\\/g, "/").toLowerCase();
}

const invokedPath = process.argv[1] ?? "";
const thisPath = fileURLToPath(import.meta.url);

if (invokedPath && normalizeEntrypointPath(invokedPath) === normalizeEntrypointPath(thisPath)) {
  startCodexSidecarMcpStdioServer().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[codex-sidecar:mcp:error] ${msg}\n`);
    process.exit(1);
  });
}
