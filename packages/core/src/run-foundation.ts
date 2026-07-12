import { createHash } from "node:crypto";

export class RunStoreError extends Error {
  constructor(
    readonly code: "RUN_KEY_CONFLICT" | "RUN_STORE_CORRUPT" | "RUN_INVALID_INPUT" | "RUN_INTERNAL_ERROR",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RunStoreError";
  }
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RunStoreError("RUN_INVALID_INPUT", "raw input must be JSON-serializable");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new RunStoreError("RUN_INVALID_INPUT", "raw input must be JSON-serializable");
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
