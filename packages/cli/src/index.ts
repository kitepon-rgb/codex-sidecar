#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { cwd, exit } from "node:process";
import {
  CONFIG_FILE,
  WORKFLOWS,
  buildEcosystemContextBlocks,
  buildSidecarRequest,
  loadSidecarConfig,
  modelPolicyInfo,
  runSidecarRequest,
  type ModelReasoningEffort,
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
}

type CliCommand = SidecarWorkflow | "diagnostics";

const parsed = parseArgs(process.argv.slice(2));

if (!parsed.workflow) {
  printUsage();
  exit(1);
}

try {
  const config = await loadSidecarConfig(parsed.projectRoot, parsed.configFile);
  const resolvedPreset =
    parsed.preset ??
    (parsed.workflow && parsed.workflow !== "diagnostics" && config.presets?.[parsed.workflow] ? parsed.workflow : undefined);

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

    printJson({
      status: "ok",
      configFile: parsed.configFile,
      projectRoot: parsed.projectRoot,
      normalizedRequest: request,
      modelPolicy: modelPolicyInfo(request),
    });
    exit(0);
  }

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

  printJson(result);
  exit(result.status === "failed" || result.status === "refused" ? 1 : 0);
} catch (error) {
  printJson({
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
  exit(1);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    projectRoot: cwd(),
    configFile: CONFIG_FILE,
    json: true,
    dryRun: false,
    interruptOnTimeout: true,
    preserveWorktree: true,
    context: [],
  };
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (index === 0 && isCommand(arg)) {
      options.workflow = arg;
      continue;
    }

    if (arg === "--project") {
      options.projectRoot = requireValue(args, (index += 1), "--project");
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

function isCommand(value: string): value is CliCommand {
  return value === "diagnostics" || (WORKFLOWS as readonly string[]).includes(value);
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

function parseModelReasoningEffort(value: string, option: string): ModelReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }

  throw new Error(`${option} must be one of: low, medium, high, xhigh`);
}

function printUsage(): void {
  console.error(`Usage: codex-sidecar <${WORKFLOWS.join("|")}|diagnostics> [options] [prompt]`);
  console.error("Options: --project <dir> --config <file> --preset <name> --output-contract <text> --output-contract-file <file> --model <model> --model-reasoning-effort <effort> --context-file <json> --dry-run --json --turn-timeout-ms <ms> --no-interrupt-on-timeout --remove-worktree");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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
