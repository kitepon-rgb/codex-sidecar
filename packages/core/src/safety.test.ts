import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePathAccess } from "./paths.js";
import { buildSidecarRequest } from "./requests.js";
import type { SidecarConfig } from "./types.js";

test("codex_work requires allowed paths", () => {
  const config: SidecarConfig = {
    project: "example",
    presets: {
      work: {
        workflow: "work",
        readonly: false,
        require_worktree: true,
      },
    },
  };

  assert.throws(
    () =>
      buildSidecarRequest(config, {
        workflow: "work",
        projectRoot: "/tmp/example",
        preset: "work",
      }),
    /SAFETY_REFUSAL/,
  );
});

test("path access denies secrets before allow rules", () => {
  const access = evaluatePathAccess("server/.env", {
    allowedPaths: ["server/"],
    denyPaths: ["**/.env"],
  });

  assert.equal(access.allowed, false);
  assert.equal(access.denied, true);
});

test("path access rejects traversal", () => {
  assert.throws(
    () =>
      evaluatePathAccess("../outside.txt", {
        allowedPaths: ["."],
        denyPaths: [],
      }),
    /path traversal/,
  );
});
