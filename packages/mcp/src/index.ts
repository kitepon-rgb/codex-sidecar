import { WORKFLOWS, type SidecarWorkflow } from "@codex-sidecar/core";

export const TOOL_NAMES = [
  "codex_review",
  "codex_explore",
  "codex_work",
  "codex_opinion",
  "codex_risk_check",
] as const;

export type CodexSidecarToolName = (typeof TOOL_NAMES)[number];

export interface McpToolDescriptor {
  name: CodexSidecarToolName;
  workflow: SidecarWorkflow;
  description: string;
  readonly: boolean;
  requiresExplicitOptIn: boolean;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

const commonProperties = {
  projectRoot: {
    type: "string",
    description: "Absolute path to the project root containing .codex-sidecar.yml.",
  },
  prompt: {
    type: "string",
    description: "User request or task-specific instruction for Codex.",
  },
  preset: {
    type: "string",
    description: "Optional preset name from .codex-sidecar.yml.",
  },
  dryRun: {
    type: "boolean",
    description: "Normalize and safety-check the request without calling Codex.",
  },
} as const;

export const toolDescriptors: McpToolDescriptor[] = [
  descriptor("codex_review", "review", "Ask Codex to review the current diff, branch, or patch.", true),
  descriptor("codex_explore", "explore", "Ask Codex to investigate a codebase question with file references.", true),
  descriptor("codex_work", "work", "Ask Codex to implement a small scoped change in an isolated worktree.", false),
  descriptor("codex_opinion", "opinion", "Ask Codex for a design second opinion and strongest objections.", true),
  descriptor("codex_risk_check", "risk-check", "Ask Codex to focus on high-risk areas such as MCP, OAuth, secrets, hooks, Docker, and CI.", true),
];

export function workflowForTool(toolName: CodexSidecarToolName): SidecarWorkflow {
  const descriptor = toolDescriptors.find((candidate) => candidate.name === toolName);

  if (!descriptor) {
    throw new Error(`Unknown Codex sidecar tool: ${toolName}`);
  }

  return descriptor.workflow;
}

export function listWorkflows(): readonly SidecarWorkflow[] {
  return WORKFLOWS;
}

function descriptor(
  name: CodexSidecarToolName,
  workflow: SidecarWorkflow,
  description: string,
  readonly: boolean,
): McpToolDescriptor {
  return {
    name,
    workflow,
    description,
    readonly,
    requiresExplicitOptIn: workflow === "work",
    inputSchema: {
      type: "object",
      properties: commonProperties,
      required: ["projectRoot"],
      additionalProperties: false,
    },
  };
}
