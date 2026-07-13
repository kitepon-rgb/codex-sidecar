import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolveMcpCommandInHelper } from "./windows-command-resolver.js";
import {
  WORKFLOWS,
  buildSidecarRequest,
  modelPolicyInfo,
  runSidecarRequest,
  inspectSidecarRuntimeErrorStore,
  type SidecarConfig,
  type SidecarRequest,
  type SidecarResult,
  type SidecarWorkflow,
} from "codex-sidecar-core";

type ReadinessStatus = "ready" | "not_ready" | "not_applicable" | "unverified";

interface ReadinessEntry {
  status: ReadinessStatus;
  workflow?: SidecarWorkflow;
}

export interface NativeFactoryReadiness {
  schemaVersion: "1";
  overall: Exclude<ReadinessStatus, "not_applicable">;
  packageVersions: { status: ReadinessStatus; packages?: Record<"cli" | "core" | "mcp", string> };
  resultSchema: { status: ReadinessStatus };
  workflows: { status: ReadinessStatus; entries: Record<SidecarWorkflow, ReadinessEntry> };
  presets: { status: ReadinessStatus; configured: number; ready: number; notReady: number; notApplicable: number };
  modelPolicy: { status: ReadinessStatus; source?: "explicit" | "inherited"; modelConfigured?: boolean; modelReasoningEffortConfigured?: boolean };
  readOnlyDryRun: { status: ReadinessStatus; workflow?: SidecarWorkflow };
  runtimeErrorStore: { status: ReadinessStatus; collection: "enabled" | "disabled" | "unverified"; store: "ready" | "absent" | "unverified"; pending: number };
}

export async function inspectNativeFactoryReadiness(
  config: SidecarConfig,
  input: { projectRoot: string; preset?: string; model?: string; modelReasoningEffort?: SidecarRequest["modelReasoningEffort"]; turnTimeoutMs?: number; interruptOnTimeout: boolean; preserveWorktree: boolean },
): Promise<NativeFactoryReadiness> {
  const packageVersions = await inspectPackageVersions();
  const workflows = inspectWorkflows(config, input.projectRoot);
  const presets = inspectPresets(config, input.projectRoot);

  let request: SidecarRequest | undefined;
  try {
    request = buildSidecarRequest(config, {
      workflow: "review",
      projectRoot: input.projectRoot,
      preset: input.preset,
      prompt: "Native factory diagnostics dry run.",
      model: input.model,
      modelReasoningEffort: input.modelReasoningEffort,
      turnTimeoutMs: input.turnTimeoutMs,
      interruptOnTimeout: input.interruptOnTimeout,
      preserveWorktree: input.preserveWorktree,
      dryRun: true,
    });
  } catch {
    // The result and policy checks below deliberately report the failure without
    // carrying raw configuration, path, prompt, or context data into JSON.
  }

  const modelPolicy = inspectModelPolicy(request);
  const resultSchema = request ? await inspectDryRunResult(config, request) : { status: "not_ready" as const };
  const readOnlyDryRun = request && request.workflow !== "work"
    ? { status: resultSchema.status, workflow: request.workflow }
    : { status: request ? "not_applicable" as const : "not_ready" as const };

  const errorStore = await inspectSidecarRuntimeErrorStore();
  const runtimeErrorStore = {
    status: errorStore.collection === "disabled"
      ? "not_applicable" as const
      : errorStore.collection === "enabled" && errorStore.store !== "unverified"
        ? "ready" as const
        : "unverified" as const,
    ...errorStore,
  };

  const checks = [packageVersions.status, resultSchema.status, workflows.status, presets.status, modelPolicy.status, readOnlyDryRun.status, runtimeErrorStore.status];
  return {
    schemaVersion: "1",
    overall: overallStatus(checks),
    packageVersions,
    resultSchema,
    workflows,
    presets,
    modelPolicy,
    readOnlyDryRun,
    runtimeErrorStore,
  };
}

export function nativeFactoryDiagnosticFailure(): Pick<NativeFactoryReadiness, "schemaVersion" | "overall"> {
  return { schemaVersion: "1", overall: "unverified" };
}

async function inspectPackageVersions(): Promise<NativeFactoryReadiness["packageVersions"]> {
  const manifests = await Promise.all([
    packageVersion(new URL("../package.json", import.meta.url)),
    packageVersion(new URL("../package.json", import.meta.resolve("codex-sidecar-core"))),
    mcpPackageVersion(),
  ]);
  if (manifests.some((version) => version === undefined)) return { status: "unverified" };
  const [cli, core, mcp] = manifests as [string, string, string];
  const packages = { cli, core, mcp };
  return { status: cli === core && core === mcp ? "ready" : "not_ready", packages };
}

