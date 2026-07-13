import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type CommandFs = Pick<typeof import("node:fs/promises"), "lstat" | "readFile" | "realpath">;
export type WindowsCommand = { command: string; args: string[] };
const FLAG = "--factory-windows-mcp-resolve";
const OUTPUT_LIMIT = 4_096;
const PATTERNS = [
  /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n+IF EXIST "%dp0%\\node\.exe" \(\n SET "_prog=%dp0%\\node\.exe"\n\) ELSE \(\n SET "_prog=node"\n\)\n+endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"\s+"%dp0%\\(node_modules(?:\\[A-Za-z0-9@._-]+)+\.(?:cjs|mjs|js))"\s+%\*\n?$/iu,
  /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n+IF EXIST "%dp0%\\node\.exe" \(\n  SET "_prog=%dp0%\\node\.exe"\n\) ELSE \(\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n\)\n+endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"  "%dp0%\\(node_modules(?:\\[A-Za-z0-9@._-]+)+\.(?:cjs|mjs|js))" %\*\n?$/iu,
];

const envValue = (env: NodeJS.ProcessEnv, name: string) => env[Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) ?? ""];
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
const localDrive = (value: string) => /^[A-Za-z]:\\/u.test(value);

export async function resolveMcpCommand({ platform = process.platform, env = process.env, fs = { lstat, readFile, realpath }, pathModule = win32, nodePath = process.execPath }: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; fs?: CommandFs; pathModule?: typeof win32; nodePath?: string } = {}): Promise<WindowsCommand | undefined> {
  if (platform !== "win32") return { command: "codex-sidecar-mcp", args: [] };
  const path = envValue(env, "PATH");
  const pathext = envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  if (!path) return undefined;
  const directories = path.split(pathModule.delimiter).filter(Boolean);
  const extensions = pathext.split(";").filter(Boolean).map((value) => value.toLowerCase());
  if (directories.some((value) => !localDrive(value)) || extensions.some((value) => !/^\.[a-z0-9]+$/u.test(value))) return undefined;
  const canonicalDirectories: string[] = [];
  for (const directory of directories) {
    let canonical; try { canonical = await fs.realpath(directory); } catch (error) { if (missing(error)) continue; return undefined; }
    if (!localDrive(canonical)) return undefined;
    canonicalDirectories.push(canonical);
  }
  for (const directory of canonicalDirectories) for (const extension of extensions) {
    if (extension !== ".exe" && extension !== ".cmd") continue;
    const shim = pathModule.join(directory, `codex-sidecar-mcp${extension}`);
    let info; try { info = await fs.lstat(shim); } catch (error) { if (missing(error)) continue; return undefined; }
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    if (extension === ".exe") {
      let resolved; try { resolved = await fs.realpath(shim); } catch { return undefined; }
      return localDrive(resolved) ? { command: resolved, args: [] } : undefined;
    }
    if (info.size > OUTPUT_LIMIT) return undefined;
    let source: string; try { source = (await fs.readFile(shim, "utf8")).replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n"); } catch { return undefined; }
    const match = PATTERNS.map((pattern) => pattern.exec(source)).find(Boolean); if (!match) return undefined;
    const segments = match[1].split("\\"); if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
    try {
      const base = await fs.realpath(pathModule.dirname(shim)); if (!localDrive(base)) return undefined;
      const entry = pathModule.join(base, ...segments); const entryInfo = await fs.lstat(entry);
      if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) return undefined;
      const resolved = await fs.realpath(entry); const relative = pathModule.relative(pathModule.join(base, "node_modules"), resolved);
      return localDrive(resolved) && relative && relative !== ".." && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative) ? { command: nodePath, args: [resolved] } : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

export function parseHelperOutput(stdout: string): WindowsCommand | undefined {
  if (Buffer.byteLength(stdout, "utf8") > OUTPUT_LIMIT) return undefined;
  try { const value = JSON.parse(stdout); return value?.status === "ok" && Object.keys(value).length === 3 && typeof value.command === "string" && Array.isArray(value.args) && value.args.every((arg: unknown) => typeof arg === "string") ? { command: value.command, args: value.args } : undefined; } catch { return undefined; }
}

export function resolveMcpCommandInHelper(deadlineAt: number, { spawnProcess = spawn, environment = process.env, nodePath = process.execPath, helperPath = fileURLToPath(import.meta.url) }: { spawnProcess?: typeof spawn; environment?: NodeJS.ProcessEnv; nodePath?: string; helperPath?: string } = {}): Promise<WindowsCommand | undefined> {
  return new Promise((resolve) => {
    const input = JSON.stringify({ path: envValue(environment, "PATH") ?? "", pathext: envValue(environment, "PATHEXT") ?? null });
    if (Buffer.byteLength(input, "utf8") > OUTPUT_LIMIT) { resolve(undefined); return; }
    const remaining = deadlineAt - Date.now(); if (remaining <= 0) { resolve(undefined); return; }
    let child; try { child = spawnProcess(nodePath, [helperPath, FLAG], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }); } catch { resolve(undefined); return; }
    let stdout = ""; let done = false; const finish = (value: WindowsCommand | undefined) => { if (done) return; done = true; clearTimeout(timer); if (!child.killed) child.kill(); resolve(value); };
    const timer = setTimeout(() => finish(undefined), remaining);
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { if (done) return; stdout += chunk; if (Buffer.byteLength(stdout, "utf8") > OUTPUT_LIMIT) finish(undefined); });
    child.once("error", () => finish(undefined)); child.once("close", (code) => finish(code === 0 && !done ? parseHelperOutput(stdout) : undefined));
    child.stdin.once("error", () => finish(undefined));
    try { child.stdin.end(input); } catch { finish(undefined); }
  });
}

if (process.argv[2] === FLAG) {
  let input = ""; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input, "utf8") > OUTPUT_LIMIT) process.exit(1); }
  try { const value = JSON.parse(input); if (!value || typeof value.path !== "string" || !(value.pathext === null || typeof value.pathext === "string") || Object.keys(value).length !== 2) throw new Error(); const resolved = await resolveMcpCommand({ env: { PATH: value.path, ...(value.pathext === null ? {} : { PATHEXT: value.pathext }) } }); process.stdout.write(JSON.stringify(resolved ? { status: "ok", ...resolved } : { status: "error" })); } catch { process.stdout.write(JSON.stringify({ status: "error" })); }
}
