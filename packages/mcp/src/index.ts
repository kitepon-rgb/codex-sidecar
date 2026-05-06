import {
  CONFIG_FILE,
  DEFAULT_TURN_TIMEOUT_MS,
  UNKNOWN_CONFIDENCE,
  WORKFLOWS,
  buildEcosystemContextBlocks,
  loadSidecarConfig,
  runSidecarRequest,
  toSidecarError,
  type RequestInput,
  type ModelReasoningEffort,
  type SidecarConfig,
  type SidecarContextBlock,
  type SidecarError,
  type SidecarResult,
  type SidecarWorkflow,
} from "codex-sidecar-core";

export const TOOL_NAMES = [
  "codex_review",
  "codex_explore",
  "codex_work",
  "codex_opinion",
  "codex_risk_check",
  "codex_auditor",
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

export interface CodexSidecarToolInput {
  projectRoot: string;
  configFile?: string;
  prompt?: string;
  preset?: string;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  dryRun?: boolean;
  turnTimeoutMs?: number;
  interruptOnTimeout?: boolean;
  allowWork?: boolean;
  preserveWorktree?: boolean;
  context?: SidecarContextBlock[];
}

export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: SidecarResult;
  isError: boolean;
}

export interface McpExecutionDependencies {
  loadConfig?: (projectRoot: string, configFile?: string) => Promise<SidecarConfig>;
  runRequest?: (config: SidecarConfig, input: RequestInput) => Promise<SidecarResult>;
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
  configFile: {
    type: "string",
    description: `Optional config filename relative to projectRoot. Defaults to ${CONFIG_FILE}.`,
  },
  model: {
    type: "string",
    description: "Explicit Codex model to pass to App Server startup.",
  },
  modelReasoningEffort: {
    type: "string",
    enum: ["low", "medium", "high", "xhigh"],
    description: "Explicit Codex model reasoning effort to pass to App Server startup.",
  },
  dryRun: {
    type: "boolean",
    description: "Normalize and safety-check the request without calling Codex.",
  },
  turnTimeoutMs: {
    type: "integer",
    minimum: 1,
    description: "Maximum milliseconds to wait for the App Server turn to complete.",
  },
  interruptOnTimeout: {
    type: "boolean",
    description: "Whether to send App Server turn/interrupt when the turn timeout is reached.",
  },
  allowWork: {
    type: "boolean",
    description: "Required explicit opt-in for codex_work. Ignored by read-only tools.",
  },
  preserveWorktree: {
    type: "boolean",
    description: "Whether codex_work should keep the isolated worktree for review. Defaults to true.",
  },
  context: {
    type: "array",
    description: "Optional sidecar context blocks, such as Caveat caveat_entry blocks.",
    items: {
      type: "object",
      additionalProperties: true,
    },
  },
} as const;

export const toolDescriptors: McpToolDescriptor[] = [
  descriptor("codex_review", "review", "Ask Codex to review the current diff, branch, or patch.", true),
  descriptor("codex_explore", "explore", "Ask Codex to investigate a codebase question with file references.", true),
  descriptor("codex_work", "work", "Ask Codex to implement a small scoped change in an isolated worktree.", false),
  descriptor("codex_opinion", "opinion", "Ask Codex for a design second opinion and strongest objections.", true),
  descriptor("codex_risk_check", "risk-check", "Ask Codex to focus on high-risk areas such as MCP, OAuth, secrets, hooks, Docker, and CI.", true),
  descriptor("codex_auditor", "auditor", "Ask Codex for a primary tool-use auditor judgment with pass and missingTools.", true),
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

export async function handleCodexSidecarToolCall(
  toolName: CodexSidecarToolName,
  rawInput: unknown,
  dependencies: McpExecutionDependencies = {},
): Promise<McpToolCallResult> {
  const input = parseToolInput(rawInput);
  if ("error" in input) {
    return toMcpToolCallResult(input.error);
  }

  const workflow = workflowForTool(toolName);
  if (workflow === "work" && input.value.allowWork !== true) {
    return toMcpToolCallResult(
      mcpErrorResult(workflow, input.value.projectRoot, "SAFETY_REFUSAL", "SAFETY_REFUSAL: codex_work requires allowWork=true"),
    );
  }

  const loadConfig = dependencies.loadConfig ?? loadSidecarConfig;
  const runRequest = dependencies.runRequest ?? runSidecarRequest;

  try {
    const config = await loadConfig(input.value.projectRoot, input.value.configFile ?? CONFIG_FILE);
    const result = await runRequest(config, {
      workflow,
      projectRoot: input.value.projectRoot,
      prompt: input.value.prompt,
      preset: input.value.preset,
      model: input.value.model,
      modelReasoningEffort: input.value.modelReasoningEffort,
      dryRun: input.value.dryRun,
      turnTimeoutMs: input.value.turnTimeoutMs,
      interruptOnTimeout: input.value.interruptOnTimeout,
      preserveWorktree: input.value.preserveWorktree,
      context: input.value.context,
    });
    return toMcpToolCallResult(result);
  } catch (error) {
    const sidecarError = toSidecarError(error);
    return toMcpToolCallResult(mcpErrorResult(workflow, input.value.projectRoot, sidecarError.code, sidecarError.message));
  }
}

export function toMcpToolCallResult(result: SidecarResult): McpToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: result.status === "failed" || result.status === "refused",
  };
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

