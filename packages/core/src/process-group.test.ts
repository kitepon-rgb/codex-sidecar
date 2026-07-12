import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectProcessGroup, ownProcessGroup, stopOwnedProcessGroup } from "./process-group.js";
import { currentProcessIdentity, matchesProcessIdentity, processStartIdentity } from "./process-identity.js";

function child(code: string) { return spawn(process.execPath, ["--input-type=module", "-e", code], { detached: true, stdio: ["ignore", "ignore", "ignore"] }); }
async function waitForExit(childProcess: ReturnType<typeof child>) { if (childProcess.exitCode !== null || childProcess.signalCode !== null) return; await new Promise<void>((resolve) => childProcess.once("exit", () => resolve())); }
async function settle(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 50)); }

test("owned group sends TERM then KILL to a TERM-ignoring child", { skip: process.platform === "win32" }, async (t) => {
  const process = child("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"); t.after(() => { try { process.kill("SIGKILL"); } catch {} });
  const owned = await ownProcessGroup(process); await settle(); const result = await stopOwnedProcessGroup(owned, 500);
  assert.equal(result.termSent, true); assert.equal(result.killSent, true); assert.equal(result.exited, true); assert.equal(result.closed, true);
});

test("owned group shutdown reaches descendants in the same detached group", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sidecar-pgid-"));
  const pidPath = join(directory, "descendant.pid");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const process = child(`import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const descendant=spawn(process.execPath,['--input-type=module','-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidPath)},String(descendant.pid)); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)`); t.after(() => { try { process.kill("SIGKILL"); } catch {} });
  const owned = await ownProcessGroup(process); await settle();
  const descendantPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
  const descendantIdentity = { pid: descendantPid, startIdentity: await processStartIdentity(descendantPid) };
  const result = await stopOwnedProcessGroup(owned, 500);
  assert.equal(result.termSent, true); assert.equal((await inspectProcessGroup(owned.identity, owned.processGroupId)).state, "stopped");
  assert.equal(await matchesProcessIdentity(descendantIdentity), false);
});

test("identity mismatch fails closed without signalling a recorded group", { skip: process.platform === "win32" }, async (t) => {
  const process = child("setInterval(()=>{},1000)"); t.after(() => { try { process.kill("SIGKILL"); } catch {} });
  const owned = await ownProcessGroup(process); owned.identity = { ...(await currentProcessIdentity()), pid: process.pid!, startIdentity: "not-the-child" };
  await assert.rejects(() => stopOwnedProcessGroup(owned, 20), { code: "RUN_ORPHANED" }); assert.equal(process.exitCode, null);
});

test("already exited child is a no-op and diagnostics never signal", { skip: process.platform === "win32" }, async () => {
  const process = child("process.exit(0)"); await waitForExit(process);
  const owned = { child: process, identity: { pid: process.pid!, startIdentity: "gone" }, processGroupId: process.pid! };
  const result = await stopOwnedProcessGroup(owned); assert.equal(result.termSent, false); assert.equal((await inspectProcessGroup(owned.identity, owned.processGroupId)).state, "stopped");
});

test("leader exit does not hide a surviving descendant in the owned group", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sidecar-leader-exit-")); const pidPath = join(directory, "descendant.pid");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const process = child(`import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const descendant=spawn(process.execPath,['--input-type=module','-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidPath)},String(descendant.pid)); setTimeout(()=>process.exit(0),150)`);
  const owned = await ownProcessGroup(process); const descendantPid = await waitForPid(pidPath); const descendantIdentity = { pid: descendantPid, startIdentity: await processStartIdentity(descendantPid) };
  await waitForExit(process);
  assert.equal((await inspectProcessGroup(owned.identity, owned.processGroupId)).state, "unknown");
  const result = await stopOwnedProcessGroup(owned, 500);
  assert.equal(result.termSent, true); assert.equal(await matchesProcessIdentity(descendantIdentity), false);
});

test("signal-terminated leader does not hide a surviving descendant in the owned group", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sidecar-leader-signal-")); const pidPath = join(directory, "descendant.pid");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const process = child(`import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const descendant=spawn(process.execPath,['--input-type=module','-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidPath)},String(descendant.pid)); setInterval(()=>{},1000)`);
  const owned = await ownProcessGroup(process); const descendantPid = await waitForPid(pidPath); const descendantIdentity = { pid: descendantPid, startIdentity: await processStartIdentity(descendantPid) };
  process.kill("SIGKILL"); await waitForExit(process);
  const result = await stopOwnedProcessGroup(owned, 500);
  assert.equal(result.termSent, true); assert.equal(await matchesProcessIdentity(descendantIdentity), false);
});

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { return Number.parseInt(await readFile(path, "utf8"), 10); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("descendant pid file timed out");
}
