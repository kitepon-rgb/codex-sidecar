import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { mcpPackageVersion } from "./diagnostics.js";
import { resolveMcpCommand, resolveMcpCommandInHelper } from "./windows-command-resolver.js";

const exec = promisify(execFile);
const key = "abcdefghijklmnopqrstuv";

type FakeHelper = EventEmitter & {
  killed: boolean;
  kill: () => boolean;
  stdin: EventEmitter & { destroy: () => void; end: (input: string) => void };
  stdout: EventEmitter & { destroy: () => void; setEncoding: (encoding: string) => void };
};

function fakeHelper(): FakeHelper {
  const child = new EventEmitter() as FakeHelper;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdin = Object.assign(new EventEmitter(), { destroy: () => undefined, end: () => undefined });
  child.stdout = Object.assign(new EventEmitter(), { destroy: () => undefined, setEncoding: () => undefined });
  return child;
}

test("--version prints the packaged CLI version without config or cache access", async (t) => {
  const root = await fixture(t);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const result = await runCli(root.home, root.cache, ["--version"]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stdout, `${manifest.version}\n`);
  assert.equal(result.stderr, "");
  await assert.rejects(() => lstat(root.cache), { code: "ENOENT" });
});

test("auth-status is read-only and bypasses project config loading", async (t) => {
  const root = await fixture(t);
  const result = await runCli(root.home, root.cache, ["auth-status"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { state: "available" });
  await assert.rejects(() => lstat(root.cache), { code: "ENOENT" });
});

test("factory-errors exposes a bounded snapshot/ack contract and fixed failures", async (t) => {
  const root = await fixture(t);
  const env = { HOME: root.home, XDG_STATE_HOME: join(root.home, "state"), XDG_CONFIG_HOME: join(root.home, "config") };
  const snapshot = await runCli(root.home, root.cache, ["factory-errors"], env);
  assert.equal(snapshot.code, 0, snapshot.stdout);
  assert.deepEqual(JSON.parse(snapshot.stdout), {
    status: "ok",
    factoryRuntimeErrors: { schema_version: "2", cursor: 0, acknowledged_through: 0, records: [] },
  });
  const ack = await runCli(root.home, root.cache, ["factory-errors", "--action", "ack", "--cursor", "0"], env);
  assert.equal(ack.code, 0, ack.stdout);
  assert.deepEqual(JSON.parse(ack.stdout), { status: "ok", action: "ack", cursor: 0 });
  const missing = await runCli(root.home, root.cache, ["factory-errors", "--action", "resolve"], env);
  assert.equal(missing.code, 1);
  assert.deepEqual(JSON.parse(missing.stdout), { status: "failed", errorCode: "FACTORY_RUNTIME_ERROR_STORE_UNAVAILABLE" });
  assert.equal(missing.stdout.includes(root.home), false);
  const reopenMissing = await runCli(root.home, root.cache, ["factory-errors", "--action", "reopen"], env);
  assert.equal(reopenMissing.code, 1);
  assert.deepEqual(JSON.parse(reopenMissing.stdout), { status: "failed", errorCode: "FACTORY_RUNTIME_ERROR_STORE_UNAVAILABLE" });
});

test("auth-recover rejects unknown strategy and missing confirmation before mutation", async (t) => {
  const root = await fixture(t);
  const unknown = await runCli(root.home, root.cache, ["auth-recover", "--session-id", "session-a", "--strategy", "not-a-strategy", "--confirm-no-running-processes"]);
  assert.equal(unknown.code, 1); assert.match(unknown.stdout, /--strategy must be one of/);
  const unconfirmed = await runCli(root.home, root.cache, ["auth-recover", "--session-id", "session-a", "--strategy", "release-never-started"]);
  assert.equal(unconfirmed.code, 1); assert.match(unconfirmed.stdout, /--confirm-no-running-processes is required/);
  await assert.rejects(() => lstat(root.cache), { code: "ENOENT" });
});

test("diagnostics preserves the normalized request compatibility contract", async (t) => {
  const root = await workFixture(t);
  const result = await runCli(root.home, root.cache, ["diagnostics", "--project", root.repo]);
  assert.equal(result.code, 0, result.stdout);
  const payload = JSON.parse(result.stdout) as {
    status: string;
    configFile: string;
    projectRoot: string;
    normalizedRequest: { workflow: string; projectRoot: string; dryRun: boolean };
    modelPolicy: { source: string };
  };
  assert.equal(payload.status, "ok");
  assert.equal(payload.configFile, ".codex-sidecar.yml");
  assert.equal(payload.projectRoot, root.repo);
  assert.equal(payload.normalizedRequest.workflow, "review");
  assert.equal(payload.normalizedRequest.projectRoot, root.repo);
  assert.equal(payload.normalizedRequest.dryRun, true);
  assert.equal(payload.modelPolicy.source, "inherited");
  assert.equal("factoryReadiness" in payload, false);
});

test("factory-diagnostics flushes complete ready JSON through a pipe without exposing request or filesystem data", async (t) => {
  const root = await workFixture(t);
  const bin = join(root.root, "bin");
  await mkdir(bin);
  const mcp = join(bin, "codex-sidecar-mcp");
  await writeFile(mcp, `#!/bin/sh
read request
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"codex-sidecar","version":"0.3.7"}}}'
`);
  await chmod(mcp, 0o755);
  const context = join(root.repo, "context.json");
  await writeFile(join(root.repo, ".codex-sidecar.yml"), [
    "project: cli-test",
    "defaults:",
    "  model: gpt-test-model",
    "presets:",
    "  review:",
    "    workflow: review",
    "    readonly: true",
    "    prompt: native-factory-private-prompt",
  ].join("\n"));
  await writeFile(context, JSON.stringify([{ kind: "manual_note", source: "test", trust: "local", summary: "native-factory-private-context" }]));

  const result = await runCli(root.home, root.cache, [
    "factory-diagnostics", "--project", root.repo, "--preset", "review", "--context-file", context,
  ], {
    PATH: `${bin}:${process.env.PATH}`,
    XDG_STATE_HOME: join(root.home, "state"),
    FACTORY_REPORTER_CONFIG: join(root.home, "missing-factory-reporter.json"),
  });

  assert.equal(result.code, 0, result.stdout);
  assert.ok(result.stdout.endsWith("\n"));
  const payload = JSON.parse(result.stdout) as {
    status: string;
    factoryReadiness: {
      schemaVersion: string;
      overall: string;
      packageVersions: { status: string; packages: Record<string, string> };
      resultSchema: { status: string };
      workflows: { status: string; entries: Record<string, { status: string }> };
      presets: { status: string; configured: number; ready: number; notReady: number; notApplicable: number };
      modelPolicy: { status: string; source: string; modelConfigured: boolean };
      readOnlyDryRun: { status: string; workflow: string };
      runtimeErrorStore: { status: string; collection: string; store: string; pending: number };
    };
  };
  assert.equal(payload.status, "ok");
  assert.deepEqual(payload.factoryReadiness, {
    schemaVersion: "1",
    overall: "ready",
    packageVersions: {
      status: "ready",
      packages: {
        cli: "0.3.7",
        core: "0.3.7",
        mcp: "0.3.7",
      },
    },
    resultSchema: { status: "ready" },
    workflows: {
      status: "ready",
      entries: {
        review: { status: "ready" },
        explore: { status: "ready" },
        work: { status: "not_applicable" },
        opinion: { status: "ready" },
        "risk-check": { status: "ready" },
        auditor: { status: "ready" },
        generate: { status: "ready" },
      },
    },
    presets: {
      status: "ready",
      configured: 1,
      ready: 1,
      notReady: 0,
      notApplicable: 0,
    },
    modelPolicy: { status: "ready", source: "explicit", modelConfigured: true, modelReasoningEffortConfigured: false },
    readOnlyDryRun: { status: "ready", workflow: "review" },
    runtimeErrorStore: { status: "not_applicable", schemaVersion: "2", collection: "disabled", store: "absent", pending: 0 },
  });
  assert.equal("normalizedRequest" in payload, false);
  assert.doesNotMatch(result.stdout, new RegExp(root.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.stdout, /native-factory-private-(prompt|context)/);
});

test("factory-diagnostics reports configuration failure as unverified without exposing the path", async (t) => {
  const root = await workFixture(t);
  await writeFile(join(root.repo, ".codex-sidecar.yml"), "project: [\n");
  const result = await runCli(root.home, root.cache, ["factory-diagnostics", "--project", root.repo]);
  assert.equal(result.code, 1);
  assert.ok(result.stdout.endsWith("\n"));
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "failed",
    factoryReadiness: { schemaVersion: "1", overall: "unverified" },
    errorCode: "PROTOCOL_ERROR",
  });
  assert.doesNotMatch(result.stdout, new RegExp(root.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("factory-diagnostics flushes a pipe-capacity-sized not-ready response before exit", async (t) => {
  const root = await workFixture(t);
  const bin = join(root.root, "bin");
  await mkdir(bin);
  const mcp = join(bin, "codex-sidecar-mcp");
  const version = `0.3.7+${"a".repeat(65_000)}`;
  await writeFile(mcp, `#!/bin/sh
read request
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"codex-sidecar","version":"${version}"}}}'
`);
  await chmod(mcp, 0o755);

  const result = await runCli(root.home, root.cache, ["factory-diagnostics", "--project", root.repo], {
    PATH: `${bin}:${process.env.PATH}`,
    XDG_STATE_HOME: join(root.home, "state"),
    FACTORY_REPORTER_CONFIG: join(root.home, "missing-factory-reporter.json"),
  }, 100);

  assert.equal(result.code, 1, result.stdout);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") > 65_536);
  assert.ok(result.stdout.endsWith("\n"));
  const payload = JSON.parse(result.stdout) as { status: string; factoryReadiness: { overall: string; packageVersions: { packages: { mcp: string } } } };
  assert.equal(payload.status, "failed");
  assert.equal(payload.factoryReadiness.overall, "not_ready");
  assert.equal(payload.factoryReadiness.packageVersions.packages.mcp, version);
});

test("factory-diagnostics handles EPIPE without rewriting JSON or reporting an unhandled error", async (t) => {
  const root = await workFixture(t);
  const bin = join(root.root, "bin");
  await mkdir(bin);
  const mcp = join(bin, "codex-sidecar-mcp");
  const version = `0.3.7+${"a".repeat(65_000)}`;
  await writeFile(mcp, `#!/bin/sh
read request
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"codex-sidecar","version":"${version}"}}}'
`);
  await chmod(mcp, 0o755);

  const result = await runCliWithBrokenPipe(root.home, root.cache, ["factory-diagnostics", "--project", root.repo], {
    PATH: `${bin}:${process.env.PATH}`,
    XDG_STATE_HOME: join(root.home, "state"),
    FACTORY_REPORTER_CONFIG: join(root.home, "missing-factory-reporter.json"),
  });

  assert.equal(result.code, 1, result.stderr);
  assert.ok(result.stdout.length > 0);
  assert.equal(result.stderr, "");
});

test("Windows factory diagnostics resolves only a verified npm cmd shim to its Node entrypoint", async () => {
  const shim = "C:\\npm\\codex-sidecar-mcp.cmd";
  const directory = "C:\\npm";
  const entrypoint = "C:\\npm\\node_modules\\codex-sidecar-mcp\\dist\\server.js";
  const files = new Map<string, { file: boolean; symlink: boolean }>([
    [shim, { file: true, symlink: false }],
    [entrypoint, { file: true, symlink: false }],
  ]);
  const shimText = [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
    "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\codex-sidecar-mcp\\dist\\server.js\" %*", "",
  ].join("\r\n");
  const fs = {
    lstat: async (path: string) => {
      const value = files.get(path);
      if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => value.file, isSymbolicLink: () => value.symlink };
    },
    readFile: async (path: string) => {
      assert.equal(path, shim);
      return shimText;
    },
    realpath: async (path: string) => path,
  };
  const resolved = await resolveMcpCommand({
    platform: "win32",
    env: { Path: directory, PATHEXT: ".PS1;.CMD;.EXE" },
    fs: fs as never,
    pathModule: win32,
    nodePath: "C:\\node\\node.exe",
  });
  assert.deepEqual(resolved, { command: "C:\\node\\node.exe", args: [entrypoint] });
});

test("Windows factory diagnostics accepts the one-space npm cmd shim variant", async () => {
  const shim = "C:\\npm\\codex-sidecar-mcp.cmd";
  const entrypoint = "C:\\npm\\node_modules\\codex-sidecar-mcp\\dist\\server.js";
  const shimText = [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
    "IF EXIST \"%dp0%\\node.exe\" (", " SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", " SET \"_prog=node\"", ")", "",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & \"%_prog%\" \"%dp0%\\node_modules\\codex-sidecar-mcp\\dist\\server.js\" %*", "",
  ].join("\r\n");
  const fs = {
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    readFile: async () => shimText,
    realpath: async (path: string) => path,
  };
  assert.deepEqual(await resolveMcpCommand({ platform: "win32", env: { PATH: "C:\\npm", PATHEXT: ".CMD" }, fs: fs as never, pathModule: win32, nodePath: "C:\\node\\node.exe" }), { command: "C:\\node\\node.exe", args: [entrypoint] });
});

test("Windows resolver rejects an oversized shim before reading it", async () => {
  let reads = 0;
  const resolved = await resolveMcpCommand({ platform: "win32", env: { PATH: "C:\\npm", PATHEXT: ".CMD" }, pathModule: win32, fs: {
    lstat: async () => ({ size: 4_097, isFile: () => true, isSymbolicLink: () => false }),
    readFile: async () => { reads += 1; return ""; }, realpath: async (path: string) => path,
  } as never });
  assert.equal(resolved, undefined);
  assert.equal(reads, 0);
});

test("Windows resolver rejects a directory junction canonicalized to UNC before probing a shim", async () => {
  let probes = 0;
  const resolved = await resolveMcpCommand({ platform: "win32", env: { PATH: "C:\\npm", PATHEXT: ".EXE" }, pathModule: win32, fs: {
    lstat: async () => { probes += 1; return { isFile: () => true, isSymbolicLink: () => false }; },
    readFile: async () => "", realpath: async () => "\\\\server\\share",
  } as never });
  assert.equal(resolved, undefined);
  assert.equal(probes, 0);
});

test("Windows resolver skips a missing PATH directory before a valid canonical exe", async () => {
  const missingDirectory = "C:\\missing";
  const directory = "C:\\npm";
  const exe = "C:\\npm\\codex-sidecar-mcp.exe";
  const resolved = await resolveMcpCommand({ platform: "win32", env: { PATH: `${missingDirectory};${directory}`, PATHEXT: ".EXE" }, pathModule: win32, fs: {
    lstat: async (path: string) => {
      assert.equal(path, exe);
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    readFile: async () => "",
    realpath: async (path: string) => {
      if (path === missingDirectory) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return path;
    },
  } as never });
  assert.deepEqual(resolved, { command: exe, args: [] });
});

test("Windows resolver returns only the canonical local exe path", async () => {
  const directory = "C:\\npm";
  const canonicalDirectory = "C:\\canonical-npm";
  const canonicalExe = "C:\\canonical-npm\\codex-sidecar-mcp.exe";
  const resolved = await resolveMcpCommand({ platform: "win32", env: { PATH: directory, PATHEXT: ".EXE" }, pathModule: win32, fs: {
    lstat: async (path: string) => {
      assert.equal(path, canonicalExe);
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    readFile: async () => "", realpath: async (path: string) => path === directory ? canonicalDirectory : canonicalExe,
  } as never });
  assert.deepEqual(resolved, { command: canonicalExe, args: [] });
});

test("Windows resolver rejects a cmd shim whose canonical entrypoint is UNC", async () => {
  const shim = "C:\\npm\\codex-sidecar-mcp.cmd";
  const entry = "C:\\npm\\node_modules\\codex-sidecar-mcp\\dist\\server.js";
  const source = [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
    "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\codex-sidecar-mcp\\dist\\server.js\" %*", "",
  ].join("\r\n");
  const resolved = await resolveMcpCommand({ platform: "win32", env: { PATH: "C:\\npm", PATHEXT: ".CMD" }, pathModule: win32, fs: {
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }), readFile: async () => source,
    realpath: async (path: string) => path === entry ? "\\\\server\\share\\server.js" : path,
  } as never });
  assert.equal(resolved, undefined);
  assert.equal(shim.endsWith(".cmd"), true);
});

test("Windows resolver helper kills and rejects oversized or malformed output", async () => {
  const oversized = fakeHelper();
  const oversizedResult = resolveMcpCommandInHelper(Date.now() + 1_000, { spawnProcess: (() => oversized) as never });
  oversized.stdout.emit("data", "x".repeat(4_097));
  assert.equal(await oversizedResult, undefined);
  assert.equal(oversized.killed, true);

  const malformed = fakeHelper();
  const malformedResult = resolveMcpCommandInHelper(Date.now() + 1_000, { spawnProcess: (() => malformed) as never });
  malformed.stdout.emit("data", '{"status":"ok","command":"node","args":[],"unexpected":true}');
  malformed.emit("close", 0);
  assert.equal(await malformedResult, undefined);
  assert.equal(malformed.killed, true);
});

test("Windows resolver helper kills an unresponsive UNC filesystem probe at its deadline", async () => {
  const child = fakeHelper();
  const result = resolveMcpCommandInHelper(Date.now() + 25, { spawnProcess: (() => child) as never, environment: { PATH: "\\\\server\\share" } });
  assert.equal(await result, undefined);
  assert.equal(child.killed, true);
});

test("Windows resolver rejects oversized helper input before spawning", async () => {
  let spawns = 0;
  const resolved = await resolveMcpCommandInHelper(Date.now() + 1_000, {
    spawnProcess: (() => { spawns += 1; return fakeHelper(); }) as never,
    environment: { PATH: "C:\\x;".repeat(300_000), PATHEXT: ".CMD" },
  });
  assert.equal(resolved, undefined);
  assert.equal(spawns, 0);
});

test("Windows resolver treats helper stdin EPIPE as an unavailable command", async () => {
  const child = fakeHelper();
  const result = resolveMcpCommandInHelper(Date.now() + 1_000, { spawnProcess: (() => child) as never });
  child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  assert.equal(await result, undefined);
  assert.equal(child.killed, true);
});

test("factory MCP probe stops collecting stdout and destroys the stream after its cap", async () => {
  const child = fakeHelper();
  let destroyed = 0;
  child.stdout.destroy = () => { destroyed += 1; };
  const result = mcpPackageVersion({ deadlineAt: Date.now() + 1_000, resolveCommand: async () => ({ command: "mcp", args: [] }), spawnProcess: (() => child) as never });
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.stdout.emit("data", "x".repeat(65_537));
  assert.equal(await result, undefined);
  child.stdout.emit("data", "still-not-collected");
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(destroyed, 1);
  assert.equal(child.killed, true);
});

test("factory MCP probe treats an immediate exit as unavailable", async () => {
  const child = fakeHelper();
  const result = mcpPackageVersion({ deadlineAt: Date.now() + 1_000, resolveCommand: async () => ({ command: "mcp", args: [] }), spawnProcess: (() => child) as never });
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.emit("close", 1);
  assert.equal(await result, undefined);
  assert.equal(child.killed, true);
});

test("factory MCP probe treats stdin EPIPE as unavailable", async () => {
  const child = fakeHelper();
  const result = mcpPackageVersion({ deadlineAt: Date.now() + 1_000, resolveCommand: async () => ({ command: "mcp", args: [] }), spawnProcess: (() => child) as never });
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  assert.equal(await result, undefined);
  assert.equal(child.killed, true);
});

test("Windows resolver never spawns a helper after the deadline", async () => {
  let spawns = 0;
  const resolved = await resolveMcpCommandInHelper(Date.now() - 1, { spawnProcess: (() => { spawns += 1; return fakeHelper(); }) as never });
  assert.equal(resolved, undefined);
  assert.equal(spawns, 0);
});

test("Windows factory diagnostics rejects a npm cmd shim whose entrypoint leaves node_modules", async () => {
  const shim = "C:\\npm\\codex-sidecar-mcp.cmd";
  const fs = {
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    readFile: async () => [
      "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
      "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
      "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\..\\escape.js\" %*", "",
    ].join("\r\n"),
    realpath: async (path: string) => path === shim ? "C:\\npm" : "C:\\escape.js",
  };
  const resolved = await resolveMcpCommand({
    platform: "win32",
    env: { PATH: "C:\\npm", PATHEXT: ".CMD" },
    fs: fs as never,
    pathModule: win32,
  });
  assert.equal(resolved, undefined);
});

test("Windows resolver honors PATHEXT case, skips non-executable extensions, and accepts exe", async () => {
  const exe = "C:\\npm\\codex-sidecar-mcp.exe";
  const resolved = await resolveMcpCommand({ platform: "win32", env: { pAtH: "C:\\npm", pAtHeXt: ".COM;.eXe;.CMD" }, pathModule: win32, fs: {
    lstat: async (path: string) => path === exe ? { isFile: () => true, isSymbolicLink: () => false } : Promise.reject(Object.assign(new Error(), { code: "ENOENT" })),
    readFile: async () => "", realpath: async (path: string) => path,
  } as never });
  assert.deepEqual(resolved, { command: exe, args: [] });
});

test("Windows resolver rejects invalid PATHEXT, access errors, non-local paths, and reparse points", async () => {
  const normal = { isFile: () => true, isSymbolicLink: () => false };
  const rejected = async (env: NodeJS.ProcessEnv, fs: object) => assert.equal(await resolveMcpCommand({ platform: "win32", env, pathModule: win32, fs: fs as never }), undefined);
  await rejected({ PATH: "C:\\npm", PATHEXT: ".CMD;bad" }, { lstat: async () => normal, readFile: async () => "", realpath: async (p: string) => p });
  await rejected({ PATH: "C:\\npm", PATHEXT: ".CMD" }, { lstat: async () => { throw Object.assign(new Error(), { code: "EACCES" }); }, readFile: async () => "", realpath: async (p: string) => p });
  for (const path of ["npm", "\\npm", "\\\\server\\share", "\\\\?\\C:\\npm"]) await rejected({ PATH: path, PATHEXT: ".CMD" }, { lstat: async () => normal, readFile: async () => "", realpath: async (p: string) => p });
  await rejected({ PATH: "C:\\npm", PATHEXT: ".CMD" }, { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }), readFile: async () => "", realpath: async (p: string) => p });
});

test("Windows resolver rejects mixed npm shim variants and entrypoint reparse points", async () => {
  const shim = "C:\\npm\\codex-sidecar-mcp.cmd";
  const mixed = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "", "IF EXIST \"%dp0%\\node.exe\" (", " SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", " SET \"_prog=node\"", " SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "", "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\codex-sidecar-mcp\\dist\\server.js\" %*"].join("\n");
  const fs = { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }), readFile: async () => mixed, realpath: async (path: string) => path };
  assert.equal(await resolveMcpCommand({ platform: "win32", env: { PATH: "C:\\npm", PATHEXT: ".CMD" }, pathModule: win32, fs: fs as never }), undefined);
});

