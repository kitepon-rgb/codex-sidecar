import { isAbsolute, posix } from "node:path";
import { minimatch } from "minimatch";

export interface PathPolicy {
  allowedPaths: string[];
  denyPaths: string[];
}

export interface PathAccess {
  allowed: boolean;
  denied: boolean;
  reason?: string;
  matchedPattern?: string;
}

export function normalizeProjectPath(input: string): string {
  const normalized = input.replaceAll("\\", "/");

  if (normalized.trim().length === 0) {
    throw new Error("path must not be empty");
  }

  if (isAbsolute(normalized)) {
    throw new Error(`absolute paths are not allowed in sidecar path policy: ${input}`);
  }

  const clean = posix.normalize(normalized);

  if (clean === "." || clean.startsWith("../") || clean === "..") {
    throw new Error(`path traversal is not allowed in sidecar path policy: ${input}`);
  }

  return clean;
}

export function evaluatePathAccess(path: string, policy: PathPolicy): PathAccess {
  const normalizedPath = normalizeProjectPath(path);
  const denyMatch = matchAny(normalizedPath, policy.denyPaths);

  if (denyMatch) {
    return {
      allowed: false,
      denied: true,
      reason: "path matched deny policy",
      matchedPattern: denyMatch,
    };
  }

  if (policy.allowedPaths.length === 0) {
    return {
      allowed: false,
      denied: false,
      reason: "no allowed_paths configured",
    };
  }

  const allowMatch = matchAny(normalizedPath, policy.allowedPaths);

  if (!allowMatch) {
    return {
      allowed: false,
      denied: false,
      reason: "path did not match allowed_paths",
    };
  }

  return {
    allowed: true,
    denied: false,
    matchedPattern: allowMatch,
  };
}

export function assertPathsAllowed(paths: string[], policy: PathPolicy): void {
  const refusals = paths
    .map((path) => ({ path, access: evaluatePathAccess(path, policy) }))
    .filter(({ access }) => !access.allowed);

  if (refusals.length > 0) {
    const details = refusals
      .map(({ path, access }) => `${path}: ${access.reason ?? "not allowed"}`)
      .join("; ");
    throw new Error(`SAFETY_REFUSAL: path policy refused access: ${details}`);
  }
}

export function normalizePolicyPatterns(patterns: string[]): string[] {
  return patterns.map((pattern) => normalizePattern(pattern));
}

function matchAny(path: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => matchesPattern(path, pattern));
}

function matchesPattern(path: string, pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  const candidates = expandPattern(normalized);

  return candidates.some((candidate) =>
    minimatch(path, candidate, {
      dot: true,
      nocase: false,
      windowsPathsNoEscape: true,
    }),
  );
}

function normalizePattern(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\/+/, "");

  if (normalized.trim().length === 0) {
    throw new Error("path policy patterns must not be empty");
  }

  if (isAbsolute(normalized)) {
    throw new Error(`absolute path policy patterns are not allowed: ${pattern}`);
  }

  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`path traversal is not allowed in path policy patterns: ${pattern}`);
  }

  return normalized;
}

function expandPattern(pattern: string): string[] {
  if (pattern.endsWith("/")) {
    return [pattern.slice(0, -1), `${pattern}**`];
  }

  if (!hasGlob(pattern)) {
    return [pattern, `${pattern}/**`];
  }

  return [pattern];
}

function hasGlob(pattern: string): boolean {
  return /[*?[\]{}()!+@]/.test(pattern);
}
