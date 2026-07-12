import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { matchesProcessIdentity, processStartIdentity, type ProcessIdentity } from "./process-identity.js";

const execFileAsync = promisify(execFile);

export type ProcessGroupState = "alive" | "stopped" | "unknown";

/** A group may only be stopped through the live ChildProcess handle that owns it. */
export interface OwnedProcessGroup {
  child: ChildProcess;
  identity: ProcessIdentity;
  processGroupId: number;
}

export interface ProcessGroupDiagnostic {
  identity: ProcessIdentity;
  processGroupId: number;
  state: ProcessGroupState;
}

export interface ProcessGroupStopResult {
  termSent: boolean;
  killSent: boolean;
  exited: boolean;
  closed: boolean;
}

/** Captures a detached POSIX child group. The caller must retain the returned handle. */
export async function ownProcessGroup(child: ChildProcess): Promise<OwnedProcessGroup> {
  requirePosix();
  if (!child.pid) throw coded("RUN_INTERNAL_ERROR", "child process has no pid");
  const identity = { pid: child.pid, startIdentity: await processStartIdentity(child.pid) };
  const processGroupId = await groupId(child.pid);
  if (processGroupId !== child.pid) throw coded("RUN_INTERNAL_ERROR", "child is not a detached process-group leader");
  return { child, identity, processGroupId };
}

/** Read-only diagnostic; it never signals a PID or a process group. */
export async function inspectProcessGroup(identity: ProcessIdentity, processGroupId: number): Promise<ProcessGroupDiagnostic> {
  requirePosix();
  try {
    if (!await matchesProcessIdentity(identity)) return { identity, processGroupId, state: processGroupAlive(processGroupId) ? "unknown" : "stopped" };
    return { identity, processGroupId, state: await groupId(identity.pid) === processGroupId ? "alive" : "unknown" };
  } catch { return { identity, processGroupId, state: "unknown" }; }
}

/** Bounded TERM → KILL shutdown for a worker-owned ChildProcess handle only. */
export async function stopOwnedProcessGroup(owned: OwnedProcessGroup, timeoutMs = 1_000): Promise<ProcessGroupStopResult> {
  requirePosix();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw coded("RUN_INVALID_INPUT", "timeoutMs must be a positive integer");
  const result: ProcessGroupStopResult = { termSent: false, killSent: false, exited: owned.child.exitCode !== null || owned.child.signalCode !== null, closed: owned.child.exitCode !== null || owned.child.signalCode !== null };
  if (result.exited && !processGroupAlive(owned.processGroupId)) return result;
  if (!result.exited) {
    if (!await matchesProcessIdentity(owned.identity)) throw coded("RUN_ORPHANED", "child process identity changed before shutdown");
    if (await groupId(owned.identity.pid) !== owned.processGroupId) throw coded("RUN_ORPHANED", "child process group changed before shutdown");
  }
  const done = waitForExitAndClose(owned.child);
  try { process.kill(-owned.processGroupId, "SIGTERM"); result.termSent = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  if (!await groupSettled(done, owned.processGroupId, timeoutMs)) {
    try { process.kill(-owned.processGroupId, "SIGKILL"); result.killSent = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    if (!await groupSettled(done, owned.processGroupId, timeoutMs)) throw coded("RUN_INTERNAL_ERROR", "process group did not close after SIGKILL");
  }
  result.exited = owned.child.exitCode !== null || owned.child.signalCode !== null;
  result.closed = await settles(done, 1);
  return result;
}

async function groupId(pid: number): Promise<number> { const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }); const value = Number.parseInt(stdout.trim(), 10); if (!Number.isSafeInteger(value) || value <= 0) throw new Error("process group is not observable"); return value; }
function waitForExitAndClose(child: ChildProcess): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); return new Promise((resolve) => { let exited = false; let closed = false; const done = () => { if (exited && closed) resolve(); }; child.once("exit", () => { exited = true; done(); }); child.once("close", () => { closed = true; done(); }); }); }
async function settles(done: Promise<void>, timeoutMs: number): Promise<boolean> { return Promise.race([done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))]); }
async function groupSettled(done: Promise<void>, processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await settles(done, 1) && !processGroupAlive(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}
function processGroupAlive(processGroupId: number): boolean {
  try { process.kill(-processGroupId, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; if ((error as NodeJS.ErrnoException).code === "EPERM") return true; throw error; }
}
function requirePosix(): void { if (process.platform === "win32") throw coded("RUN_UNSUPPORTED_PLATFORM", "process groups require POSIX"); }
function coded(code: string, message: string): Error { return Object.assign(new Error(`${code}: ${message}`), { code }); }
