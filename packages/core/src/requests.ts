import { runReadOnlyAppServerRequest } from "./app-server-runner.js";
import { normalizeSidecarRequest, type RequestInput } from "./presets.js";
import { dryRunResult, errorResult, toSidecarError } from "./results.js";
import { captureSidecarRuntimeError } from "./factory-error-store.js";
import { validateRequestSafety } from "./safety.js";
import { DEFAULT_TURN_TIMEOUT_MS, type SidecarConfig, type SidecarRequest, type SidecarResult } from "./types.js";
import { runWorktreeAppServerRequest } from "./worktree-runner.js";

export type { RequestInput } from "./presets.js";
export type { SidecarRequest, SidecarWorkflow } from "./types.js";

export function buildSidecarRequest(config: SidecarConfig, input: RequestInput): SidecarRequest {
  const request = normalizeSidecarRequest(config, input);
  validateRequestSafety(request);
  return request;
}

export async function runSidecarRequest(
  config: SidecarConfig,
  input: RequestInput,
): Promise<SidecarResult> {
  let request: SidecarRequest;

  try {
    request = buildSidecarRequest(config, input);
  } catch (error) {
    const errorRequest: SidecarRequest = {
      workflow: input.workflow,
      projectRoot: input.projectRoot,
      prompt: input.prompt,
      preset: input.preset,
      outputContract: input.outputContract,
      readonly: input.readonly ?? input.workflow !== "work",
      requireWorktree: input.requireWorktree ?? input.workflow === "work",
      focus: input.focus ?? [],
      allowedPaths: input.allowedPaths ?? [],
      denyPaths: input.denyPaths ?? [],
      safetyProfile: input.safetyProfile ?? "generic",
      model: input.model,
      modelReasoningEffort: input.modelReasoningEffort,
      resultFormat: input.resultFormat ?? "json",
      turnTimeoutMs: input.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      interruptOnTimeout: input.interruptOnTimeout ?? true,
      preserveWorktree: input.preserveWorktree ?? true,
      context: input.context ?? [],
      dryRun: input.dryRun ?? false,
    };
    const sidecarError = toSidecarError(error);
    await captureSidecarRuntimeError(sidecarError.code);
    return errorResult(errorRequest, sidecarError);
  }

  if (request.dryRun) {
    return dryRunResult(request);
  }

  if (request.workflow === "work") {
    const result = await runWorktreeAppServerRequest(request);
    if (result.error) await captureSidecarRuntimeError(result.error.code);
    return result;
  }

  const result = await runReadOnlyAppServerRequest(request);
  if (result.error) await captureSidecarRuntimeError(result.error.code);
  return result;
}
