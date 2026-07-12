export const WORKFLOWS = ["review", "explore", "work", "opinion", "risk-check", "auditor", "generate"] as const;

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

export type SidecarWorkflow = (typeof WORKFLOWS)[number];

export type SidecarRole = "reviewer" | "explorer" | "worker" | "critic" | "risk-analyst" | "auditor";

export type ResultFormat = "json" | "json-with-prose";

export type ModelReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type EvidenceBasis = "observed" | "inferred" | "hypothetical";

export type Severity = "critical" | "high" | "medium" | "low";

export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

export interface Confidence {
  level: ConfidenceLevel;
  rationale?: string;
}

export interface SidecarDefaults {
  role?: SidecarRole;
  readonly?: boolean;
  result_format?: ResultFormat;
  safety_profile?: SafetyProfileName;
  model?: string;
  model_reasoning_effort?: ModelReasoningEffort;
}

export interface SidecarPreset {
  workflow?: SidecarWorkflow;
  readonly?: boolean;
  require_worktree?: boolean;
  prompt?: string;
  focus?: string[];
  allowed_paths?: string[];
  deny_paths?: string[];
  safety_profile?: SafetyProfileName;
  model?: string;
  model_reasoning_effort?: ModelReasoningEffort;
}

export type SafetyProfileName =
  | "generic"
  | "mcp-oauth-service"
  | "claude-hook-package"
  | "markdown-memory-repo"
  | "python-mcp-service"
  | "node-mcp-service"
  | "dockerized-public-endpoint";

export interface SidecarConfig {
  project: string;
  defaults?: SidecarDefaults;
  safety_profile?: SafetyProfileName;
  allowed_paths?: string[];
  deny_paths?: string[];
  presets?: Record<string, SidecarPreset>;
}

export interface SidecarContextBlock {
  kind: "relay_entry" | "throughline_handoff" | "caveat_entry" | "smartclaude_cost_hint" | "codegraph_context" | "manual_note";
  source: string;
  trust: "local" | "user-provided" | "project" | "external";
  summary: string;
  references?: FileReference[];
  data?: unknown;
}

export interface FileReference {
  path: string;
  line?: number;
  label?: string;
}

export interface SidecarRequest {
  workflow: SidecarWorkflow;
  projectRoot: string;
  prompt?: string;
  preset?: string;
  /** generate workflow only: caller-supplied JSON output contract injected into the prompt. */
  outputContract?: string;
  readonly: boolean;
  requireWorktree: boolean;
  focus: string[];
  allowedPaths: string[];
  denyPaths: string[];
  safetyProfile: SafetyProfileName;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  resultFormat: ResultFormat;
  turnTimeoutMs: number;
  interruptOnTimeout: boolean;
  preserveWorktree: boolean;
  context: SidecarContextBlock[];
  dryRun: boolean;
}

export interface ModelPolicyInfo {
  source: "explicit" | "inherited";
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
}

export interface SidecarError {
  code:
    | "CONFIG_INVALID"
    | "CONFIG_NOT_FOUND"
    | "PRESET_NOT_FOUND"
    | "SAFETY_REFUSAL"
    | "APP_SERVER_UNIMPLEMENTED"
    | "APP_SERVER_TIMEOUT"
    | "APP_SERVER_CANCELLED"
    | "AUTH_LEASE_BUSY"
    | "PROTOCOL_ERROR"
    | "WORKTREE_ERROR"
    | SidecarRunErrorCode;
  message: string;
  data?: Record<string, unknown>;
}

export type SidecarRunErrorCode =
  | "RUN_NOT_FOUND"
  | "RUN_KEY_CONFLICT"
  | "RUN_STORE_CORRUPT"
  | "RUN_READY_TIMEOUT"
  | "RUN_ORPHANED"
  | "RUN_AUTH_UNCERTAIN"
  | "RUN_UNSUPPORTED_PLATFORM"
  | "RUN_INVALID_INPUT"
  | "RUN_INTERNAL_ERROR";

export const SIDECAR_RUN_ERROR_CODES = [
  "RUN_NOT_FOUND",
  "RUN_KEY_CONFLICT",
  "RUN_STORE_CORRUPT",
  "RUN_READY_TIMEOUT",
  "RUN_ORPHANED",
  "RUN_AUTH_UNCERTAIN",
  "RUN_UNSUPPORTED_PLATFORM",
  "RUN_INVALID_INPUT",
  "RUN_INTERNAL_ERROR",
] as const satisfies readonly SidecarRunErrorCode[];

export interface SidecarRunFailure extends SidecarError {
  code: SidecarRunErrorCode;
}

export interface SidecarRunHandle {
  kind: "run_handle";
  workflow: "work";
  runId: string;
  state: "starting" | "queued" | "running";
  createdAt: string;
  pollAfterMs: number;
}

export interface SidecarRunTerminal {
  kind: "run_terminal";
  runId: string;
  state: "completed" | "failed" | "cancelled";
  result: SidecarResult;
  cleanup: "not-requested" | "pending" | "completed" | "failed";
}

