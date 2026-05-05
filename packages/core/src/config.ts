import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { WORKFLOWS, type ResultFormat, type SafetyProfileName, type SidecarConfig, type SidecarPreset } from "./types.js";

export const CONFIG_FILE = ".codex-sidecar.yml";

const SAFETY_PROFILES = new Set<SafetyProfileName>([
  "generic",
  "mcp-oauth-service",
  "claude-hook-package",
  "markdown-memory-repo",
  "python-mcp-service",
  "node-mcp-service",
  "dockerized-public-endpoint",
]);

const RESULT_FORMATS = new Set<ResultFormat>(["json", "json-with-prose"]);

export async function loadSidecarConfig(projectRoot: string, configFile = CONFIG_FILE): Promise<SidecarConfig> {
  const configPath = join(projectRoot, configFile);

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`CONFIG_NOT_FOUND: unable to read ${configPath}: ${errorMessage(error)}`);
  }

  const parsed = YAML.parse(source) as unknown;
  return assertSidecarConfig(parsed, configPath);
}

export function assertSidecarConfig(value: unknown, source = CONFIG_FILE): SidecarConfig {
  if (!isRecord(value)) {
    throw new Error(`CONFIG_INVALID: ${source} must contain a YAML object`);
  }

  const errors: string[] = [];

  if (typeof value.project !== "string" || value.project.trim().length === 0) {
    errors.push("project must be a non-empty string");
  }

  if ("allowed_paths" in value && !isStringArray(value.allowed_paths)) {
    errors.push("allowed_paths must be a string array");
  }

  if ("deny_paths" in value && !isStringArray(value.deny_paths)) {
    errors.push("deny_paths must be a string array");
  }

  if ("safety_profile" in value && !isSafetyProfile(value.safety_profile)) {
    errors.push(`safety_profile must be one of: ${[...SAFETY_PROFILES].join(", ")}`);
  }

  if ("defaults" in value) {
    validateDefaults(value.defaults, errors);
  }

  if ("presets" in value) {
    validatePresets(value.presets, errors);
  }

  if (errors.length > 0) {
    throw new Error(`CONFIG_INVALID: ${source}: ${errors.join("; ")}`);
  }

  return value as unknown as SidecarConfig;
}

function validateDefaults(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("defaults must be an object");
    return;
  }

  if ("readonly" in value && typeof value.readonly !== "boolean") {
    errors.push("defaults.readonly must be a boolean");
  }

  if ("result_format" in value && !RESULT_FORMATS.has(value.result_format as ResultFormat)) {
    errors.push("defaults.result_format must be json or json-with-prose");
  }

  if ("safety_profile" in value && !isSafetyProfile(value.safety_profile)) {
    errors.push(`defaults.safety_profile must be one of: ${[...SAFETY_PROFILES].join(", ")}`);
  }
}

function validatePresets(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("presets must be an object");
    return;
  }

  for (const [name, presetValue] of Object.entries(value)) {
    if (!isRecord(presetValue)) {
      errors.push(`presets.${name} must be an object`);
      continue;
    }

    validatePreset(name, presetValue as SidecarPreset, errors);
  }
}

function validatePreset(name: string, value: SidecarPreset, errors: string[]): void {
  if ("workflow" in value && !(WORKFLOWS as readonly string[]).includes(String(value.workflow))) {
    errors.push(`presets.${name}.workflow must be one of: ${WORKFLOWS.join(", ")}`);
  }

  if ("readonly" in value && typeof value.readonly !== "boolean") {
    errors.push(`presets.${name}.readonly must be a boolean`);
  }

  if ("require_worktree" in value && typeof value.require_worktree !== "boolean") {
    errors.push(`presets.${name}.require_worktree must be a boolean`);
  }

  if ("prompt" in value && typeof value.prompt !== "string") {
    errors.push(`presets.${name}.prompt must be a string`);
  }

  if ("focus" in value && !isStringArray(value.focus)) {
    errors.push(`presets.${name}.focus must be a string array`);
  }

  if ("allowed_paths" in value && !isStringArray(value.allowed_paths)) {
    errors.push(`presets.${name}.allowed_paths must be a string array`);
  }

  if ("deny_paths" in value && !isStringArray(value.deny_paths)) {
    errors.push(`presets.${name}.deny_paths must be a string array`);
  }

  if ("safety_profile" in value && !isSafetyProfile(value.safety_profile)) {
    errors.push(`presets.${name}.safety_profile must be one of: ${[...SAFETY_PROFILES].join(", ")}`);
  }
}

function isSafetyProfile(value: unknown): value is SafetyProfileName {
  return typeof value === "string" && SAFETY_PROFILES.has(value as SafetyProfileName);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
