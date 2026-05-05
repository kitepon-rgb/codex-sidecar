import { runReadOnlyAppServerRequest, type AppServerRunOptions } from "./app-server-runner.js";
import { DEFAULT_APP_SERVER_LOG_DIR } from "./app-server-logs.js";
import { errorResult, toSidecarError } from "./results.js";
import type { SidecarRequest, SidecarResult, WorktreePlan, WorktreeState } from "./types.js";
import {
  assertWorktreeChangesAllowed,
  collectWorktreeState,
  createWorktree,
  planWorktree,
  removeWorktree,
  type WorktreeOptions,
} from "./worktree.js";
import { join } from "node:path";

export interface WorktreeRunnerDependencies {
  plan?: (request: SidecarRequest, options?: WorktreeOptions) => Promise<WorktreePlan>;
  create?: (plan: WorktreePlan) => Promise<WorktreePlan>;
  collect?: (plan: WorktreePlan) => Promise<WorktreeState>;
  assertAllowed?: (state: WorktreeState, request: SidecarRequest) => Promise<void>;
  remove?: (plan: WorktreePlan) => Promise<void>;
  runAppServer?: (request: SidecarRequest, options?: AppServerRunOptions) => Promise<SidecarResult>;
}

export interface WorktreeRunOptions extends WorktreeOptions {
  appServer?: AppServerRunOptions;
  dependencies?: WorktreeRunnerDependencies;
}

export async function runWorktreeAppServerRequest(
  request: SidecarRequest,
  options: WorktreeRunOptions = {},
): Promise<SidecarResult> {
  if (request.workflow !== "work" || !request.requireWorktree) {
    return errorResult(request, toSidecarError(new Error("SAFETY_REFUSAL: codex_work requires worktree isolation")));
  }

  const dependencies = {
    plan: planWorktree,
    create: createWorktree,
    collect: collectWorktreeState,
    assertAllowed: assertWorktreeChangesAllowed,
    remove: removeWorktree,
    runAppServer: runReadOnlyAppServerRequest,
    ...options.dependencies,
  };
  let plan: WorktreePlan | undefined;
  let created = false;
  let state: WorktreeState | undefined;

  try {
    plan = await dependencies.plan(request, options);
    await dependencies.create(plan);
    created = true;

    const worktreeRequest: SidecarRequest = {
      ...request,
      projectRoot: plan.worktreePath,
      readonly: false,
      requireWorktree: true,
    };
    const result = await dependencies.runAppServer(worktreeRequest, {
      eventLogDir: join(request.projectRoot, DEFAULT_APP_SERVER_LOG_DIR),
      ...(options.appServer ?? {}),
      allowWorkWorkflow: true,
    });

    state = await dependencies.collect(plan);
    await dependencies.assertAllowed(state, request);

    return {
      ...result,
      workflow: request.workflow,
      normalizedRequest: request,
      changedFiles: state.changedFiles,
      worktreePath: plan.worktreePath,
      worktreePreserved: request.preserveWorktree,
    };
  } catch (error) {
    const result = errorResult(request, toSidecarError(error));
    if (plan) {
      result.worktreePath = plan.worktreePath;
      result.worktreePreserved = request.preserveWorktree;
    }
    if (state) {
      result.changedFiles = state.changedFiles;
    }
    return result;
  } finally {
    if (created && plan && !request.preserveWorktree) {
      await dependencies.remove(plan);
    }
  }
}
