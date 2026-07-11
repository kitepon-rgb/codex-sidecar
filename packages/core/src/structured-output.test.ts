import assert from "node:assert/strict";
import test from "node:test";
import { buildDegradedResult, parseStructuredSidecarOutput, type SidecarRequest } from "./index.js";

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
  preserveWorktree: true,
  context: [],
  dryRun: false,
};

test("parseStructuredSidecarOutput preserves explore answer and file references", () => {
  const result = parseStructuredSidecarOutput(
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

  assert.equal(result.status, "ok");
  assert.deepEqual(result.normalizationNotes, []);
  assert.equal(result.output.summary, "The repo is a CLI.");
  assert.equal(result.output.fileReferences?.[0]?.path, "packages/cli/src/index.ts");
});

test("parseStructuredSidecarOutput requires risk-check risks", () => {
  const result = parseStructuredSidecarOutput(
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

  assert.equal(result.status, "ok");
  assert.equal(result.output.risks?.[0]?.severity, "critical");
  assert.equal(result.output.risks?.[0]?.affectedFiles[0]?.path, "src/auth.ts");
});

test("parseStructuredSidecarOutput requires opinion fields", () => {
  const result = parseStructuredSidecarOutput(
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

  assert.equal(result.status, "ok");
  assert.equal(result.output.recommendation, "Start with the generic core contract.");
  assert.equal(result.output.failureModes?.[0], "The schema may drift without snapshots.");
});

test("parseStructuredSidecarOutput requires auditor pass and missingTools", () => {
  const result = parseStructuredSidecarOutput(
    { ...baseRequest, workflow: "auditor" },
    JSON.stringify({
      summary: "Caveat should be checked.",
      confidence: { level: "high" },
      recommendedNextAction: "Call the missing tool before answering.",
      openQuestions: [],
      fileReferences: [],
      sourceBoundaries: [],
      pass: false,
      missingTools: [
        {
          name: "mcp__caveat__caveat_search",
          reason: "The user asks for past known traps.",
        },
      ],
    }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.output.pass, false);
  assert.equal(result.output.missingTools?.[0]?.name, "mcp__caveat__caveat_search");
});

// --- Layer 1: lossless coercion of the model's looser dialect --------------

test("coerces a bare confidence level string to an object and discloses it", () => {
  const result = parseStructuredSidecarOutput(
    baseRequest,
    JSON.stringify({
      summary: "Bare confidence string.",
      confidence: "high",
      recommendedNextAction: "Proceed.",
      openQuestions: [],
      fileReferences: [],
      sourceBoundaries: [],
    }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.output.confidence.level, "high");
  assert.ok(result.normalizationNotes.some((note) => note.includes("confidence")));
});

test("coerces string affectedFiles and confidence inside a risk without inventing basis", () => {
  const result = parseStructuredSidecarOutput(
    { ...baseRequest, workflow: "risk-check" },
    JSON.stringify({
      summary: "One risk in loose dialect.",
      confidence: { level: "medium" },
      recommendedNextAction: "Verify.",
      openQuestions: [],
      fileReferences: [],
      sourceBoundaries: [],
      risks: [
        {
          severity: "high",
          title: "Loose dialect risk",
          detail: "Model emitted the compact forms.",
          affectedFiles: ["src/a.ts", "src/b.ts"],
          confidence: "high",
          basis: "observed",
        },
      ],
    }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.output.risks?.[0]?.affectedFiles[0]?.path, "src/a.ts");
  assert.equal(result.output.risks?.[0]?.affectedFiles[1]?.path, "src/b.ts");
  assert.equal(result.output.risks?.[0]?.confidence.level, "high");
  assert.equal(result.output.risks?.[0]?.basis, "observed");
  // Two path coercions + one confidence coercion disclosed.
  assert.equal(result.normalizationNotes.length, 3);
});

// --- Layer 2: honest degraded salvage for un-coercible drift ---------------

test("degrades to partial when severity and basis drift but the core is intact", () => {
  // Mirrors the real gpt-5.6-terra × medium failure: bare-string confidence and
  // string affectedFiles (coercible), plus a synonym severity and a free-text
  // basis (NOT coercible — those would require inventing a classification).
  const result = parseStructuredSidecarOutput(
    { ...baseRequest, workflow: "work" },
    JSON.stringify({
      summary: "Implemented the change; some verification blocked.",
      confidence: { level: "medium", rationale: "Isolated verification passed." },
      recommendedNextAction: "Review the worktree diff and re-run the gate.",
      openQuestions: [],
      fileReferences: [],
      sourceBoundaries: [],
      tests: [{ command: "node --test", status: "failed", summary: "EPERM" }],
      risks: [
        {
          severity: "blocker",
          title: "Real-home verification blocked",
          detail: "Sandbox denied writes.",
          affectedFiles: ["spike/session-end-logger.mjs"],
          confidence: "high",
          basis: "Observed EPERM on all three real-path invocations.",
        },
      ],
    }),
  );

  assert.equal(result.status, "partial");
  // Core survived.
  assert.equal(result.output.summary, "Implemented the change; some verification blocked.");
  // Lossless coercions were still applied and disclosed.
  assert.ok(result.normalizationNotes.some((note) => note.includes("affectedFiles")));
  assert.ok(result.normalizationNotes.some((note) => note.includes("confidence")));
  // The un-coercible drift is surfaced, not guessed.
  assert.ok(result.validationErrors.some((error) => error.includes("severity")));
  assert.ok(result.validationErrors.some((error) => error.includes("basis")));
  // Raw report is preserved verbatim for the caller.
  assert.equal((result.raw as { risks?: unknown[] }).risks?.length, 1);
});

test("buildDegradedResult exposes the raw report, violations, and notes; hides typed workflow fields", () => {
  const parseResult = parseStructuredSidecarOutput(
    { ...baseRequest, workflow: "work" },
    JSON.stringify({
      summary: "Work done, report drifted.",
      confidence: "high",
      recommendedNextAction: "Adopt from the worktree.",
      openQuestions: [],
      fileReferences: [],
      sourceBoundaries: [],
      tests: [{ command: "corepack pnpm test", status: "passed" }],
      risks: [
        {
          severity: "blocker",
          title: "t",
          detail: "d",
          affectedFiles: ["a.ts"],
          confidence: "high",
          basis: "Observed directly.",
        },
      ],
    }),
  );

  assert.equal(parseResult.status, "partial");

  const degraded = buildDegradedResult({ ...baseRequest, workflow: "work" }, parseResult, {
    normalizedRequest: baseRequest,
    modelPolicy: { source: "inherited" },
    rawEventLogRef: "/tmp/log.jsonl",
  });

  assert.equal(degraded.status, "partial");
  assert.equal(degraded.error?.code, "PROTOCOL_ERROR");
  assert.match(degraded.error?.message ?? "", /partially invalid/);
  assert.ok(Array.isArray((degraded.error?.data?.validationErrors as string[])));
  assert.ok((degraded.error?.data?.validationErrors as string[]).length > 0);
  // Raw report preserved, typed workflow fields intentionally omitted.
  assert.equal((degraded.unvalidatedReport as { summary?: string }).summary, "Work done, report drifted.");
  assert.equal(degraded.risks, undefined);
  assert.equal(degraded.tests, undefined);
  assert.equal(degraded.pass, undefined);
  // Confidence coercion still disclosed.
  assert.ok((degraded.normalizationNotes ?? []).some((note) => note.includes("confidence")));
});

// --- Hard core: still a throw, no prose or partial fallback ----------------

test("hard-fails on non-JSON output (no prose fallback)", () => {
  assert.throws(
    () => parseStructuredSidecarOutput(baseRequest, "plain prose is not JSON"),
    /PROTOCOL_ERROR: assistant output was not valid JSON/,
  );
});

test("hard-fails when the core summary is missing", () => {
  assert.throws(
    () =>
      parseStructuredSidecarOutput(
        baseRequest,
        JSON.stringify({
          confidence: { level: "medium" },
          recommendedNextAction: "Proceed.",
          openQuestions: [],
          fileReferences: [],
          sourceBoundaries: [],
        }),
      ),
    /PROTOCOL_ERROR: assistant structured output invalid: summary must be a non-empty string/,
  );
});

test("hard-fails when recommendedNextAction is missing", () => {
  assert.throws(
    () =>
      parseStructuredSidecarOutput(
        baseRequest,
        JSON.stringify({
          summary: "Has summary but no next action.",
          confidence: { level: "medium" },
          openQuestions: [],
          fileReferences: [],
          sourceBoundaries: [],
        }),
      ),
    /recommendedNextAction must be a non-empty string/,
  );
});

// --- Degraded, not thrown: invalid workflow-specific fields ----------------

test("degrades (not throws) on invalid auditor fields while surfacing the violations", () => {
  const result = parseStructuredSidecarOutput(
    { ...baseRequest, workflow: "auditor" },
    JSON.stringify({
      summary: "Bad auditor output.",
      confidence: { level: "medium" },
      recommendedNextAction: "Retry.",
      openQuestions: [],
      fileReferences: [],
      sourceBoundaries: [],
      pass: "no",
      missingTools: [{ name: "mcp__caveat__caveat_search" }],
    }),
  );

  assert.equal(result.status, "partial");
  assert.ok(result.validationErrors.some((error) => error.includes("pass must be a boolean")));
  assert.ok(result.validationErrors.some((error) => error.includes("missingTools[0].reason")));
});

test("degrades (not throws) when a required workflow field is missing", () => {
  const result = parseStructuredSidecarOutput(
    { ...baseRequest, workflow: "review" },
    JSON.stringify({
      summary: "Looks fine.",
      confidence: { level: "medium" },
      recommendedNextAction: "No action.",
      openQuestions: [],
      fileReferences: [],
      sourceBoundaries: [],
    }),
  );

  assert.equal(result.status, "partial");
  assert.ok(result.validationErrors.some((error) => error.includes("findings must be an array")));
});
