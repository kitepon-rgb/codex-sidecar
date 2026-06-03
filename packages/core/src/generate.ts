import { modelPolicyInfo } from "./results.js";
import type { SidecarRequest, SidecarResult } from "./types.js";

/**
 * The `generate` workflow drives the Codex App Server to produce arbitrary
 * structured JSON for a caller-supplied task, instead of the fixed
 * code-review-shaped SidecarResult payload the other workflows return.
 *
 * codex-sidecar guarantees only that the model returned one valid JSON object
 * or array. Domain validation (e.g. language, schema fields) is the caller's
 * responsibility and is intentionally NOT performed here — generation must not
 * silently "fix" or drop content.
 */

export function buildGenerationPrompt(request: SidecarRequest): string {
  const task = request.prompt?.trim() ?? "";
  const contract = request.outputContract?.trim();

  const lines = [
    "You are running as codex-sidecar in generate mode. Produce the requested content and return it as a single JSON value.",
    "",
    "Output rules (strict):",
    "- Return exactly one JSON value (a JSON object or a JSON array) and nothing else.",
    "- Do not include any prose, preamble, explanation, or trailing text.",
    "- Do not wrap the JSON in markdown code fences.",
    "- Emit valid JSON only: double-quoted keys and strings, no comments, no trailing commas.",
  ];

  if (contract) {
    lines.push("", "The JSON value MUST conform exactly to this output contract:", contract);
  }

  lines.push("", "Task:", task);

  return lines.join("\n");
}

export function parseGenerationOutput(assistantText: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(assistantText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PROTOCOL_ERROR: generate output was not valid JSON: ${detail}`);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error("PROTOCOL_ERROR: generate output must be a JSON object or array");
  }

  return parsed;
}

export function buildGenerateResult(
  request: SidecarRequest,
  assistantText: string,
  rawEventLogRef?: string,
): SidecarResult {
  const generated = parseGenerationOutput(assistantText);
  const shape = Array.isArray(generated)
    ? `a JSON array of ${generated.length} item(s)`
    : `a JSON object with ${Object.keys(generated as Record<string, unknown>).length} top-level key(s)`;

  return {
    status: "ok",
    workflow: "generate",
    summary: `Codex App Server returned ${shape}.`,
    confidence: {
      level: "medium",
      rationale:
        "Output is valid JSON returned by Codex App Server. codex-sidecar did not domain-validate the content; the caller must validate before persisting.",
    },
    recommendedNextAction: "Validate the generated payload against your domain rules before persisting.",
    generated,
    sourceBoundaries: [
      {
        label: "Codex App Server",
        source: "local codex app-server stdio",
        trust: "generated",
      },
    ],
    normalizedRequest: request,
    modelPolicy: modelPolicyInfo(request),
    rawEventLogRef,
  };
}
