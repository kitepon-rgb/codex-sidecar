import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createWorktree, inspectWorktreePresence, parsePorcelainStatus, removeWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);

test("parsePorcelainStatus extracts changed file paths", () => {
  assert.deepEqual(parsePorcelainStatus(" M src/index.ts\n?? docs/plan.md\n"), [
    "src/index.ts",
    "docs/plan.md",
  ]);
});

test("parsePorcelainStatus returns destination path for renames", () => {
  assert.deepEqual(parsePorcelainStatus("R  old.ts -> src/new.ts\n"), ["src/new.ts"]);
});

test("removeWorktree removes dirty isolated worktrees", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codex-sidecar-worktree-test-"));
  const worktreePath = join(repo, "wt");

  try {
    await git(repo, ["init"]);
    await writeFile(join(repo, "README.md"), "root\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    const plan = await createWorktree({
      projectRoot: repo,
      worktreePath,
      baseRef: "HEAD",
    });
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n");

    const removal = await removeWorktree(plan);

    assert.deepEqual(removal, { alreadyCompleted: false });
    assert.equal(existsSync(worktreePath), false);
    assert.deepEqual(await inspectWorktreePresence(plan), { registered: false, pathExists: false });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree treats an absent registration and path as already completed", async () => {
  const repo = await createRepository();
  const plan = { projectRoot: repo, worktreePath: join(repo, "already removed"), baseRef: "HEAD" };

  try {
    assert.deepEqual(await removeWorktree(plan), { alreadyCompleted: true });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree refuses an unregistered directory without deleting it", async () => {
  const repo = await createRepository();
  const worktreePath = join(repo, "not a worktree");
  const plan = { projectRoot: repo, worktreePath, baseRef: "HEAD" };

  try {
    await mkdir(worktreePath);
    await writeFile(join(worktreePath, "must remain.txt"), "must remain\n");
    await assert.rejects(removeWorktree(plan), /WORKTREE_ERROR: refusing cleanup/);
    assert.equal(existsSync(worktreePath), true);
    assert.equal(existsSync(join(worktreePath, "must remain.txt")), true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree refuses an unregistered dangling symlink", async () => {
  const repo = await createRepository();
  const worktreePath = join(repo, "dangling worktree link");
  const plan = { projectRoot: repo, worktreePath, baseRef: "HEAD" };

  try {
    await symlink(join(repo, "missing-target"), worktreePath);
    await assert.rejects(removeWorktree(plan), /WORKTREE_ERROR: refusing cleanup/);
    assert.equal((await lstat(worktreePath)).isSymbolicLink(), true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree refuses a registered worktree whose directory is missing", async () => {
  const repo = await createRepository();
  const worktreePath = join(repo, "missing worktree");
  const plan = await createWorktree({ projectRoot: repo, worktreePath, baseRef: "HEAD" });

  try {
    await rm(worktreePath, { recursive: true, force: true });
    assert.deepEqual(await inspectWorktreePresence(plan), { registered: true, pathExists: false });
    await assert.rejects(removeWorktree(plan), /WORKTREE_ERROR: refusing cleanup/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree refuses a registered path replaced by an unrelated directory", async () => {
  const repo = await createRepository();
  const worktreePath = join(repo, "replaced worktree");
  const plan = await createWorktree({ projectRoot: repo, worktreePath, baseRef: "HEAD" });

  try {
    await rm(worktreePath, { recursive: true, force: true });
    await mkdir(worktreePath);
    await writeFile(join(worktreePath, "must remain.txt"), "unrelated\n");
    await assert.rejects(removeWorktree(plan), /WORKTREE_ERROR: refusing cleanup/);
    assert.equal(existsSync(join(worktreePath, "must remain.txt")), true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree refuses a registered path replaced by a symlink", async () => {
  const repo = await createRepository();
  const worktreePath = join(repo, "replaced worktree link");
  const targetPath = join(repo, "unrelated target");
  const plan = await createWorktree({ projectRoot: repo, worktreePath, baseRef: "HEAD" });

  try {
    await rm(worktreePath, { recursive: true, force: true });
    await mkdir(targetPath);
    await writeFile(join(targetPath, "must remain.txt"), "unrelated\n");
    await symlink(targetPath, worktreePath);
    await assert.rejects(removeWorktree(plan), /WORKTREE_ERROR: refusing cleanup/);
    assert.equal((await lstat(worktreePath)).isSymbolicLink(), true);
    assert.equal(existsSync(join(targetPath, "must remain.txt")), true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function createRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "codex-sidecar-worktree-test-"));
  await git(repo, ["init"]);
  await writeFile(join(repo, "README.md"), "root\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  return repo;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}
