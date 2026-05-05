import assert from "node:assert/strict";
import test from "node:test";
import { assertSidecarConfig } from "./config.js";

test("assertSidecarConfig accepts a minimal valid config", () => {
  const config = assertSidecarConfig({
    project: "example",
    defaults: {
      readonly: true,
      result_format: "json",
    },
    presets: {
      review: {
        workflow: "review",
        readonly: true,
      },
    },
  });

  assert.equal(config.project, "example");
  assert.equal(config.presets?.review.workflow, "review");
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
