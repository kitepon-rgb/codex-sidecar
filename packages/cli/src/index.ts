#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { cwd, exit } from "node:process";
import { inspectNativeFactoryReadiness, nativeFactoryDiagnosticFailure } from "./diagnostics.js";
import {
  CONFIG_FILE,
  SIDECAR_RUN_ERROR_CODES,
  WorkAuthRecoveryStrategy,
  WORKFLOWS,
  buildEcosystemContextBlocks,
  cancelWorkRun,
  getWorkRunResult,
  inspectWorkAuthRecovery,
  inspectWorkRecovery,
  buildSidecarRequest,
  loadSidecarConfig,
  modelPolicyInfo,
  recoverWorkAuthSession,
  recoverWorkRun,
  runSidecarRequest,
  startWorkRun,
  inspectCurrentDurableAuthRecovery,
  recoverSyncDurableAuthSession,
  toSidecarError,
  acknowledgeSidecarRuntimeErrors,
  compactSidecarRuntimeErrors,
  readSidecarRuntimeErrors,
  reopenSidecarRuntimeError,
  resolveSidecarRuntimeError,
  type AuthRecoveryStrategy,
  type ModelReasoningEffort,
  type SidecarRunErrorCode,
  type SidecarContextBlock,
  type SidecarWorkflow,
} from "codex-sidecar-core";

interface CliOptions {
  workflow?: CliCommand;
  projectRoot: string;
  configFile: string;
  preset?: string;
  prompt?: string;
  outputContract?: string;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  json: boolean;
  dryRun: boolean;
  turnTimeoutMs?: number;
  interruptOnTimeout: boolean;
  preserveWorktree: boolean;
  context: SidecarContextBlock[];
  sessionId?: string;
  authRecoveryStrategy?: WorkAuthRecoveryStrategy;
  confirmNoRunningProcesses: boolean;
  idempotencyKey?: string;
  baseRef?: string;
  workRecoveryAction?: "quarantine";
  factoryErrorAction?: "snapshot" | "ack" | "resolve" | "reopen" | "compact";
  factoryErrorCursor?: number;
  factoryErrorFingerprint?: string;
}

type CliCommand =
  | SidecarWorkflow
  | "diagnostics"
  | "factory-diagnostics"
  | "factory-errors"
  | "auth-status"
  | "auth-recover"
  | "work-start"
  | "work-result"
  | "work-cancel"
  | "work-recover"
  | "work-auth-recover";

if (process.argv.length === 3 && process.argv[2] === "--version") {
  try {
    process.stdout.write(`${readCliVersion()}\n`);
    exit(0);
  } catch (error) {
    await writeJsonAndSetExit({ status: "failed", error: error instanceof Error ? error.message : String(error) }, 1);
  }
}

async function main(): Promise<void> {
  let parsed!: CliOptions;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  await writeJsonAndSetExit({
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  }, 1);
  return;
}

if (!parsed.workflow) {
  printUsage();
  exit(1);
}

