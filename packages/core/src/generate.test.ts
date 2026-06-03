import assert from "node:assert/strict";
import test from "node:test";
import { buildGenerateResult, buildGenerationPrompt, parseGenerationOutput } from "./generate.js";
import type { SidecarRequest } from "./types.js";

const baseRequest: SidecarRequest = {
  workflow: "generate",
  projectRoot: "/repo",
  prompt: "Generate 3 example sentences as JSON.",
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

test("buildGenerationPrompt instructs a single JSON value and includes the task", () => {
  const prompt = buildGenerationPrompt(baseRequest);

  assert.match(prompt, /exactly one JSON value/);
  assert.match(prompt, /Do not wrap the JSON in markdown code fences/);
  assert.match(prompt, /Generate 3 example sentences as JSON\./);
  assert.doesNotMatch(prompt, /output contract/);
});

test("buildGenerationPrompt injects the output contract when present", () => {
  const prompt = buildGenerationPrompt({
    ...baseRequest,
    outputContract: '{ "items": [{ "en": string, "ja": string }] }',
  });

  assert.match(prompt, /MUST conform exactly to this output contract/);
  assert.match(prompt, /"items": \[\{ "en": string, "ja": string \}\]/);
});

test("parseGenerationOutput accepts a JSON object", () => {
  const value = parseGenerationOutput('{"items":[{"en":"Hello.","ja":"こんにちは。"}]}');
  assert.deepEqual(value, { items: [{ en: "Hello.", ja: "こんにちは。" }] });
});

test("parseGenerationOutput accepts a JSON array", () => {
  const value = parseGenerationOutput('[{"en":"Hi."},{"en":"Bye."}]');
  assert.deepEqual(value, [{ en: "Hi." }, { en: "Bye." }]);
});

test("parseGenerationOutput rejects prose", () => {
  assert.throws(() => parseGenerationOutput("Here is your JSON: ..."), /generate output was not valid JSON/);
});

test("parseGenerationOutput rejects a bare JSON primitive", () => {
  assert.throws(() => parseGenerationOutput('"just a string"'), /must be a JSON object or array/);
  assert.throws(() => parseGenerationOutput("42"), /must be a JSON object or array/);
  assert.throws(() => parseGenerationOutput("null"), /must be a JSON object or array/);
});

test("buildGenerateResult preserves the raw payload and marks it generated", () => {
  const result = buildGenerateResult(
    baseRequest,
    '{"items":[{"en":"Hello.","ja":"こんにちは。"}]}',
    "/repo/.codex-sidecar/logs/app-server/x.jsonl",
  );

  assert.equal(result.status, "ok");
  assert.equal(result.workflow, "generate");
  assert.deepEqual(result.generated, { items: [{ en: "Hello.", ja: "こんにちは。" }] });
  assert.equal(result.confidence.level, "medium");
  assert.equal(result.sourceBoundaries?.[0]?.trust, "generated");
  assert.equal(result.rawEventLogRef, "/repo/.codex-sidecar/logs/app-server/x.jsonl");
});

test("buildGenerateResult surfaces array length in the summary", () => {
  const result = buildGenerateResult(baseRequest, "[1,2,3]");
  assert.match(result.summary, /array of 3 item/);
  assert.deepEqual(result.generated, [1, 2, 3]);
});

test("buildGenerateResult fails loudly on non-JSON", () => {
  assert.throws(() => buildGenerateResult(baseRequest, "not json"), /generate output was not valid JSON/);
});
