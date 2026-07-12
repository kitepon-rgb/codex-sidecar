import {
  CONFIG_FILE,
  DEFAULT_TURN_TIMEOUT_MS,
  SIDECAR_RUN_ERROR_CODES,
  UNKNOWN_CONFIDENCE,
  WORKFLOWS,
  WorkAuthRecoveryStrategy,
  buildEcosystemContextBlocks,
  cancelWorkRun,
  getWorkRunResult,
  inspectWorkAuthRecovery,
  inspectWorkRecovery,
  loadSidecarConfig,
  recoverWorkAuthSession,
  recoverWorkRun,
  runSidecarRequest,
  startWorkRun,
  toSidecarError,
  type ModelReasoningEffort,
  type RequestInput,
  type SidecarConfig,
  type SidecarContextBlock,
  type SidecarError,
  type SidecarResult,
  type SidecarRunCancelResult,
  type SidecarRunErrorCode,
  type SidecarRunOperationError,
  type SidecarRunPollResult,
  type SidecarRunStartResult,
  type SidecarWorkflow,
  type WorkAuthRecoveryInspection,
  type WorkAuthRecoveryAck,
  type WorkRecoveryInspection,
} from "codex-sidecar-core";

export const TOOL_NAMES = [
  "codex_review",
  "codex_explore",
  "codex_work",
  "codex_opinion",
  "codex_risk_check",
  "codex_auditor",
  "codex_generate",
  "codex_work_start",
  "codex_work_result",
  "codex_work_cancel",
  "codex_work_recover",
  "codex_work_auth_recover",
] as const;

const LEGACY_TOOL_NAMES = [
  "codex_review",
  "codex_explore",
  "codex_work",
  "codex_opinion",
  "codex_risk_check",
  "codex_auditor",
  "codex_generate",
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

/** The common request fields used by the existing synchronous tools. */
export interface CodexSidecarToolInput {
  projectRoot: string;
  configFile?: string;
  prompt?: string;
  preset?: string;
  outputContract?: string;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  dryRun?: boolean;
  turnTimeoutMs?: number;
  interruptOnTimeout?: boolean;
  allowWork?: boolean;
  preserveWorktree?: boolean;
  context?: SidecarContextBlock[];
}

interface WorkStartToolInput extends CodexSidecarToolInput {
  idempotencyKey: string;
  baseRef?: string;
}

interface WorkLookupToolInput {
  projectRoot: string;
  idempotencyKey: string;
}

interface WorkRecoveryToolInput extends WorkLookupToolInput {
  action?: "quarantine";
}

interface WorkAuthRecoveryToolInput extends WorkLookupToolInput {
  strategy?: WorkAuthRecoveryStrategy;
}

export type McpStructuredContent =
  | SidecarResult
  | SidecarRunStartResult
  | SidecarRunPollResult
  | SidecarRunCancelResult
  | WorkRecoveryInspection
  | WorkAuthRecoveryInspection
  | WorkAuthRecoveryAck;

export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: McpStructuredContent;
  isError: boolean;
}

