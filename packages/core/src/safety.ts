import type { SidecarRequest } from "./types.js";

export interface SafetyValidation {
  ok: true;
}

export function validateRequestSafety(request: SidecarRequest): SafetyValidation {
  const errors: string[] = [];

  if (request.workflow !== "work" && request.readonly === false) {
    errors.push(`${request.workflow} must be read-only`);
  }

  if (request.workflow === "generate" && !request.prompt?.trim()) {
    errors.push("generate requires a non-empty prompt");
  }

  if (request.workflow === "work") {
    if (request.readonly) {
      errors.push("codex_work must be explicitly write-capable");
    }

    if (!request.requireWorktree) {
      errors.push("codex_work requires isolated git worktree execution");
    }

    if (request.allowedPaths.length === 0) {
      errors.push("codex_work requires at least one allowed_paths entry");
    }
  }

  if (errors.length > 0) {
    throw new Error(`SAFETY_REFUSAL: ${errors.join("; ")}`);
  }

  return { ok: true };
}