test("async work CLI uses project-root plus idempotency key for start, result, cancel, and inspection", async (t) => {
  const root = await workFixture(t);
  const start = await runCli(root.home, root.cache, [
    "work-start", "--project-root", root.repo, "--idempotency-key", key, "--dry-run",
  ]);
  assert.equal(start.code, 0, start.stdout);
  const started = JSON.parse(start.stdout) as { kind: string; runId: string; state: string; result: { status: string } };
  assert.equal(started.kind, "run_terminal");
  assert.equal(started.state, "completed");
  assert.equal(started.result.status, "dry-run");

  await writeFile(join(root.repo, ".codex-sidecar.yml"), "invalid: [\n");
  const retryAfterConfigDrift = await runCli(root.home, root.cache, [
    "work-start", "--project-root", root.repo, "--idempotency-key", key, "--dry-run",
  ]);
  assert.equal(retryAfterConfigDrift.code, 0, retryAfterConfigDrift.stdout);
  assert.equal((JSON.parse(retryAfterConfigDrift.stdout) as { runId: string }).runId, started.runId);

  const result = await runCli(root.home, root.cache, ["work-result", "--project-root", root.repo, "--idempotency-key", key]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal((JSON.parse(result.stdout) as { kind: string; runId: string }).kind, "run_terminal");
  assert.equal((JSON.parse(result.stdout) as { runId: string }).runId, started.runId);

  const cancel = await runCli(root.home, root.cache, ["work-cancel", "--project-root", root.repo, "--idempotency-key", key]);
  assert.equal(cancel.code, 0, cancel.stdout);
  assert.deepEqual(JSON.parse(cancel.stdout), {
    kind: "run_cancel_ack",
    runId: started.runId,
    accepted: false,
    terminal: true,
    state: "already_terminal",
    mode: "terminal",
    pollAfterMs: 250,
  });

  const inspection = await runCli(root.home, root.cache, ["work-recover", "--project-root", root.repo, "--idempotency-key", key]);
  assert.equal(inspection.code, 0, inspection.stdout);
  const recovered = JSON.parse(inspection.stdout) as { kind: string; outcome: string; status: { kind: string } };
  assert.equal(recovered.kind, "work_recovery_inspection");
  assert.equal(recovered.outcome, "inspection");
  assert.equal(recovered.status.kind, "run_terminal");
});

test("async work CLI maps durable lookup errors to a non-zero exit", async (t) => {
  const root = await workFixture(t);
  const missing = await runCli(root.home, root.cache, [
    "work-result", "--project-root", root.repo, "--idempotency-key", "BBBBBBBBBBBBBBBBBBBBBB",
  ]);
  assert.equal(missing.code, 1, missing.stdout);
  const payload = JSON.parse(missing.stdout) as { kind: string; error: { code: string } };
  assert.equal(payload.kind, "run_error");
  assert.equal(payload.error.code, "RUN_NOT_FOUND");
});

test("work recovery confirmation and all four work auth strategies use the shared parser", async (t) => {
  const root = await workFixture(t);
  const unconfirmed = await runCli(root.home, root.cache, [
    "work-recover", "--project-root", root.repo, "--idempotency-key", key, "--action", "quarantine",
  ]);
  assert.equal(unconfirmed.code, 1);
  assert.equal((JSON.parse(unconfirmed.stdout) as { kind: string; error: { code: string } }).kind, "run_error");
  assert.equal((JSON.parse(unconfirmed.stdout) as { error: { code: string } }).error.code, "RUN_INVALID_INPUT");

  const started = await runCli(root.home, root.cache, [
    "work-start", "--project-root", root.repo, "--idempotency-key", key, "--dry-run",
  ]);
  assert.equal(started.code, 0, started.stdout);

  for (const strategy of ["write-back-run-local", "keep-canonical-after-login", "release-never-started", "release-clean"]) {
    const outcome = await runCli(root.home, root.cache, [
      "work-auth-recover", "--project-root", root.repo, "--idempotency-key", key,
      "--strategy", strategy, "--confirm-no-running-processes",
    ]);
    assert.equal(outcome.code, 1, `${strategy}: ${outcome.stdout}`);
    assert.equal((JSON.parse(outcome.stdout) as { kind: string; error: { code: string } }).kind, "run_error");
    assert.equal((JSON.parse(outcome.stdout) as { error: { code: string } }).error.code, "RUN_AUTH_UNCERTAIN");
  }
});

async function fixture(t: test.TestContext): Promise<{ root: string; home: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); const cache = join(root, "cache");
  await mkdir(home, { mode: 0o700 }); await chmod(home, 0o700);
  await writeFile(join(home, "auth.json"), '{"refresh":"R0"}\n', { mode: 0o600 });
  return { root, home, cache };
}

async function workFixture(t: test.TestContext): Promise<{ root: string; home: string; cache: string; repo: string }> {
  const root = await fixture(t);
  const repo = join(root.root, "repo");
  await mkdir(repo, { mode: 0o700 });
  await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "initial\n");
  await writeFile(join(repo, ".codex-sidecar.yml"), "project: cli-test\nallowed_paths:\n  - README.md\n");
  await exec("git", ["add", "README.md", ".codex-sidecar.yml"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  return { ...root, repo };
}

async function runCli(home: string, cache: string, args: string[], env: NodeJS.ProcessEnv = {}, stdoutReadDelayMs = 0): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entrypoint = new URL("./index.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: { ...process.env, ...env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), CODEX_HOME: home, XDG_CACHE_HOME: cache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("error", reject);
    child.once("close", resolve);
  });
  if (stdoutReadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, stdoutReadDelayMs));
  child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await completion;
  return { code, stdout, stderr };
}

async function runCliWithBrokenPipe(home: string, cache: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entrypoint = new URL("./index.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: { ...process.env, ...env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), CODEX_HOME: home, XDG_CACHE_HOME: cache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.once("data", (chunk: string) => { stdout += chunk; child.stdout.destroy(); });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.stdout.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}
