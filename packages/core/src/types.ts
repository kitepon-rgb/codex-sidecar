export const WORKFLOWS = ["review", "explore", "work", "opinion", "risk-check", "auditor"] as const;

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
    | "PROTOCOL_ERROR"
    | "WORKTREE_ERROR";
  message: string;
  data?: Record<string, unknown>;
}

export interface SidecarResult {
  status: "ok" | "failed" | "refused" | "dry-run";
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
