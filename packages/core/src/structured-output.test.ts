import assert from "node:assert/strict";
import test from "node:test";
import { parseStructuredSidecarOutput, type SidecarRequest } from "./index.js";

const baseRequest: SidecarRequest = {
  workflow: "explore",
  projectRoot: "/repo",
  prompt: "Explain the repo.",
  readonly: true,
  requireWorktree: false,
  focus: [],
  allowedPaths: [],
  denyPaths: [],
  safetyProfile: "generic",
  resultFormat: "json",
  turnTimeoutMs: 600_000,
  interruptOnTimeout: true,
  context: [],
  dryRun: false,
};

test("parseStructuredSidecarOutput preserves explore answer and file references", () => {
  const output = parseStructuredSidecarOutput(
    baseRequest,
    JSON.stringify({
      summary: "The repo is a CLI.",
      confidence: { level: "medium" },
      recommendedNextAction: "Inspect the CLI entrypoint.",
      openQuestions: [],
      fileReferences: [{ path: "packages/cli/src/index.ts", line: 1 }],
      sourceBoundaries: [{ label: "local", source: "repo", trust: "local" }],
    }),
  );

  assert.equal(output.summary, "The repo is a CLI.");
  assert.equal(output.fileReferences?.[0]?.path, "packages/cli/src/index.ts");
});

test("parseStructuredSidecarOutput requires risk-check risks", () => {
  const output = parseStructuredSidecarOutput(
    { ...baseRequest, workflow: "risk-check" },
    JSON.stringify({
      summary: "One risk.",
      confidence: { level: "high" },
      recommendedNextAction: "Verify the secret handling path.",
      openQuestions: [],
      fileReferences: [],
      sourceBoundaries: [],
      risks: [
        {
          severity: "critical",
          title: "Secret exposure",
          detail: "A token may be logged.",
          affectedFiles: [{ path: "src/auth.ts", line: 42 }],
          suggestedVerification: "Run a log redaction test.",
          confidence: { level: "high" },
          basis: "observed",
        },
      ],
    }),
  );

  assert.equal(output.risks?.[0]?.severity, "critical");
  assert.equal(output.risks?.[0]?.affectedFiles[0]?.path, "src/auth.ts");
});

test("parseStructuredSidecarOutput requires opinion fields", () => {
  const output = parseStructuredSidecarOutput(
    { ...baseRequest, workflow: "opinion" },
    JSON.stringify({
      summary: "Prefer the smaller plan.",
      confidence: { level: "low", rationale: "Limited context." },
      recommendedNextAction: "Choose the narrower implementation first.",
      openQuestions: ["What is the rollout target?"],
      fileReferences: [],
      sourceBoundaries: [],
      recommendation: "Start with the generic core contract.",
      objections: ["The overlay can wait until the contract is stable."],
      assumptions: ["Callers can pass plain JSON context."],
      failureModes: ["The schema may drift without snapshots."],
    }),
  );

  assert.equal(output.recommendation, "Start with the generic core contract.");
  assert.equal(output.failureModes?.[0], "The schema may drift without snapshots.");
});

test("parseStructuredSidecarOutput rejects missing workflow-specific fields", () => {
  assert.throws(
    () =>
      parseStructuredSidecarOutput(
        { ...baseRequest, workflow: "review" },
        JSON.stringify({
          summary: "Looks fine.",
          confidence: { level: "medium" },
          recommendedNextAction: "No action.",
          openQuestions: [],
          fileReferences: [],
          sourceBoundaries: [],
        }),
      ),
    /PROTOCOL_ERROR: assistant structured output invalid: findings must be an array/,
  );
});
