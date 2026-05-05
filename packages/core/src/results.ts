import type { Confidence, SidecarError, SidecarRequest, SidecarResult } from "./types.js";

export const UNKNOWN_CONFIDENCE: Confidence = {
  level: "unknown",
  rationale: "Codex App Server has not been called yet.",
};

export function dryRunResult(request: SidecarRequest): SidecarResult {
  return {
    status: "dry-run",
    workflow: request.workflow,
    summary: "Request normalized and safety-checked. Codex App Server was not called.",
    confidence: UNKNOWN_CONFIDENCE,
    recommendedNextAction: "Review the normalizedRequest, then run without --dry-run when App Server integration is available.",
    normalizedRequest: request,
  };
}

export function unimplementedResult(request: SidecarRequest): SidecarResult {
  return {
    status: "failed",
    workflow: request.workflow,
    summary: "Codex App Server integration is not implemented yet.",
    confidence: UNKNOWN_CONFIDENCE,
    recommendedNextAction: "Implement the App Server adapter behind the stable SidecarRequest/SidecarResult contract.",
    normalizedRequest: request,
    error: {
      code: "APP_SERVER_UNIMPLEMENTED",
      message: "Codex App Server integration is not implemented yet.",
    },
  };
}

export function errorResult(request: SidecarRequest, error: SidecarError): SidecarResult {
  return {
    status: error.code === "SAFETY_REFUSAL" ? "refused" : "failed",
    workflow: request.workflow,
    summary: error.message,
    confidence: UNKNOWN_CONFIDENCE,
    recommendedNextAction: "Fix the reported error and retry. No fallback path was used.",
    normalizedRequest: request,
    error,
  };
}

export function toSidecarError(error: unknown): SidecarError {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.startsWith("CONFIG_INVALID:")
    ? "CONFIG_INVALID"
    : message.startsWith("CONFIG_NOT_FOUND:")
      ? "CONFIG_NOT_FOUND"
      : message.startsWith("PRESET_NOT_FOUND:")
        ? "PRESET_NOT_FOUND"
        : message.startsWith("SAFETY_REFUSAL:")
          ? "SAFETY_REFUSAL"
          : "PROTOCOL_ERROR";

  return {
    code,
    message,
  };
}
