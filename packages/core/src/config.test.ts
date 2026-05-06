import assert from "node:assert/strict";
import test from "node:test";
import { assertSidecarConfig } from "./config.js";

test("assertSidecarConfig accepts a minimal valid config", () => {
  const config = assertSidecarConfig({
    project: "example",
    defaults: {
      readonly: true,
      result_format: "json",
      model: "gpt-5.4-mini",
      model_reasoning_effort: "medium",
    },
    presets: {
      review: {
        workflow: "review",
        readonly: true,
        model: "gpt-5.5",
        model_reasoning_effort: "high",
      },
    },
  });

  assert.equal(config.project, "example");
  assert.equal(config.presets?.review.workflow, "review");
  assert.equal(config.defaults?.model, "gpt-5.4-mini");
  assert.equal(config.presets?.review.model_reasoning_effort, "high");
});

test("assertSidecarConfig rejects invalid workflow names", () => {
  assert.throws(
    () =>
      assertSidecarConfig({
        project: "example",
        presets: {
          nope: {
            workflow: "not-real",
          },
        },
      }),
    /CONFIG_INVALID/,
  );
});

test("assertSidecarConfig rejects invalid model policy", () => {
  assert.throws(
    () =>
      assertSidecarConfig({
        project: "example",
        defaults: {
          model: "",
          model_reasoning_effort: "none",
        },
        presets: {
          review: {
            model: " ",
            model_reasoning_effort: "max",
          },
        },
      }),
    /CONFIG_INVALID: .*defaults\.model.*defaults\.model_reasoning_effort.*presets\.review\.model.*presets\.review\.model_reasoning_effort/,
  );
});
