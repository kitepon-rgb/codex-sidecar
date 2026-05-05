import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createWorktree, parsePorcelainStatus, removeWorktree } from "./worktree.js";

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

    await removeWorktree(plan);

    assert.equal(existsSync(worktreePath), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}
