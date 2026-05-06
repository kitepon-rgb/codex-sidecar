import assert from "node:assert/strict";
import test from "node:test";
import { runWorktreeAppServerRequest, type SidecarRequest, type SidecarResult, type WorktreePlan, type WorktreeState } from "./index.js";

const request: SidecarRequest = {
  workflow: "work",
  projectRoot: "/repo",
  prompt: "Change docs.",
  readonly: false,
  requireWorktree: true,
  focus: [],
  allowedPaths: ["docs/"],
  denyPaths: ["**/.env"],
  safetyProfile: "generic",
  resultFormat: "json",
  turnTimeoutMs: 600_000,
  interruptOnTimeout: true,
  preserveWorktree: true,
  context: [],
  dryRun: false,
};

const plan: WorktreePlan = {
  projectRoot: "/repo",
  worktreePath: "/tmp/repo-worktree",
  baseRef: "HEAD",
};

test("runWorktreeAppServerRequest runs Codex inside isolated worktree and reports changed files", async () => {
  let appServerProjectRoot = "";
  let appServerEventLogDir = "";
  let appServerModel = "";
  let appServerModelReasoningEffort = "";

  const result = await runWorktreeAppServerRequest({ ...request, model: "gpt-5.5", modelReasoningEffort: "high" }, {
    dependencies: {
      plan: async () => plan,
      create: async (createdPlan) => createdPlan,
      collect: async () => state(["docs/plan.md"]),
      runAppServer: async (worktreeRequest, options) => {
        appServerProjectRoot = worktreeRequest.projectRoot;
        appServerEventLogDir = options?.eventLogDir ?? "";
        appServerModel = worktreeRequest.model ?? "";
        appServerModelReasoningEffort = worktreeRequest.modelReasoningEffort ?? "";
        return okResult(worktreeRequest);
      },
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(appServerProjectRoot, "/tmp/repo-worktree");
  assert.equal(appServerEventLogDir, "/repo/.codex-sidecar/logs/app-server");
  assert.equal(appServerModel, "gpt-5.5");
  assert.equal(appServerModelReasoningEffort, "high");
  assert.deepEqual(result.changedFiles, ["docs/plan.md"]);
  assert.equal(result.worktreePath, "/tmp/repo-worktree");
  assert.equal(result.worktreePreserved, true);
});

test("runWorktreeAppServerRequest fails when changed files violate path policy", async () => {
  const result = await runWorktreeAppServerRequest(request, {
    dependencies: {
      plan: async () => plan,
      create: async (createdPlan) => createdPlan,
      collect: async () => state([".env"]),
      runAppServer: async (worktreeRequest) => okResult(worktreeRequest),
    },
  });

  assert.equal(result.status, "refused");
  assert.equal(result.error?.code, "SAFETY_REFUSAL");
  assert.deepEqual(result.changedFiles, [".env"]);
});

test("runWorktreeAppServerRequest removes worktree when preservation is disabled", async () => {
  let removed = false;

  const result = await runWorktreeAppServerRequest(
    { ...request, preserveWorktree: false },
    {
      dependencies: {
        plan: async () => plan,
        create: async (createdPlan) => createdPlan,
        collect: async () => state(["docs/plan.md"]),
        remove: async () => {
          removed = true;
        },
        runAppServer: async (worktreeRequest) => okResult(worktreeRequest),
      },
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.worktreePreserved, false);
  assert.equal(removed, true);
});

function state(changedFiles: string[]): WorktreeState {
  return {
    ...plan,
    changedFiles,
  };
}

function okResult(worktreeRequest: SidecarRequest): SidecarResult {
  return {
    status: "ok",
    workflow: "work",
    summary: "Changed docs.",
    confidence: { level: "medium" },
    recommendedNextAction: "Review the worktree diff.",
    changedFiles: [],
    tests: [],
    risks: [],
    normalizedRequest: worktreeRequest,
  };
}
