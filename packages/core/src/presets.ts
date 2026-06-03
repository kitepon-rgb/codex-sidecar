import { getProfileDenyPatterns } from "./profiles.js";
import { normalizePolicyPatterns } from "./paths.js";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  type ModelReasoningEffort,
  type ResultFormat,
  type SafetyProfileName,
  type SidecarConfig,
  type SidecarContextBlock,
  type SidecarRequest,
  type SidecarWorkflow,
} from "./types.js";

export interface RequestInput {
  workflow: SidecarWorkflow;
  projectRoot: string;
  prompt?: string;
  preset?: string;
  outputContract?: string;
  readonly?: boolean;
  requireWorktree?: boolean;
  focus?: string[];
  allowedPaths?: string[];
  denyPaths?: string[];
  safetyProfile?: SafetyProfileName;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  resultFormat?: ResultFormat;
  turnTimeoutMs?: number;
  interruptOnTimeout?: boolean;
  preserveWorktree?: boolean;
  context?: SidecarContextBlock[];
  dryRun?: boolean;
}

export function normalizeSidecarRequest(config: SidecarConfig, input: RequestInput): SidecarRequest {
  const preset = input.preset ? config.presets?.[input.preset] : undefined;

  if (input.preset && !preset) {
    throw new Error(`PRESET_NOT_FOUND: preset "${input.preset}" does not exist`);
  }

  const workflow = preset?.workflow ?? input.workflow;
  const model = normalizeOptionalModel(input.model ?? preset?.model ?? config.defaults?.model);
  const modelReasoningEffort = input.modelReasoningEffort ?? preset?.model_reasoning_effort ?? config.defaults?.model_reasoning_effort;
  const safetyProfile =
    input.safetyProfile ??
    preset?.safety_profile ??
    config.safety_profile ??
    config.defaults?.safety_profile ??
    "generic";
  const configuredDenyPaths = unique([
    ...getProfileDenyPatterns(safetyProfile),
    ...(config.deny_paths ?? []),
    ...(preset?.deny_paths ?? []),
    ...(input.denyPaths ?? []),
  ]);
  const configuredAllowedPaths = unique([
    ...(config.allowed_paths ?? []),
    ...(preset?.allowed_paths ?? []),
    ...(input.allowedPaths ?? []),
  ]);

  return {
    workflow,
    projectRoot: input.projectRoot,
    prompt: input.prompt ?? preset?.prompt,
    preset: input.preset,
    outputContract: input.outputContract,
    readonly: input.readonly ?? preset?.readonly ?? config.defaults?.readonly ?? workflow !== "work",
    requireWorktree: input.requireWorktree ?? preset?.require_worktree ?? workflow === "work",
    focus: input.focus ?? preset?.focus ?? [],
    allowedPaths: normalizePolicyPatterns(configuredAllowedPaths),
    denyPaths: normalizePolicyPatterns(configuredDenyPaths),
    safetyProfile,
    model,
    modelReasoningEffort,
    resultFormat: input.resultFormat ?? config.defaults?.result_format ?? "json",
    turnTimeoutMs: normalizePositiveInteger(input.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, "turnTimeoutMs"),
    interruptOnTimeout: input.interruptOnTimeout ?? true,
    preserveWorktree: input.preserveWorktree ?? true,
    context: input.context ?? [],
    dryRun: input.dryRun ?? false,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`CONFIG_INVALID: ${label} must be a positive integer`);
  }

  return value;
}

function normalizeOptionalModel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value.trim().length === 0) {
    throw new Error("CONFIG_INVALID: model must be a non-empty string");
  }

  return value;
}
