import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSidecarRequest } from "./presets.js";
import type { SidecarConfig } from "./types.js";

const config: SidecarConfig = {
  project: "example",
  defaults: {
    model: "gpt-5.4-mini",
    model_reasoning_effort: "medium",
  },
  presets: {
    review: {
      workflow: "review",
      model: "gpt-5.5",
      model_reasoning_effort: "high",
    },
    inherited: {
      workflow: "explore",
    },
  },
};

test("normalizeSidecarRequest resolves model policy with CLI over preset over defaults", () => {
  assert.deepEqual(
    pickModelPolicy(
      normalizeSidecarRequest(config, {
        workflow: "review",
        projectRoot: "/repo",
        preset: "review",
        model: "gpt-5.5-codex",
        modelReasoningEffort: "xhigh",
      }),
    ),
    {
      model: "gpt-5.5-codex",
      modelReasoningEffort: "xhigh",
    },
  );

  assert.deepEqual(
    pickModelPolicy(
      normalizeSidecarRequest(config, {
        workflow: "review",
        projectRoot: "/repo",
        preset: "review",
      }),
    ),
    {
      model: "gpt-5.5",
      modelReasoningEffort: "high",
    },
  );

  assert.deepEqual(
    pickModelPolicy(
      normalizeSidecarRequest(config, {
        workflow: "explore",
        projectRoot: "/repo",
        preset: "inherited",
      }),
    ),
    {
      model: "gpt-5.4-mini",
      modelReasoningEffort: "medium",
    },
  );
});

test("normalizeSidecarRequest leaves model policy undefined when sidecar policy is absent", () => {
  const request = normalizeSidecarRequest({ project: "example" }, { workflow: "explore", projectRoot: "/repo" });

  assert.equal(request.model, undefined);
  assert.equal(request.modelReasoningEffort, undefined);
});

test("normalizeSidecarRequest rejects empty explicit model policy", () => {
  assert.throws(
    () =>
      normalizeSidecarRequest(
        { project: "example" },
        {
          workflow: "explore",
          projectRoot: "/repo",
          model: " ",
        },
      ),
    /CONFIG_INVALID: model must be a non-empty string/,
  );
});

function pickModelPolicy(request: ReturnType<typeof normalizeSidecarRequest>): {
  model?: string;
  modelReasoningEffort?: string;
} {
  return {
    model: request.model,
    modelReasoningEffort: request.modelReasoningEffort,
  };
}