function parseToolInput(rawInput: unknown): { value: CodexSidecarToolInput } | { error: SidecarResult } {
  if (!isRecord(rawInput)) {
    return {
      error: mcpErrorResult("explore", "", "CONFIG_INVALID", "CONFIG_INVALID: MCP tool input must be an object"),
    };
  }

  const projectRoot = rawInput.projectRoot;
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return {
      error: mcpErrorResult("explore", "", "CONFIG_INVALID", "CONFIG_INVALID: projectRoot must be a non-empty string"),
    };
  }

  const errors: string[] = [];
  const input: CodexSidecarToolInput = { projectRoot };
  copyOptionalString(rawInput, input, "configFile", errors);
  copyOptionalString(rawInput, input, "prompt", errors);
  copyOptionalString(rawInput, input, "preset", errors);
  copyOptionalString(rawInput, input, "model", errors);
  copyOptionalBoolean(rawInput, input, "dryRun", errors);
  copyOptionalBoolean(rawInput, input, "interruptOnTimeout", errors);
  copyOptionalBoolean(rawInput, input, "allowWork", errors);
  copyOptionalBoolean(rawInput, input, "preserveWorktree", errors);

  if ("turnTimeoutMs" in rawInput) {
    if (typeof rawInput.turnTimeoutMs !== "number" || !Number.isInteger(rawInput.turnTimeoutMs) || rawInput.turnTimeoutMs < 1) {
      errors.push("turnTimeoutMs must be a positive integer");
    } else {
      input.turnTimeoutMs = rawInput.turnTimeoutMs;
    }
  }

  if ("modelReasoningEffort" in rawInput) {
    if (isModelReasoningEffort(rawInput.modelReasoningEffort)) {
      input.modelReasoningEffort = rawInput.modelReasoningEffort;
    } else {
      errors.push("modelReasoningEffort must be one of: low, medium, high, xhigh");
    }
  }

  if ("context" in rawInput) {
    if (!Array.isArray(rawInput.context)) {
      errors.push("context must be an array");
    } else {
      try {
        input.context = buildEcosystemContextBlocks(
          rawInput.context as Parameters<typeof buildEcosystemContextBlocks>[0],
        );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (errors.length > 0) {
    return {
      error: mcpErrorResult("explore", projectRoot, "CONFIG_INVALID", `CONFIG_INVALID: ${errors.join("; ")}`),
    };
  }

  return { value: input };
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: CodexSidecarToolInput,
  key: "configFile" | "prompt" | "preset" | "model",
  errors: string[],
): void {
  if (!(key in source)) {
    return;
  }

  if (typeof source[key] !== "string") {
    errors.push(`${key} must be a string`);
    return;
  }

  if (key === "model" && source[key].trim().length === 0) {
    errors.push("model must be a non-empty string");
    return;
  }

  target[key] = source[key];
}

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function copyOptionalBoolean(
  source: Record<string, unknown>,
  target: CodexSidecarToolInput,
  key: "dryRun" | "interruptOnTimeout" | "allowWork" | "preserveWorktree",
  errors: string[],
): void {
  if (!(key in source)) {
    return;
  }

  if (typeof source[key] !== "boolean") {
    errors.push(`${key} must be a boolean`);
    return;
  }

  target[key] = source[key];
}

function mcpErrorResult(
  workflow: SidecarWorkflow,
  projectRoot: string,
  code: SidecarError["code"],
  message: string,
): SidecarResult {
  return {
    status: code === "SAFETY_REFUSAL" ? "refused" : "failed",
    workflow,
    summary: message,
    confidence: UNKNOWN_CONFIDENCE,
    recommendedNextAction: "Fix the MCP tool input or sidecar configuration, then retry. No fallback path was used.",
    normalizedRequest: {
      workflow,
      projectRoot,
      readonly: workflow !== "work",
      requireWorktree: workflow === "work",
      focus: [],
      allowedPaths: [],
      denyPaths: [],
      safetyProfile: "generic",
      resultFormat: "json",
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      interruptOnTimeout: true,
      preserveWorktree: true,
      context: [],
      dryRun: false,
    },
    error: {
      code,
      message,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