try {
  if (parsed.workflow === "auth-status") {
    await writeJsonAndSetExit(await inspectCurrentDurableAuthRecovery(), 0);
    return;
  }

  if (parsed.workflow === "auth-recover") {
    if (!parsed.sessionId) throw new Error("--session-id is required for auth-recover");
    if (!parsed.authRecoveryStrategy) throw new Error("--strategy is required for auth-recover");
    if (!parsed.confirmNoRunningProcesses) throw new Error("--confirm-no-running-processes is required for auth-recover");
    await recoverSyncDurableAuthSession({
      sessionId: parsed.sessionId,
      strategy: parsed.authRecoveryStrategy as AuthRecoveryStrategy,
      confirmNoRunningProcesses: true,
    });
    await writeJsonAndSetExit({ status: "ok", sessionId: parsed.sessionId, strategy: parsed.authRecoveryStrategy }, 0);
    return;
  }

  if (parsed.workflow === "work-result") {
    const result = await getWorkRunResult(workLookup(parsed));
    await writeJsonAndSetExit(result, runExitCode(result));
    return;
  }

  if (parsed.workflow === "work-cancel") {
    const result = await cancelWorkRun(workLookup(parsed));
    await writeJsonAndSetExit(result, runExitCode(result));
    return;
  }

  if (parsed.workflow === "work-recover") {
    const lookup = workLookup(parsed);
    if (parsed.workRecoveryAction === "quarantine" && !parsed.confirmNoRunningProcesses) {
      throw new Error("--confirm-no-running-processes is required for work-recover --action quarantine");
    }
    const result = parsed.workRecoveryAction === "quarantine"
      ? await recoverWorkRun({ ...lookup, action: "quarantine", confirmNoRunningProcesses: true })
      : await inspectWorkRecovery(lookup);
    await writeJsonAndSetExit(result, runExitCode(result.status));
    return;
  }

  if (parsed.workflow === "work-auth-recover") {
    const lookup = workLookup(parsed);
    if (parsed.authRecoveryStrategy === undefined) {
      if (parsed.confirmNoRunningProcesses) throw new Error("--strategy is required when --confirm-no-running-processes is set");
      await writeJsonAndSetExit(await inspectWorkAuthRecovery(lookup), 0); return;
    }
    if (!parsed.confirmNoRunningProcesses) throw new Error("--confirm-no-running-processes is required for work-auth-recover");
    await writeJsonAndSetExit(await recoverWorkAuthSession({
      ...lookup,
      strategy: parsed.authRecoveryStrategy as WorkAuthRecoveryStrategy,
      confirmNoRunningProcesses: true,
    }), 0); return;
  }

  if (parsed.workflow === "factory-errors") {
    const action = parsed.factoryErrorAction ?? "snapshot";
    if (action === "snapshot") {
      await writeJsonAndSetExit({ status: "ok", factoryRuntimeErrors: await readSidecarRuntimeErrors() }, 0); return;
    } else if (action === "ack") {
      if (parsed.factoryErrorCursor === undefined) throw new Error("--cursor is required for factory-errors --action ack");
      await acknowledgeSidecarRuntimeErrors(parsed.factoryErrorCursor);
      await writeJsonAndSetExit({ status: "ok", action, cursor: parsed.factoryErrorCursor }, 0); return;
    } else if (action === "resolve") {
      if (!parsed.factoryErrorFingerprint) throw new Error("--fingerprint is required for factory-errors --action resolve");
      await writeJsonAndSetExit({ status: "ok", action, resolved: await resolveSidecarRuntimeError(parsed.factoryErrorFingerprint) }, 0); return;
    } else if (action === "reopen") {
      if (!parsed.factoryErrorFingerprint) throw new Error("--fingerprint is required for factory-errors --action reopen");
      await writeJsonAndSetExit({ status: "ok", action, reopened: await reopenSidecarRuntimeError(parsed.factoryErrorFingerprint) }, 0); return;
    } else {
      await writeJsonAndSetExit({ status: "ok", action, removed: await compactSidecarRuntimeErrors() }, 0); return;
    }
  }

  if (parsed.workflow === "work-start") {
    const result = await startWorkRun(
      () => loadSidecarConfig(parsed.projectRoot, parsed.configFile),
      {
        projectRoot: parsed.projectRoot,
        idempotencyKey: requiredIdempotencyKey(parsed),
        baseRef: parsed.baseRef,
        prompt: parsed.prompt,
        preset: parsed.preset,
        outputContract: parsed.outputContract,
        model: parsed.model,
        modelReasoningEffort: parsed.modelReasoningEffort,
        turnTimeoutMs: parsed.turnTimeoutMs,
        interruptOnTimeout: parsed.interruptOnTimeout,
        preserveWorktree: parsed.preserveWorktree,
        context: parsed.context,
        dryRun: parsed.dryRun,
      },
    );
    await writeJsonAndSetExit(result, runExitCode(result)); return;
  }

  const config = await loadSidecarConfig(parsed.projectRoot, parsed.configFile);
  const resolvedPreset =
    parsed.preset ??
    (isSidecarWorkflow(parsed.workflow) && config.presets?.[parsed.workflow]
      ? parsed.workflow
      : undefined);

  if (parsed.workflow === "diagnostics") {
    const request = buildSidecarRequest(config, {
      workflow: "review",
      projectRoot: parsed.projectRoot,
      preset: resolvedPreset,
      prompt: parsed.prompt,
      model: parsed.model,
      modelReasoningEffort: parsed.modelReasoningEffort,
      turnTimeoutMs: parsed.turnTimeoutMs,
      interruptOnTimeout: parsed.interruptOnTimeout,
      preserveWorktree: parsed.preserveWorktree,
      context: parsed.context,
      dryRun: true,
    });

    await writeJsonAndSetExit({
      status: "ok",
      configFile: parsed.configFile,
      projectRoot: parsed.projectRoot,
      normalizedRequest: request,
      modelPolicy: modelPolicyInfo(request),
    }, 0); return;
  }

  if (parsed.workflow === "factory-diagnostics") {
    const factoryReadiness = await inspectNativeFactoryReadiness(config, {
      projectRoot: parsed.projectRoot,
      preset: resolvedPreset,
      model: parsed.model,
      modelReasoningEffort: parsed.modelReasoningEffort,
      turnTimeoutMs: parsed.turnTimeoutMs,
      interruptOnTimeout: parsed.interruptOnTimeout,
      preserveWorktree: parsed.preserveWorktree,
    });
    await writeJsonAndSetExit({ status: factoryReadiness.overall === "ready" ? "ok" : "failed", factoryReadiness }, factoryReadiness.overall === "ready" ? 0 : 1); return;
  }
  if (!isSidecarWorkflow(parsed.workflow)) throw new Error(`Unknown command: ${parsed.workflow}`);
  const result = await runSidecarRequest(config, {
    workflow: parsed.workflow,
    projectRoot: parsed.projectRoot,
    preset: resolvedPreset,
    prompt: parsed.prompt,
    outputContract: parsed.outputContract,
    model: parsed.model,
    modelReasoningEffort: parsed.modelReasoningEffort,
    turnTimeoutMs: parsed.turnTimeoutMs,
    interruptOnTimeout: parsed.interruptOnTimeout,
    preserveWorktree: parsed.preserveWorktree,
    context: parsed.context,
    dryRun: parsed.dryRun,
  });

  await writeJsonAndSetExit(result, result.status === "failed" || result.status === "refused" ? 1 : 0); return;
} catch (error) {
  if (parsed.workflow === "factory-errors") {
    await writeJsonAndSetExit({ status: "failed", errorCode: "FACTORY_RUNTIME_ERROR_STORE_UNAVAILABLE" }, 1); return;
  }
  if (parsed.workflow === "factory-diagnostics") {
    await writeJsonAndSetExit({
      status: "failed",
      factoryReadiness: nativeFactoryDiagnosticFailure(),
      errorCode: toSidecarError(error).code,
    }, 1); return;
  }
  if (parsed.workflow && isAsyncWorkCommand(parsed.workflow)) {
    const result = runOperationError(error);
    await writeJsonAndSetExit(result, runExitCode(result)); return;
  }
  await writeJsonAndSetExit({
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  }, 1); return;
}
}