export interface SidecarRunInterrupted {
  kind: "run_interrupted";
  runId: string;
  state: "interrupted" | "orphaned";
  error: SidecarRunFailure;
  worktreePath?: string;
  processGroup: "stopped" | "alive" | "unknown";
  salvageAllowed: false;
  terminal: boolean;
  pollAfterMs?: number;
}

export interface SidecarRunPending {
  kind: "run_pending";
  runId: string;
  state: "starting" | "queued" | "running";
  phase: string;
  heartbeatAt?: string;
  worktreePath?: string;
  pollAfterMs: number;
}

export interface SidecarRunOperationError {
  kind: "run_error";
  runId?: string;
  error: SidecarRunFailure;
  retryable: boolean;
}

export interface SidecarRunCancelAck {
  kind: "run_cancel_ack";
  runId: string;
  accepted: boolean;
  terminal: boolean;
  state: "cancellation_requested" | "already_requested" | "already_terminal";
  mode: "pre_start_fenced" | "cooperative" | "terminal";
  pollAfterMs: number;
}

export type SidecarRunStartResult = SidecarRunHandle | SidecarRunTerminal | SidecarRunInterrupted | SidecarRunOperationError;

export type SidecarRunPollResult = SidecarRunPending | SidecarRunTerminal | SidecarRunInterrupted | SidecarRunOperationError;

export type SidecarRunCancelResult = SidecarRunCancelAck | SidecarRunOperationError;

export interface SidecarResult {
  /**
   * "partial" = the assistant turn completed and its report parsed as JSON with
   * a valid core (summary/confidence/recommendedNextAction), but one or more
   * workflow-specific fields failed schema validation. The run is not a failure:
   * artifacts (e.g. a work worktree) are preserved and the raw report is exposed
   * verbatim in `unvalidatedReport`. Callers must read `error` and
   * `unvalidatedReport` rather than the typed workflow fields, which are omitted
   * on "partial" to avoid presenting fabricated defaults.
   */
  status: "ok" | "partial" | "failed" | "refused" | "dry-run";
  workflow: SidecarWorkflow;
  summary: string;
  confidence: Confidence;
  recommendedNextAction: string;
  findings?: SidecarFinding[];
  risks?: SidecarRisk[];
  pass?: boolean;
  missingTools?: SidecarMissingTool[];
  openQuestions?: string[];
  missingTests?: string[];
  residualRisks?: string[];
  fileReferences?: FileReference[];
  changedFiles?: string[];
  tests?: TestRecord[];
  worktreePath?: string;
  worktreePreserved?: boolean;
  sourceBoundaries?: SourceBoundary[];
  costNotes?: CostNotes;
  recommendation?: string;
  objections?: string[];
  assumptions?: string[];
  failureModes?: string[];
  /** generate workflow only: the raw JSON value (object or array) Codex returned. */
  generated?: unknown;
  /**
   * Lossless coercions applied while parsing the assistant report (e.g. a bare
   * confidence level string promoted to `{ level }`, or a string `affectedFiles`
   * element promoted to `{ path }`). Present whenever any normalization ran, on
   * both "ok" and "partial" results. Empty/undefined means the report matched the
   * schema verbatim.
   */
  normalizationNotes?: string[];
  /**
   * Only on `status: "partial"`. The raw parsed JSON object the assistant
   * returned, verbatim. Exposed so callers can recover the model's own report
   * (including fields the sidecar refused to coerce, like a free-text `basis` or
   * a synonym `severity`) without the sidecar inventing typed values.
   */
  unvalidatedReport?: unknown;
  rawEventLogRef?: string;
  normalizedRequest?: SidecarRequest;
  modelPolicy?: ModelPolicyInfo;
  error?: SidecarError;
}

export interface SidecarFinding {
  severity: Severity;
  title: string;
  detail: string;
  evidence?: string;
  file?: string;
  line?: number;
  confidence: Confidence;
  basis: EvidenceBasis;
}

export interface SidecarRisk {
  severity: Severity;
  title: string;
  detail: string;
  affectedFiles: FileReference[];
  suggestedVerification?: string;
  confidence: Confidence;
  basis: EvidenceBasis;
}

export interface SidecarMissingTool {
  name: string;
  reason: string;
}

export interface SourceBoundary {
  label: string;
  source: string;
  trust: "official" | "unofficial" | "local" | "generated" | "inferred" | "unknown";
  notes?: string;
}

export interface TestRecord {
  command: string;
  status: "passed" | "failed" | "not-run";
  summary?: string;
}

export interface CostNotes {
  shouldCallCodex?: boolean;
  rationale?: string;
  estimatedInputTokens?: number;
}

export interface WorktreePlan {
  projectRoot: string;
  worktreePath: string;
  baseRef: string;
  branchName?: string;
}

export interface WorktreeState extends WorktreePlan {
  changedFiles: string[];
}
