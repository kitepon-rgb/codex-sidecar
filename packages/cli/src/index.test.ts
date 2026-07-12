import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("auth-status is read-only and bypasses project config loading", async (t) => {
  const root = await fixture(t);
  const result = await runCli(root.home, root.cache, ["auth-status"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { state: "available" });
  await assert.rejects(() => lstat(root.cache), { code: "ENOENT" });
});

test("auth-recover rejects unknown strategy and missing confirmation before mutation", async (t) => {
  const root = await fixture(t);
  const unknown = await runCli(root.home, root.cache, ["auth-recover", "--session-id", "session-a", "--strategy", "not-a-strategy", "--confirm-no-running-processes"]);
  assert.equal(unknown.code, 1); assert.match(unknown.stdout, /--strategy must be one of/);
  const unconfirmed = await runCli(root.home, root.cache, ["auth-recover", "--session-id", "session-a", "--strategy", "release-never-started"]);
  assert.equal(unconfirmed.code, 1); assert.match(unconfirmed.stdout, /--confirm-no-running-processes is required/);
  await assert.rejects(() => lstat(root.cache), { code: "ENOENT" });
});

async function fixture(t: test.TestContext): Promise<{ home: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); const cache = join(root, "cache");
  await mkdir(home, { mode: 0o700 }); await chmod(home, 0o700);
  await writeFile(join(home, "auth.json"), '{"refresh":"R0"}\n', { mode: 0o600 });
  return { home, cache };
}

async function runCli(home: string, cache: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entrypoint = new URL("./index.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: { ...process.env, CODEX_HOME: home, XDG_CACHE_HOME: cache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, stdout, stderr };
}