if (!(process.argv.length === 3 && process.argv[2] === "--version")) await main();

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    projectRoot: cwd(),
    configFile: CONFIG_FILE,
    json: true,
    dryRun: false,
    interruptOnTimeout: true,
    preserveWorktree: true,
    context: [],
    confirmNoRunningProcesses: false,
  };
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (index === 0 && isCommand(arg)) {
      options.workflow = arg;
      continue;
    }

    if (arg === "--project" || arg === "--project-root") {
      options.projectRoot = requireValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--config") {
      options.configFile = requireValue(args, (index += 1), "--config");
      continue;
    }

    if (arg === "--preset") {
      options.preset = requireValue(args, (index += 1), "--preset");
      continue;
    }

    if (arg === "--output-contract") {
      options.outputContract = requireValue(args, (index += 1), "--output-contract");
      continue;
    }

    if (arg === "--output-contract-file") {
      options.outputContract = readFileSync(requireValue(args, (index += 1), "--output-contract-file"), "utf8");
      continue;
    }

    if (arg === "--model") {
      options.model = requireValue(args, (index += 1), "--model");
      continue;
    }

    if (arg === "--model-reasoning-effort") {
      options.modelReasoningEffort = parseModelReasoningEffort(
        requireValue(args, (index += 1), "--model-reasoning-effort"),
        "--model-reasoning-effort",
      );
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--turn-timeout-ms") {
      options.turnTimeoutMs = parsePositiveInteger(requireValue(args, (index += 1), "--turn-timeout-ms"), "--turn-timeout-ms");
      continue;
    }

    if (arg === "--no-interrupt-on-timeout") {
      options.interruptOnTimeout = false;
      continue;
    }

    if (arg === "--remove-worktree") {
      options.preserveWorktree = false;
      continue;
    }

    if (arg === "--context-file") {
      options.context.push(...readContextFile(requireValue(args, (index += 1), "--context-file")));
      continue;
    }

    if (arg === "--session-id") {
      options.sessionId = requireValue(args, (index += 1), "--session-id");
      continue;
    }

    if (arg === "--idempotency-key") {
      options.idempotencyKey = requireValue(args, (index += 1), "--idempotency-key");
      continue;
    }

    if (arg === "--base-ref") {
      options.baseRef = requireValue(args, (index += 1), "--base-ref");
      continue;
    }

    if (arg === "--action") {
      const action = requireValue(args, (index += 1), "--action");
      if (options.workflow === "factory-errors") {
        if (action !== "snapshot" && action !== "ack" && action !== "resolve" && action !== "reopen" && action !== "compact") {
          throw new Error("--action must be snapshot, ack, resolve, reopen, or compact for factory-errors");
        }
        options.factoryErrorAction = action;
      } else {
        if (action !== "quarantine") throw new Error("--action must be quarantine");
        options.workRecoveryAction = action;
      }
      continue;
    }

    if (arg === "--cursor") {
      options.factoryErrorCursor = parseNonNegativeInteger(requireValue(args, (index += 1), "--cursor"), "--cursor");
      continue;
    }

    if (arg === "--fingerprint") {
      const fingerprint = requireValue(args, (index += 1), "--fingerprint");
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("--fingerprint must be lowercase SHA-256");
      options.factoryErrorFingerprint = fingerprint;
      continue;
    }

    if (arg === "--strategy") {
      options.authRecoveryStrategy = parseAuthRecoveryStrategy(
        requireValue(args, (index += 1), "--strategy"),
      );
      continue;
    }

    if (arg === "--confirm-no-running-processes") {
      options.confirmNoRunningProcesses = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    promptParts.push(arg);
  }

  options.prompt = promptParts.length > 0 ? promptParts.join(" ") : undefined;
  return options;
}

function readCliVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
  if (!isRecord(manifest) || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("CLI package manifest has an invalid version");
  }
  return manifest.version;
}

function isCommand(value: string): value is CliCommand {
  return value === "diagnostics" || value === "factory-diagnostics" || value === "factory-errors" || value === "auth-status" || value === "auth-recover" ||
    value === "work-start" || value === "work-result" || value === "work-cancel" ||
    value === "work-recover" || value === "work-auth-recover" ||
    (WORKFLOWS as readonly string[]).includes(value);
}

function isSidecarWorkflow(value: CliCommand): value is SidecarWorkflow {
  return (WORKFLOWS as readonly string[]).includes(value);
}

function isAsyncWorkCommand(value: CliCommand): value is "work-start" | "work-result" | "work-cancel" | "work-recover" | "work-auth-recover" {
  return value === "work-start" || value === "work-result" || value === "work-cancel" || value === "work-recover" || value === "work-auth-recover";
}

function requiredIdempotencyKey(options: CliOptions): string {
  if (!options.idempotencyKey) throw new Error("--idempotency-key is required");
  return options.idempotencyKey;
}

function workLookup(options: CliOptions): { projectRoot: string; idempotencyKey: string } {
  return { projectRoot: options.projectRoot, idempotencyKey: requiredIdempotencyKey(options) };
}

