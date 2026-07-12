import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  cleanupWorktreeExecution,
  executeWorktreeAppServerRequest,
  runWorktreeAppServerRequest,
  type SidecarRequest,
  type SidecarResult,
  type WorktreePlan,
  type WorktreeState,
} from "./index.js";

const execFileAsync = promisify(execFile);

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
  const calls: string[] = [];

  const result = await runWorktreeAppServerRequest(
    { ...request, preserveWorktree: false },
    {
      dependencies: {
        plan: async () => plan,
        create: async (createdPlan) => createdPlan,
        collect: async () => {
          calls.push("collect");
          return state(["docs/plan.md"]);
        },
        remove: async () => {
          calls.push("remove");
        },
        runAppServer: async (worktreeRequest) => okResult(worktreeRequest),
      },
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.worktreePreserved, false);
  assert.deepEqual(calls, ["collect", "remove"]);
});

test("executeWorktreeAppServerRequest retains a non-preserved worktree for explicit cleanup", async () => {
  let removed = false;
  const options = {
    dependencies: {
      plan: async () => plan,
      create: async (createdPlan: WorktreePlan) => createdPlan,
      collect: async () => state(["docs/plan.md"]),
      remove: async () => {
        removed = true;
      },
      runAppServer: async (worktreeRequest: SidecarRequest) => okResult(worktreeRequest),
    },
  };

  const execution = await executeWorktreeAppServerRequest({ ...request, preserveWorktree: false }, options);

  assert.equal(execution.created, true);
  assert.equal(execution.plan, plan);
  assert.equal(execution.result.status, "ok");
  assert.equal(removed, false);

  assert.deepEqual(await cleanupWorktreeExecution(execution, options), {
    cleanup: "completed",
    alreadyCompleted: false,
  });
  assert.equal(removed, true);
});

test("executeWorktreeAppServerRequest checks durable cancellation before any worktree side effect", async () => {
  const cancellation = new AbortController();
  cancellation.abort(new Error("cancelled"));
  const calls: string[] = [];

  const execution = await executeWorktreeAppServerRequest(request, {
    abortSignal: cancellation.signal,
    dependencies: {
      plan: async () => { calls.push("plan"); return plan; },
      create: async (createdPlan) => { calls.push("create"); return createdPlan; },
      runAppServer: async (worktreeRequest) => { calls.push("run"); return okResult(worktreeRequest); },
    },
  });

  assert.equal(execution.created, false);
  assert.equal(execution.result.status, "failed");
  assert.equal(execution.result.error?.code, "APP_SERVER_CANCELLED");
  assert.deepEqual(calls, []);
});

test("cleanupWorktreeExecution is a no-op for preserved and uncreated worktrees", async () => {
  let removeCalls = 0;
  const options = { dependencies: { remove: async () => { removeCalls += 1; } } };

  const preserved = await executeWorktreeAppServerRequest(
    request,
    {
      dependencies: {
        plan: async () => plan,
        create: async (createdPlan) => createdPlan,
        collect: async () => state([]),
        runAppServer: async (worktreeRequest) => okResult(worktreeRequest),
        ...options.dependencies,
      },
    },
  );
  const uncreated = await executeWorktreeAppServerRequest(request, {
    dependencies: { plan: async () => plan, create: async () => { throw new Error("create failed"); }, ...options.dependencies },
  });

  assert.deepEqual(await cleanupWorktreeExecution(preserved, options), { cleanup: "not-requested" });
  assert.deepEqual(await cleanupWorktreeExecution(uncreated, options), { cleanup: "not-requested" });
  assert.equal(removeCalls, 0);
});

test("cleanupWorktreeExecution is idempotent after a crash before its durable record", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codex-sidecar-worktree-runner-test-"));
  const worktreePath = join(repo, "worktree with spaces");

  try {
    await git(repo, ["init"]);
    await writeFile(join(repo, "README.md"), "root\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    await git(repo, ["worktree", "add", "--detach", worktreePath, "HEAD"]);

    const execution = {
      request: { ...request, projectRoot: repo, preserveWorktree: false },
      plan: { projectRoot: repo, worktreePath, baseRef: "HEAD" },
      created: true,
      result: okResult(request),
    };

    assert.deepEqual(await cleanupWorktreeExecution(execution), { cleanup: "completed", alreadyCompleted: false });
    assert.equal(existsSync(worktreePath), false);
    assert.deepEqual(await cleanupWorktreeExecution(execution), { cleanup: "completed", alreadyCompleted: true });
    assert.equal(existsSync(worktreePath), false);
    const listed = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(listed.stdout.includes(`worktree ${worktreePath}`), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runWorktreeAppServerRequest cleans up after App Server and allowed-path failures", async () => {
  const appServerCalls: string[] = [];
  const appServerResult = await runWorktreeAppServerRequest(
    { ...request, preserveWorktree: false },
    {
      dependencies: {
        plan: async () => plan,
        create: async (createdPlan) => createdPlan,
        runAppServer: async () => {
          appServerCalls.push("run");
          throw new Error("App Server failed");
        },
        remove: async () => { appServerCalls.push("remove"); },
      },
    },
  );
  assert.equal(appServerResult.status, "failed");
  assert.deepEqual(appServerCalls, ["run", "remove"]);

  const policyCalls: string[] = [];
  const policyResult = await runWorktreeAppServerRequest(
    { ...request, preserveWorktree: false },
    {
      dependencies: {
        plan: async () => plan,
        create: async (createdPlan) => createdPlan,
        collect: async () => {
          policyCalls.push("collect");
          return state([".env"]);
        },
        remove: async () => { policyCalls.push("remove"); },
        runAppServer: async (worktreeRequest) => okResult(worktreeRequest),
      },
    },
  );
  assert.equal(policyResult.status, "refused");
  assert.deepEqual(policyCalls, ["collect", "remove"]);
});

test("runWorktreeAppServerRequest preserves removal failure as a rejection", async () => {
  await assert.rejects(
    runWorktreeAppServerRequest(
      { ...request, preserveWorktree: false },
      {
        dependencies: {
          plan: async () => plan,
          create: async (createdPlan) => createdPlan,
          collect: async () => state([]),
          remove: async () => { throw new Error("remove failed"); },
          runAppServer: async (worktreeRequest) => okResult(worktreeRequest),
        },
      },
    ),
    /remove failed/,
  );
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

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}
