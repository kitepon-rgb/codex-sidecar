import { getProfileDenyPatterns } from "./profiles.js";
import { normalizePolicyPatterns } from "./paths.js";
import type { ResultFormat, SafetyProfileName, SidecarConfig, SidecarRequest, SidecarWorkflow } from "./types.js";

export interface RequestInput {
  workflow: SidecarWorkflow;
  projectRoot: string;
  prompt?: string;
  preset?: string;
  readonly?: boolean;
  requireWorktree?: boolean;
  focus?: string[];
  allowedPaths?: string[];
  denyPaths?: string[];
  safetyProfile?: SafetyProfileName;
  resultFormat?: ResultFormat;
  dryRun?: boolean;
}

export function normalizeSidecarRequest(config: SidecarConfig, input: RequestInput): SidecarRequest {
  const preset = input.preset ? config.presets?.[input.preset] : undefined;

  if (input.preset && !preset) {
    throw new Error(`PRESET_NOT_FOUND: preset "${input.preset}" does not exist`);
  }

  const workflow = preset?.workflow ?? input.workflow;
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
    readonly: input.readonly ?? preset?.readonly ?? config.defaults?.readonly ?? workflow !== "work",
    requireWorktree: input.requireWorktree ?? preset?.require_worktree ?? workflow === "work",
    focus: input.focus ?? preset?.focus ?? [],
    allowedPaths: normalizePolicyPatterns(configuredAllowedPaths),
    denyPaths: normalizePolicyPatterns(configuredDenyPaths),
    safetyProfile,
    resultFormat: input.resultFormat ?? config.defaults?.result_format ?? "json",
    context: [],
    dryRun: input.dryRun ?? false,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