function runOperationError(error: unknown) {
  const sidecar = toSidecarError(error);
  const code = (SIDECAR_RUN_ERROR_CODES as readonly string[]).includes(sidecar.code)
    ? sidecar.code as SidecarRunErrorCode
    : sidecar.code === "CONFIG_INVALID" || sidecar.code === "CONFIG_NOT_FOUND" || sidecar.code === "PRESET_NOT_FOUND" || sidecar.code === "SAFETY_REFUSAL" || sidecar.message.startsWith("--")
      ? "RUN_INVALID_INPUT"
      : "RUN_INTERNAL_ERROR";
  return {
    kind: "run_error" as const,
    error: { code, message: sidecar.message },
    retryable: code !== "RUN_INVALID_INPUT" && code !== "RUN_KEY_CONFLICT" && code !== "RUN_UNSUPPORTED_PLATFORM",
  };
}

function runExitCode(value: unknown): number {
  if (!value || typeof value !== "object" || !("kind" in value)) return 1;
  const run = value as { kind: string; state?: string; result?: { status?: string }; error?: { code?: string } };
  if (run.kind === "run_error") return run.error?.code === "RUN_UNSUPPORTED_PLATFORM" ? 2 : 1;
  if (run.kind === "run_interrupted") return 1;
  if (run.kind === "run_terminal") return run.state === "failed" ? 1 : 0;
  return 0;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }

  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative safe integer`);
  return parsed;
}

function parseModelReasoningEffort(value: string, option: string): ModelReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }

  throw new Error(`${option} must be one of: low, medium, high, xhigh`);
}

function parseAuthRecoveryStrategy(value: string): WorkAuthRecoveryStrategy {
  if ((Object.values(WorkAuthRecoveryStrategy) as string[]).includes(value)) {
    return value as WorkAuthRecoveryStrategy;
  }
  throw new Error(`--strategy must be one of: ${Object.values(WorkAuthRecoveryStrategy).join(", ")}`);
}

function printUsage(): void {
  console.error(`Usage: codex-sidecar <${WORKFLOWS.join("|")}|diagnostics|factory-diagnostics|factory-errors|auth-status|auth-recover|work-start|work-result|work-cancel|work-recover|work-auth-recover> [options] [prompt]`);
  console.error("Options: --project <dir> | --project-root <dir> --config <file> --preset <name> --output-contract <text> --output-contract-file <file> --model <model> --model-reasoning-effort <effort> --context-file <json> --dry-run --json --turn-timeout-ms <ms> --no-interrupt-on-timeout --remove-worktree");
  console.error("Async work: work-start --idempotency-key <key> [--base-ref <ref>]; work-result|work-cancel|work-recover|work-auth-recover --idempotency-key <key>");
  console.error("Work recovery: work-recover [--action quarantine --confirm-no-running-processes]");
  console.error("Work auth recovery: work-auth-recover [--strategy <strategy> --confirm-no-running-processes]");
  console.error("Auth recovery: auth-recover --session-id <id> --strategy <write-back-run-local|keep-canonical-after-login|release-never-started|release-clean> --confirm-no-running-processes");
  console.error("Factory errors: factory-errors [--action snapshot|ack|resolve|reopen|compact] [--cursor <n>] [--fingerprint <sha256>]");
}

async function writeJsonAndSetExit(value: unknown, code: number): Promise<void> {
  const writeFailed = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(failed);
    };
    const onError = () => finish(true);
    process.stdout.once("error", onError);
    try {
      process.stdout.end(`${JSON.stringify(value, null, 2)}\n`, () => finish(false));
    } catch {
      finish(true);
    }
  });
  process.exitCode = writeFailed ? 1 : code;
}

function readContextFile(path: string): SidecarContextBlock[] {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const context = isRecord(parsed) && Array.isArray(parsed.context) ? parsed.context : parsed;

  if (!Array.isArray(context)) {
    throw new Error("CONFIG_INVALID: --context-file must contain an array or an object with a context array");
  }

  return buildEcosystemContextBlocks(context as Parameters<typeof buildEcosystemContextBlocks>[0]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