export async function mcpPackageVersion({ deadlineAt = Date.now() + 3_000, resolveCommand = resolveMcpCommandInHelper, spawnProcess = spawn }: { deadlineAt?: number; resolveCommand?: typeof resolveMcpCommandInHelper; spawnProcess?: typeof spawn } = {}): Promise<string | undefined> {
  const resolved = await resolveCommand(deadlineAt);
  if (!resolved) return undefined;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return undefined;
  return new Promise((resolve) => {
    let child; try { child = spawnProcess(resolved.command, resolved.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }); } catch { resolve(undefined); return; }
    let stdout = "";
    let settled = false;
    const onStdout = (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 65_536) finish(undefined);
    };
    const onStdinError = () => finish(undefined);
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stdout.destroy();
      child.stdin.destroy();
      if (!child.killed) child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), remaining);
    child.once("error", () => finish(undefined));
    child.stdout.once("error", () => finish(undefined));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.once("close", () => {
      if (settled) return;
      try {
        const response = stdout.trim().split("\n")
          .map((line) => JSON.parse(line) as unknown)
          .find((value) => isRecord(value) && value.id === 1);
        const result = isRecord(response) && isRecord(response.result) ? response.result : undefined;
        const serverInfo = result && isRecord(result.serverInfo) ? result.serverInfo : undefined;
        const version = serverInfo?.version;
        finish(typeof version === "string" && isSemver(version) ? version : undefined);
      } catch {
        finish(undefined);
      }
    });
    child.stdin.once("error", onStdinError);
    try { child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex-sidecar-factory-diagnostics", version: "1.0.0" },
      },
    })}\n`); } catch { finish(undefined); }
  });
}

async function packageVersion(path: URL): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(value) && typeof value.version === "string" && isSemver(value.version) ? value.version : undefined;
  } catch {
    return undefined;
  }
}

function inspectWorkflows(config: SidecarConfig, projectRoot: string): NativeFactoryReadiness["workflows"] {
  const entries = Object.fromEntries(WORKFLOWS.map((workflow) => [workflow, inspectWorkflow(config, projectRoot, workflow)])) as Record<SidecarWorkflow, ReadinessEntry>;
  return { status: entriesStatus(Object.values(entries).map((entry) => entry.status)), entries };
}

function inspectWorkflow(config: SidecarConfig, projectRoot: string, workflow: SidecarWorkflow): ReadinessEntry {
  if (workflow === "work") return { status: "not_applicable" };
  try {
    const request = buildSidecarRequest(config, {
      workflow,
      projectRoot,
      prompt: "Native factory diagnostics dry run.",
      dryRun: true,
    });
    return request.readonly ? { status: "ready" } : { status: "not_ready" };
  } catch {
    return { status: "not_ready" };
  }
}

function inspectPresets(config: SidecarConfig, projectRoot: string): NativeFactoryReadiness["presets"] {
  const statuses: ReadinessStatus[] = [];
  for (const name of Object.keys(config.presets ?? {}).sort()) {
    try {
      const request = buildSidecarRequest(config, {
        workflow: "review",
        projectRoot,
        preset: name,
        prompt: "Native factory diagnostics dry run.",
        dryRun: true,
      });
      statuses.push(request.workflow === "work"
        ? "not_applicable"
        : request.readonly ? "ready" : "not_ready");
    } catch {
      statuses.push("not_ready");
    }
  }
  return {
    status: entriesStatus(statuses),
    configured: statuses.length,
    ready: statuses.filter((status) => status === "ready").length,
    notReady: statuses.filter((status) => status === "not_ready").length,
    notApplicable: statuses.filter((status) => status === "not_applicable").length,
  };
}

function inspectModelPolicy(request: SidecarRequest | undefined): NativeFactoryReadiness["modelPolicy"] {
  if (!request) return { status: "not_ready" };
  const policy = modelPolicyInfo(request);
  return {
    status: "ready",
    source: policy.source,
    modelConfigured: policy.model !== undefined,
    modelReasoningEffortConfigured: policy.modelReasoningEffort !== undefined,
  };
}

async function inspectDryRunResult(config: SidecarConfig, request: SidecarRequest): Promise<NativeFactoryReadiness["resultSchema"]> {
  const result = await runSidecarRequest(config, { ...request, dryRun: true });
  return isDryRunResult(result, request.workflow) ? { status: "ready" } : { status: "not_ready" };
}

function isDryRunResult(result: SidecarResult, workflow: SidecarWorkflow): boolean {
  return result.status === "dry-run" && result.workflow === workflow &&
    typeof result.summary === "string" && result.summary.length > 0 &&
    typeof result.recommendedNextAction === "string" && result.recommendedNextAction.length > 0 &&
    result.confidence?.level === "unknown" && result.normalizedRequest?.dryRun === true;
}

function entriesStatus(statuses: ReadinessStatus[]): ReadinessStatus {
  return statuses.length === 0 ? "not_applicable" : overallStatus(statuses);
}

function overallStatus(statuses: ReadinessStatus[]): NativeFactoryReadiness["overall"] {
  if (statuses.includes("not_ready")) return "not_ready";
  if (statuses.includes("unverified")) return "unverified";
  return "ready";
}

function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
