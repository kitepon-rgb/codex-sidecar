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
  type WorktreeRemovalResult,
  type WorktreeOptions,
} from "./worktree.js";
import { join } from "node:path";

export interface WorktreeRunnerDependencies {
  plan?: (request: SidecarRequest, options?: WorktreeOptions) => Promise<WorktreePlan>;
  create?: (plan: WorktreePlan) => Promise<WorktreePlan>;
  collect?: (plan: WorktreePlan) => Promise<WorktreeState>;
  assertAllowed?: (state: WorktreeState, request: SidecarRequest) => Promise<void>;
  remove?: (plan: WorktreePlan) => Promise<WorktreeRemovalResult | void>;
  runAppServer?: (request: SidecarRequest, options?: AppServerRunOptions) => Promise<SidecarResult>;
}

export interface WorktreeRunOptions extends WorktreeOptions {
  appServer?: AppServerRunOptions;
  /**
   * Cooperative durable-worker cancellation.  This is checked again before
   * each worktree side effect; a cancellation that wins after execution has
   * started may still observe earlier effects, but it never starts a later one.
   */
  abortSignal?: AbortSignal;
  dependencies?: WorktreeRunnerDependencies;
}

/**
 * 非同期 worker が結果を永続化してから worktree を削除できるよう保持する実行状態。
 */
export interface WorktreeExecution {
  request: SidecarRequest;
  plan?: WorktreePlan;
  created: boolean;
  result: SidecarResult;
}

export interface WorktreeCleanupResult {
  cleanup: "not-requested" | "completed";
  alreadyCompleted?: boolean;
}

export async function executeWorktreeAppServerRequest(
  request: SidecarRequest,
  options: WorktreeRunOptions = {},
): Promise<WorktreeExecution> {
  if (request.workflow !== "work" || !request.requireWorktree) {
    return {
      request,
      created: false,
      result: errorResult(request, toSidecarError(new Error("SAFETY_REFUSAL: codex_work requires worktree isolation"))),
    };
  }

  const dependencies = resolveDependencies(options);
  let plan: WorktreePlan | undefined;
  let created = false;
  let state: WorktreeState | undefined;

  try {
    throwIfAborted(options.abortSignal);
    plan = await dependencies.plan(request, options);
    throwIfAborted(options.abortSignal);
    await dependencies.create(plan);
    created = true;
    throwIfAborted(options.abortSignal);

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
      request,
      plan,
      created,
      result: {
        ...result,
        workflow: request.workflow,
        normalizedRequest: request,
        changedFiles: state.changedFiles,
        worktreePath: plan.worktreePath,
        worktreePreserved: request.preserveWorktree,
      },
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
    return { request, plan, created, result };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error("APP_SERVER_CANCELLED: durable work cancellation requested before the next worktree side effect");
}

/**
 * 呼び出し元が実行結果を耐久化してから完了 worktree を削除する。削除失敗は reject
 * して、未削除を成功した cleanup と誤認させない。
 */
export async function cleanupWorktreeExecution(
  execution: WorktreeExecution,
  options: WorktreeRunOptions = {},
): Promise<WorktreeCleanupResult> {
  if (!execution.created || !execution.plan || execution.request.preserveWorktree) {
    return { cleanup: "not-requested" };
  }

  const removal = await resolveDependencies(options).remove(execution.plan);
  return {
    cleanup: "completed",
    alreadyCompleted: removal?.alreadyCompleted ?? false,
  };
}

export async function runWorktreeAppServerRequest(
  request: SidecarRequest,
  options: WorktreeRunOptions = {},
): Promise<SidecarResult> {
  const execution = await executeWorktreeAppServerRequest(request, options);
  await cleanupWorktreeExecution(execution, options);
  return execution.result;
}

function resolveDependencies(options: WorktreeRunOptions) {
  return {
    plan: planWorktree,
    create: createWorktree,
    collect: collectWorktreeState,
    assertAllowed: assertWorktreeChangesAllowed,
    remove: removeWorktree,
    runAppServer: runReadOnlyAppServerRequest,
    ...options.dependencies,
  };
}
