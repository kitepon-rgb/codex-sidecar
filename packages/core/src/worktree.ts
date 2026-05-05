import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertPathsAllowed } from "./paths.js";
import type { SidecarRequest, WorktreePlan, WorktreeState } from "./types.js";

const execFileAsync = promisify(execFile);

export interface WorktreeOptions {
  worktreeRoot?: string;
  baseRef?: string;
  branchName?: string;
}

export async function planWorktree(request: SidecarRequest, options: WorktreeOptions = {}): Promise<WorktreePlan> {
  if (request.workflow !== "work") {
    throw new Error("WORKTREE_ERROR: only codex_work may create a worktree");
  }

  if (!request.requireWorktree) {
    throw new Error("SAFETY_REFUSAL: codex_work requires worktree isolation");
  }

  const baseRef = options.baseRef ?? "HEAD";
  const worktreeRoot =
    options.worktreeRoot ?? (await mkdtemp(join(tmpdir(), `${safeName(basename(request.projectRoot))}-codex-sidecar-`)));

  return {
    projectRoot: request.projectRoot,
    worktreePath: worktreeRoot,
    baseRef,
    branchName: options.branchName,
  };
}

export async function createWorktree(plan: WorktreePlan): Promise<WorktreePlan> {
  await runGit(plan.projectRoot, ["rev-parse", "--is-inside-work-tree"]);

  const args = ["worktree", "add"];

  if (plan.branchName) {
    args.push("-b", plan.branchName);
  } else {
    args.push("--detach");
  }

  args.push(plan.worktreePath, plan.baseRef);
  await runGit(plan.projectRoot, args);
  return plan;
}

export async function collectWorktreeState(plan: WorktreePlan): Promise<WorktreeState> {
  const status = await runGit(plan.worktreePath, ["status", "--porcelain=v1"]);
  const changedFiles = parsePorcelainStatus(status.stdout);

  return {
    ...plan,
    changedFiles,
  };
}

export async function assertWorktreeChangesAllowed(state: WorktreeState, request: SidecarRequest): Promise<void> {
  assertPathsAllowed(state.changedFiles, {
    allowedPaths: request.allowedPaths,
    denyPaths: request.denyPaths,
  });
}

export async function removeWorktree(plan: WorktreePlan): Promise<void> {
  await runGit(plan.projectRoot, ["worktree", "remove", "--force", plan.worktreePath]);
}

export function parsePorcelainStatus(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => normalizeStatusPath(line.slice(3)));
}

function normalizeStatusPath(path: string): string {
  const renameMarker = " -> ";
  const markerIndex = path.indexOf(renameMarker);
  return markerIndex === -1 ? path : path.slice(markerIndex + renameMarker.length);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`WORKTREE_ERROR: git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}