export interface McpExecutionDependencies {
  loadConfig?: (projectRoot: string, configFile?: string) => Promise<SidecarConfig>;
  runRequest?: (config: SidecarConfig, input: RequestInput) => Promise<SidecarResult>;
  startWork?: typeof startWorkRun;
  getWorkResult?: typeof getWorkRunResult;
  cancelWork?: typeof cancelWorkRun;
  inspectWorkRecovery?: typeof inspectWorkRecovery;
  recoverWork?: typeof recoverWorkRun;
  inspectWorkAuthRecovery?: typeof inspectWorkAuthRecovery;
  recoverWorkAuth?: typeof recoverWorkAuthSession;
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
  outputContract: {
    type: "string",
    description:
      "codex_generate only: JSON output contract/schema the generated JSON must conform to. Injected verbatim into the generation prompt.",
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
    description: "Required explicit opt-in for write-capable work starts. Ignored by read-only tools.",
  },
  preserveWorktree: {
    type: "boolean",
    description: "Whether work should keep the isolated worktree for review. Defaults to true.",
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

const lookupProperties = {
  projectRoot: commonProperties.projectRoot,
  idempotencyKey: {
    type: "string",
    description: "Caller-held 22–128 character retry key required to find the exact durable work run.",
  },
} as const;

export const toolDescriptors: McpToolDescriptor[] = [
  descriptor("codex_review", "review", "Ask Codex to review the current diff, branch, or patch.", true, false, commonProperties, ["projectRoot"]),
  descriptor("codex_explore", "explore", "Ask Codex to investigate a codebase question with file references.", true, false, commonProperties, ["projectRoot"]),
  descriptor("codex_work", "work", "Ask Codex to implement a small scoped change in an isolated worktree.", false, true, commonProperties, ["projectRoot"]),
  descriptor("codex_opinion", "opinion", "Ask Codex for a design second opinion and strongest objections.", true, false, commonProperties, ["projectRoot"]),
  descriptor("codex_risk_check", "risk-check", "Ask Codex to focus on high-risk areas such as MCP, OAuth, secrets, hooks, Docker, and CI.", true, false, commonProperties, ["projectRoot"]),
  descriptor("codex_auditor", "auditor", "Ask Codex for a primary tool-use auditor judgment with pass and missingTools.", true, false, commonProperties, ["projectRoot"]),
  descriptor("codex_generate", "generate", "Ask Codex to generate arbitrary structured JSON for a freeform task; returns the raw JSON in the result's generated field.", true, false, commonProperties, ["projectRoot"]),
  descriptor(
    "codex_work_start",
    "work",
    "Start an isolated durable codex_work run and return its caller-recoverable handle or terminal result.",
    false,
    true,
    { ...commonProperties, ...lookupProperties, baseRef: { type: "string", description: "Optional base ref fixed into the durable work manifest. Defaults to HEAD." } },
    ["projectRoot", "idempotencyKey"],
  ),
  descriptor("codex_work_result", "work", "Read a durable work run by its caller-held idempotency key without starting a worker.", true, false, lookupProperties, ["projectRoot", "idempotencyKey"]),
  descriptor("codex_work_cancel", "work", "Publish an idempotent cancellation intent for a durable work run.", false, false, lookupProperties, ["projectRoot", "idempotencyKey"]),
  descriptor(
    "codex_work_recover",
    "work",
    "Inspect a durable work run, or explicitly quarantine it only after process-stop confirmation.",
    false,
    false,
    {
      ...lookupProperties,
      action: { type: "string", enum: ["quarantine"], description: "Optional operator mutation. Omit for read-only inspection." },
      confirmNoRunningProcesses: { type: "boolean", description: "Required and must be true when action=quarantine." },
    },
    ["projectRoot", "idempotencyKey"],
  ),
  descriptor(
    "codex_work_auth_recover",
    "work",
    "Inspect or explicitly recover the exact durable auth lease owned by a work run.",
    false,
    false,
    {
      ...lookupProperties,
      strategy: { type: "string", enum: Object.values(WorkAuthRecoveryStrategy), description: "Optional explicit auth recovery strategy. Omit for read-only inspection." },
      confirmNoRunningProcesses: { type: "boolean", description: "Required and must be true when strategy is supplied." },
    },
    ["projectRoot", "idempotencyKey"],
  ),
];

export function workflowForTool(toolName: CodexSidecarToolName): SidecarWorkflow {
  const descriptor = toolDescriptors.find((candidate) => candidate.name === toolName);
  if (!descriptor) throw new Error(`Unknown Codex sidecar tool: ${toolName}`);
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
  if (isAsyncWorkTool(toolName)) return handleAsyncWorkToolCall(toolName, rawInput, dependencies);
  return handleLegacyToolCall(toolName, rawInput, dependencies);
}

async function handleLegacyToolCall(
  toolName: Extract<CodexSidecarToolName, (typeof LEGACY_TOOL_NAMES)[number]>,
  rawInput: unknown,
  dependencies: McpExecutionDependencies,
): Promise<McpToolCallResult> {
  const input = parseToolInput(rawInput);
  if ("error" in input) return toMcpToolCallResult(input.error);

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
      outputContract: input.value.outputContract,
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

async function handleAsyncWorkToolCall(
  toolName: Exclude<CodexSidecarToolName, (typeof LEGACY_TOOL_NAMES)[number]>,
  rawInput: unknown,
  dependencies: McpExecutionDependencies,
): Promise<McpToolCallResult> {
  try {
    switch (toolName) {
      case "codex_work_start": {
        const input = parseWorkStartInput(rawInput);
        if ("error" in input) return toMcpToolCallResult(runInputError(input.error));
        if (input.value.allowWork !== true) {
          return toMcpToolCallResult(runInputError("SAFETY_REFUSAL: codex_work_start requires allowWork=true"));
        }
        const loadConfig = dependencies.loadConfig ?? loadSidecarConfig;
        const start = dependencies.startWork ?? startWorkRun;
        return toMcpToolCallResult(await start(
          () => loadConfig(input.value.projectRoot, input.value.configFile ?? CONFIG_FILE),
          {
            projectRoot: input.value.projectRoot,
            idempotencyKey: input.value.idempotencyKey,
            baseRef: input.value.baseRef,
            prompt: input.value.prompt,
            preset: input.value.preset,
            outputContract: input.value.outputContract,
            model: input.value.model,
            modelReasoningEffort: input.value.modelReasoningEffort,
            dryRun: input.value.dryRun,
            turnTimeoutMs: input.value.turnTimeoutMs,
            interruptOnTimeout: input.value.interruptOnTimeout,
            preserveWorktree: input.value.preserveWorktree,
            context: input.value.context,
          },
        ));
      }
      case "codex_work_result": {
        const input = parseLookupInput(rawInput, ["projectRoot", "idempotencyKey"]);
        if ("error" in input) return toMcpToolCallResult(runInputError(input.error));
        return toMcpToolCallResult(await (dependencies.getWorkResult ?? getWorkRunResult)(input.value));
      }
      case "codex_work_cancel": {
        const input = parseLookupInput(rawInput, ["projectRoot", "idempotencyKey"]);
        if ("error" in input) return toMcpToolCallResult(runInputError(input.error));
        return toMcpToolCallResult(await (dependencies.cancelWork ?? cancelWorkRun)(input.value));
      }
      case "codex_work_recover": {
        const input = parseWorkRecoveryInput(rawInput);
        if ("error" in input) return toMcpToolCallResult(runInputError(input.error));
        if (input.value.action === "quarantine") {
          return toMcpToolCallResult(await (dependencies.recoverWork ?? recoverWorkRun)({
            ...input.value,
            action: "quarantine",
            confirmNoRunningProcesses: true,
          }));
        }
        return toMcpToolCallResult(await (dependencies.inspectWorkRecovery ?? inspectWorkRecovery)(input.value));
      }
      case "codex_work_auth_recover": {
        const input = parseWorkAuthRecoveryInput(rawInput);
        if ("error" in input) return toMcpToolCallResult(runInputError(input.error));
        if (input.value.strategy === undefined) {
          return toMcpToolCallResult(await (dependencies.inspectWorkAuthRecovery ?? inspectWorkAuthRecovery)(input.value));
        }
        const recover = dependencies.recoverWorkAuth ?? recoverWorkAuthSession;
        return toMcpToolCallResult(await recover({
          ...input.value,
          strategy: input.value.strategy,
          confirmNoRunningProcesses: true,
        }));
      }
    }
  } catch (error) {
    return toMcpToolCallResult(runOperationError(error));
  }
}

export function toMcpToolCallResult(result: McpStructuredContent): McpToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: isErrorResult(result),
  };
}

function isErrorResult(result: McpStructuredContent): boolean {
  if (isSidecarResult(result)) return result.status === "failed" || result.status === "refused";
  if (!("kind" in result)) return false;
  return result.kind === "run_error" || result.kind === "run_interrupted" ||
    result.kind === "run_terminal" && result.state === "failed";
}

function isSidecarResult(value: McpStructuredContent): value is SidecarResult {
  return "status" in value && "workflow" in value;
}

function descriptor(
  name: CodexSidecarToolName,
  workflow: SidecarWorkflow,
  description: string,
  readonly: boolean,
  requiresExplicitOptIn: boolean,
  properties: Record<string, unknown>,
  required: string[],
): McpToolDescriptor {
  return {
    name,
    workflow,
    description,
    readonly,
    requiresExplicitOptIn,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

function isAsyncWorkTool(
  toolName: CodexSidecarToolName,
): toolName is Exclude<CodexSidecarToolName, (typeof LEGACY_TOOL_NAMES)[number]> {
  return !(LEGACY_TOOL_NAMES as readonly string[]).includes(toolName);
}

function parseWorkStartInput(rawInput: unknown): { value: WorkStartToolInput } | { error: string } {
  const base = parseToolInput(rawInput);
  if ("error" in base) return { error: base.error.error?.message ?? base.error.summary };
  const raw = rawInput as Record<string, unknown>;
  const unknown = unknownKeys(raw, [
    "projectRoot", "configFile", "prompt", "preset", "outputContract", "model", "modelReasoningEffort", "dryRun",
    "turnTimeoutMs", "interruptOnTimeout", "allowWork", "preserveWorktree", "context", "idempotencyKey", "baseRef",
  ]);
  if (unknown) return { error: `unknown codex_work_start field: ${unknown}` };
  if (typeof raw.idempotencyKey !== "string" || raw.idempotencyKey.trim().length === 0) {
    return { error: "idempotencyKey must be a non-empty string" };
  }
  if ("baseRef" in raw && (typeof raw.baseRef !== "string" || raw.baseRef.trim().length === 0)) {
    return { error: "baseRef must be a non-empty string" };
  }
  return {
    value: {
      ...base.value,
      idempotencyKey: raw.idempotencyKey,
      ...(typeof raw.baseRef === "string" ? { baseRef: raw.baseRef } : {}),
    },
  };
}

function parseLookupInput(rawInput: unknown, allowed: readonly string[]): { value: WorkLookupToolInput } | { error: string } {
  if (!isRecord(rawInput)) return { error: "MCP tool input must be an object" };
  const unknown = unknownKeys(rawInput, allowed);
  if (unknown) return { error: `unknown work control field: ${unknown}` };
  if (typeof rawInput.projectRoot !== "string" || rawInput.projectRoot.trim().length === 0) {
    return { error: "projectRoot must be a non-empty string" };
  }
  if (typeof rawInput.idempotencyKey !== "string" || rawInput.idempotencyKey.trim().length === 0) {
    return { error: "idempotencyKey must be a non-empty string" };
  }
  return { value: { projectRoot: rawInput.projectRoot, idempotencyKey: rawInput.idempotencyKey } };
}

function parseWorkRecoveryInput(rawInput: unknown): { value: WorkRecoveryToolInput } | { error: string } {
  const lookup = parseLookupInput(rawInput, ["projectRoot", "idempotencyKey", "action", "confirmNoRunningProcesses"]);
  if ("error" in lookup) return lookup;
  const raw = rawInput as Record<string, unknown>;
  if (!("action" in raw)) {
    if ("confirmNoRunningProcesses" in raw) return { error: "confirmNoRunningProcesses is only valid with action=quarantine" };
    return lookup;
  }
  if (raw.action !== "quarantine") return { error: "action must be quarantine" };
  if (raw.confirmNoRunningProcesses !== true) return { error: "confirmNoRunningProcesses must be true for action=quarantine" };
  return { value: { ...lookup.value, action: "quarantine" } };
}

function parseWorkAuthRecoveryInput(rawInput: unknown): { value: WorkAuthRecoveryToolInput } | { error: string } {
  const lookup = parseLookupInput(rawInput, ["projectRoot", "idempotencyKey", "strategy", "confirmNoRunningProcesses"]);
  if ("error" in lookup) return lookup;
  const raw = rawInput as Record<string, unknown>;
  if (!("strategy" in raw)) {
    if ("confirmNoRunningProcesses" in raw) return { error: "confirmNoRunningProcesses is only valid with a recovery strategy" };
    return lookup;
  }
  if (!(Object.values(WorkAuthRecoveryStrategy) as string[]).includes(String(raw.strategy))) {
    return { error: `strategy must be one of: ${Object.values(WorkAuthRecoveryStrategy).join(", ")}` };
  }
  if (raw.confirmNoRunningProcesses !== true) return { error: "confirmNoRunningProcesses must be true for a recovery strategy" };
  return { value: { ...lookup.value, strategy: raw.strategy as WorkAuthRecoveryStrategy } };
}

function unknownKeys(source: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(source).find((key) => !allowed.includes(key));
}

function runInputError(message: string): SidecarRunOperationError {
  return {
    kind: "run_error",
    error: { code: "RUN_INVALID_INPUT", message: `RUN_INVALID_INPUT: ${message}` },
    retryable: false,
  };
}

function runOperationError(error: unknown): SidecarRunOperationError {
  const sidecar = toSidecarError(error);
  const code = (SIDECAR_RUN_ERROR_CODES as readonly string[]).includes(sidecar.code)
    ? sidecar.code as SidecarRunErrorCode
    : sidecar.code === "CONFIG_INVALID" || sidecar.code === "CONFIG_NOT_FOUND" || sidecar.code === "PRESET_NOT_FOUND" || sidecar.code === "SAFETY_REFUSAL"
      ? "RUN_INVALID_INPUT"
      : "RUN_INTERNAL_ERROR";
  return {
    kind: "run_error",
    error: { code, message: sidecar.message },
    retryable: code !== "RUN_INVALID_INPUT" && code !== "RUN_KEY_CONFLICT" && code !== "RUN_UNSUPPORTED_PLATFORM",
  };
}

function parseToolInput(rawInput: unknown): { value: CodexSidecarToolInput } | { error: SidecarResult } {
  if (!isRecord(rawInput)) {
    return { error: mcpErrorResult("explore", "", "CONFIG_INVALID", "CONFIG_INVALID: MCP tool input must be an object") };
  }

  const projectRoot = rawInput.projectRoot;
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return { error: mcpErrorResult("explore", "", "CONFIG_INVALID", "CONFIG_INVALID: projectRoot must be a non-empty string") };
  }

  const errors: string[] = [];
  const input: CodexSidecarToolInput = { projectRoot };
  copyOptionalString(rawInput, input, "configFile", errors);
  copyOptionalString(rawInput, input, "prompt", errors);
  copyOptionalString(rawInput, input, "preset", errors);
  copyOptionalString(rawInput, input, "outputContract", errors);
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
    if (isModelReasoningEffort(rawInput.modelReasoningEffort)) input.modelReasoningEffort = rawInput.modelReasoningEffort;
    else errors.push("modelReasoningEffort must be one of: low, medium, high, xhigh");
  }

  if ("context" in rawInput) {
    if (!Array.isArray(rawInput.context)) {
      errors.push("context must be an array");
    } else {
      try {
        input.context = buildEcosystemContextBlocks(rawInput.context as Parameters<typeof buildEcosystemContextBlocks>[0]);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (errors.length > 0) {
    return { error: mcpErrorResult("explore", projectRoot, "CONFIG_INVALID", `CONFIG_INVALID: ${errors.join("; ")}`) };
  }
  return { value: input };
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: CodexSidecarToolInput,
  key: "configFile" | "prompt" | "preset" | "outputContract" | "model",
  errors: string[],
): void {
  if (!(key in source)) return;
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
  if (!(key in source)) return;
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
    error: { code, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
