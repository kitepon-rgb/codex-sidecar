import assert from "node:assert/strict";
import test from "node:test";
import { parsePorcelainStatus } from "./worktree.js";

test("parsePorcelainStatus extracts changed file paths", () => {
  assert.deepEqual(parsePorcelainStatus(" M src/index.ts\n?? docs/plan.md\n"), [
    "src/index.ts",
    "docs/plan.md",
  ]);
});

test("parsePorcelainStatus returns destination path for renames", () => {
  assert.deepEqual(parsePorcelainStatus("R  old.ts -> src/new.ts\n"), ["src/new.ts"]);
});
