import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

export interface WorktreePresence {
  registered: boolean;
  pathExists: boolean;
}

export interface WorktreeRemovalResult {
  alreadyCompleted: boolean;
}

interface WorktreeRegistration {
  worktreePath: string;
  markerPath: string;
  adminDirectory: string;
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

export async function removeWorktree(plan: WorktreePlan): Promise<WorktreeRemovalResult> {
  const before = await inspectWorktreePresence(plan);
  if (!before.registered && !before.pathExists) {
    return { alreadyCompleted: true };
  }
  if (!before.registered || !before.pathExists) {
    throw inconsistentWorktreeState(plan, before);
  }

  await assertRegisteredWorktreeIdentity(plan);

  await runGit(plan.projectRoot, ["worktree", "remove", "--force", plan.worktreePath]);

  const after = await inspectWorktreePresence(plan);
  if (after.registered || after.pathExists) {
    throw new Error(
      `WORKTREE_ERROR: git worktree remove left registration=${after.registered} pathExists=${after.pathExists} for ${plan.worktreePath}`,
    );
  }

  return { alreadyCompleted: false };
}

export async function inspectWorktreePresence(plan: WorktreePlan): Promise<WorktreePresence> {
  const targetPath = resolve(plan.worktreePath);
  // `git worktree list` prunes stale registration records as a side effect. Read
  // the administrative records first so a missing registered worktree remains a
  // fail-closed inconsistency instead of being mistaken for an earlier cleanup.
  const registrations = await registeredWorktreeRegistrations(plan.projectRoot);
  const [worktrees, pathExists] = await Promise.all([
    runGit(plan.projectRoot, ["worktree", "list", "--porcelain"]),
    pathExistsAt(targetPath),
  ]);
  const registeredPaths = worktrees.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .concat(registrations.map((registration) => registration.worktreePath));

  return {
    registered: await registeredPathsContain(registeredPaths, targetPath),
    pathExists,
  };
}

async function registeredWorktreeRegistrations(projectRoot: string): Promise<WorktreeRegistration[]> {
  const worktreesDirectory = (await runGit(projectRoot, ["rev-parse", "--git-path", "worktrees"])).stdout.trim();
  if (!worktreesDirectory) {
    throw new Error("WORKTREE_ERROR: git did not report its worktree registration directory");
  }

  let entries: string[];
  try {
    entries = await readdir(resolve(projectRoot, worktreesDirectory));
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }

  return Promise.all(entries.map(async (entry) => {
    const adminDirectory = join(resolve(projectRoot, worktreesDirectory), entry);
    const gitdirPath = join(adminDirectory, "gitdir");
    try {
      const markerPath = resolve(await readRegularFileNoFollow(gitdirPath));
      return { worktreePath: dirname(markerPath), markerPath, adminDirectory };
    } catch (error) {
      if (isMissingPath(error)) {
        throw new Error(`WORKTREE_ERROR: incomplete git worktree registration at ${gitdirPath}`);
      }
      throw error;
    }
  }));
}

async function assertRegisteredWorktreeIdentity(plan: WorktreePlan): Promise<void> {
  const targetPath = resolve(plan.worktreePath);
  const target = await lstat(targetPath);
  if (!target.isDirectory() || target.isSymbolicLink()) {
    throw new Error(`WORKTREE_ERROR: refusing cleanup because the registered path is not a real directory: ${targetPath}`);
  }

  const registration = await findRegistration(await registeredWorktreeRegistrations(plan.projectRoot), targetPath);
  if (!registration) {
    throw new Error(`WORKTREE_ERROR: refusing cleanup because no exact admin registration exists for ${targetPath}`);
  }

  const markerPath = join(targetPath, ".git");
  let markerValue: string;
  try {
    markerValue = await readRegularFileNoFollow(markerPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`WORKTREE_ERROR: refusing cleanup because the gitdir marker is invalid at ${markerPath}: ${detail}`);
  }
  const prefix = "gitdir: ";
  if (!markerValue.startsWith(prefix)) {
    throw new Error(`WORKTREE_ERROR: refusing cleanup because ${markerPath} is not a gitdir marker`);
  }
  const markerAdminDirectory = resolve(dirname(markerPath), markerValue.slice(prefix.length));
  if (await pathIdentity(markerAdminDirectory) !== await pathIdentity(registration.adminDirectory) ||
    await pathIdentity(markerPath) !== await pathIdentity(registration.markerPath)) {
    throw new Error(`WORKTREE_ERROR: refusing cleanup because worktree and admin identities do not match for ${targetPath}`);
  }
}

async function findRegistration(registrations: WorktreeRegistration[], targetPath: string): Promise<WorktreeRegistration | undefined> {
  const targetIdentity = await pathIdentity(targetPath);
  for (const registration of registrations) {
    if (await pathIdentity(registration.worktreePath) === targetIdentity) {
      return registration;
    }
  }
  return undefined;
}

async function readRegularFileNoFollow(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile()) {
      throw new Error(`WORKTREE_ERROR: expected a regular file at ${path}`);
    }
    return (await handle.readFile({ encoding: "utf8" })).trim();
  } finally {
    await handle.close();
  }
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

async function registeredPathsContain(paths: string[], targetPath: string): Promise<boolean> {
  const targetIdentity = await pathIdentity(targetPath);
  for (const path of paths) {
    if (await pathIdentity(path) === targetIdentity) {
      return true;
    }
  }
  return false;
}

async function pathIdentity(path: string): Promise<string> {
  let currentPath = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return join(await realpath(currentPath), ...missingSegments);
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return resolve(path);
      }
      missingSegments.unshift(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

async function pathExistsAt(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function inconsistentWorktreeState(plan: WorktreePlan, presence: WorktreePresence): Error {
  return new Error(
    `WORKTREE_ERROR: refusing cleanup with registration=${presence.registered} pathExists=${presence.pathExists} for ${plan.worktreePath}`,
  );
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
