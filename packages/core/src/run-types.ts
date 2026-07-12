import type { RequestInput } from "./presets.js";
import type { SidecarRequest } from "./types.js";
import type { ProcessIdentity } from "./process-identity.js";

/**
 * The caller-controlled part of a work start request.  It deliberately does
 * not include projectRoot, baseRef, or idempotencyKey: those are stored by the
 * run API in their canonical forms.
 */
export type WorkStartRawInput = Omit<RequestInput, "projectRoot" | "workflow"> & {
  workflow?: "work";
};

/** Caller-reproducible request material persisted by the run store. */
export interface RunStartInput {
  projectRoot: string;
  idempotencyKey: string;
  /** Tool/CLI arguments excluding idempotencyKey. API defaults are applied by the store. */
  rawInput: WorkStartRawInput;
  /** The caller's literal base reference; absent means the API default, HEAD. */
  baseRef?: string;
}

export interface NewRunSnapshot {
  /** Config/preset-normalized execution request. It is never used for retry matching. */
  normalizedRequest: SidecarRequest;
}

export interface SidecarRunManifest {
  version: 1;
  runId: string;
  createdAt: string;
  projectStoreIdentity: string;
  callerWorktreePath: string;
  baseRef: string;
  baseCommit: string;
  objectFormat: "sha1" | "sha256";
  idempotencyKeyDigest: string;
  rawInput: Record<string, unknown>;
  rawInputDigest: string;
  normalizedRequest: SidecarRequest;
  normalizedRequestDigest: string;
  /** Digest of every preceding manifest field, excluding this field itself. */
  manifestDigest: string;
}

export interface StoredRun {
  storeRoot: string;
  runDirectory: string;
  manifest: SidecarRunManifest;
  created: boolean;
  claim: LaunchClaim;
}

export interface LaunchClaim { version: 1; kind: "claim"; generation: number; token: string; owner: ProcessIdentity; createdAt: string; digest: string; }
