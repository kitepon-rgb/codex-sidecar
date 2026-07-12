import assert from "node:assert/strict";
import { chmod, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __runTransitionTestHooks, claimRunTransition, inspectRunTransition, releaseRunTransition } from "./run-transition.js";

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  return realpath(root);
}

test("transition claim is exclusive and exact owner release makes it available", async (t) => {
  const run = await fixture(t);
  const lease = await claimRunTransition(run);
  await assert.rejects(() => claimRunTransition(run), { code: "RUN_ORPHANED" });
  assert.equal((await readdir(join(lease.directory, "claims"))).length, 1);
  assert.equal((await inspectRunTransition(run)).state, "held");
  await releaseRunTransition(lease);
  assert.deepEqual(await inspectRunTransition(run), { state: "available" });
});

test("dead owner remains durably held and is not automatically reclaimed", async (t) => {
  const run = await fixture(t);
  const module = new URL("./run-transition.js", import.meta.url).pathname;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {claimRunTransition} from ${JSON.stringify(module)}; await claimRunTransition(${JSON.stringify(run)})`], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child failed: ${code}`))); });
  const inspection = await inspectRunTransition(run);
  assert.equal(inspection.state, "held");
  if (inspection.state === "held") assert.equal(inspection.ownerRunning, false);
  await assert.rejects(() => claimRunTransition(run), { code: "RUN_ORPHANED" });
});

test("foreign release and same-content distinct-inode ABA fail closed", async (t) => {
  const run = await fixture(t);
  const lease = await claimRunTransition(run);
  const module = new URL("./run-transition.js", import.meta.url).pathname;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {releaseRunTransition} from ${JSON.stringify(module)}; releaseRunTransition(${JSON.stringify(lease)}).then(()=>process.exit(9),e=>process.exit(e.code==='RUN_ORPHANED'?0:8))`], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`foreign release failed: ${code}`))); });
  const duplicate = join(lease.directory, "claims", "same-content-copy.json");
  await writeFile(duplicate, await readFile(lease.claimPath), { mode: 0o600 });
  await rm(lease.currentPath);
  await link(duplicate, lease.currentPath);
  await assert.rejects(() => releaseRunTransition(lease), { code: "RUN_STORE_CORRUPT" });
});

test("unsafe transition directory is rejected", async (t) => {
  const run = await fixture(t);
  await mkdir(join(run, "transition"), { mode: 0o755 });
  await assert.rejects(() => claimRunTransition(run), { code: "RUN_STORE_CORRUPT" });
});

test("parallel duplicate release cannot unlink a later current claim", async (t) => {
  const run = await fixture(t); const lease = await claimRunTransition(run);
  let entered!: () => void; let resume!: () => void;
  const paused = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { resume = resolve; });
  __runTransitionTestHooks.beforeReleaseUnlink = async () => { entered(); await gate; };
  t.after(() => { __runTransitionTestHooks.beforeReleaseUnlink = undefined; });
  const first = releaseRunTransition(lease); await paused;
  await assert.rejects(() => releaseRunTransition(lease), { code: "RUN_ORPHANED" });
  resume(); await first;
  const later = await claimRunTransition(run);
  assert.equal((await inspectRunTransition(run)).state, "held");
  await releaseRunTransition(later);
});
