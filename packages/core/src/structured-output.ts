import type {
  Confidence,
  EvidenceBasis,
  FileReference,
  Severity,
  SidecarFinding,
  SidecarMissingTool,
  SidecarRequest,
  SidecarResult,
  SidecarRisk,
  SourceBoundary,
  TestRecord,
} from "./types.js";

interface StructuredOutput {
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
  tests?: TestRecord[];
  sourceBoundaries?: SourceBoundary[];
  recommendation?: string;
  objections?: string[];
  assumptions?: string[];
  failureModes?: string[];
}

const CONFIDENCE_LEVELS = new Set(["high", "medium", "low", "unknown"]);
const SEVERITIES = new Set<Severity>(["critical", "high", "medium", "low"]);
const BASES = new Set<EvidenceBasis>(["observed", "inferred", "hypothetical"]);
const TRUST_LEVELS = new Set(["official", "unofficial", "local", "generated", "inferred", "unknown"]);

export function buildStructuredOutputPrompt(request: SidecarRequest): string {
  const taskPrompt = request.prompt?.trim() ?? "";

  return [
    "You are running as codex-sidecar. Return exactly one JSON object and no surrounding prose.",
    "The JSON object must match the stable SidecarResult structured payload described below.",
    "Do not use markdown fences. Do not include comments. Use empty arrays when there are no items.",
    "",
    "Required common fields:",
    "- summary: non-empty string",
    "- confidence: { level: \"high\" | \"medium\" | \"low\" | \"unknown\", rationale?: string }",
    "- recommendedNextAction: non-empty string",
    "- openQuestions: string[]",
    "- fileReferences: Array<{ path: string, line?: number, label?: string }>",
    "- sourceBoundaries: Array<{ label: string, source: string, trust: \"official\" | \"unofficial\" | \"local\" | \"generated\" | \"inferred\" | \"unknown\", notes?: string }>",
    "",
    workflowSchema(request.workflow),
    "",
    "Project context:",
    `- projectRoot: ${request.projectRoot}`,
    `- workflow: ${request.workflow}`,
    `- focus: ${JSON.stringify(request.focus)}`,
    `- safetyProfile: ${request.safetyProfile}`,
    contextSection(request),
    "",
    "User task:",
    taskPrompt,
  ].join("\n");
}

function contextSection(request: SidecarRequest): string {
  if (request.context.length === 0) {
    return "- context: []";
  }

  return `- context: ${JSON.stringify(request.context)}`;
}

export function parseStructuredSidecarOutput(request: SidecarRequest, assistantText: string): StructuredOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(assistantText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PROTOCOL_ERROR: assistant output was not valid JSON: ${detail}`);
  }

  const errors: string[] = [];
  const output = assertRecord(parsed, "root", errors);

  const summary = requireString(output, "summary", errors);
  const confidence = parseConfidence(output.confidence, "confidence", errors);
  const recommendedNextAction = requireString(output, "recommendedNextAction", errors);
  const structured: StructuredOutput = {
    summary,
    confidence,
    recommendedNextAction,
    openQuestions: parseStringArray(output.openQuestions, "openQuestions", errors, true),
    fileReferences: parseFileReferences(output.fileReferences, "fileReferences", errors, true),
    sourceBoundaries: parseSourceBoundaries(output.sourceBoundaries, "sourceBoundaries", errors, true),
  };

  switch (request.workflow) {
    case "review":
      structured.findings = parseFindings(output.findings, "findings", errors, true);
      structured.missingTests = parseStringArray(output.missingTests, "missingTests", errors, true);
      structured.residualRisks = parseStringArray(output.residualRisks, "residualRisks", errors, true);
      break;
    case "risk-check":
      structured.risks = parseRisks(output.risks, "risks", errors, true);
      break;
    case "auditor":
      structured.pass = parseBoolean(output.pass, "pass", errors);
      structured.missingTools = parseMissingTools(output.missingTools, "missingTools", errors, true);
      break;
    case "opinion":
      structured.recommendation = requireString(output, "recommendation", errors);
      structured.objections = parseStringArray(output.objections, "objections", errors, true);
      structured.assumptions = parseStringArray(output.assumptions, "assumptions", errors, true);
      structured.failureModes = parseStringArray(output.failureModes, "failureModes", errors, true);
      break;
    case "explore":
      break;
    case "work":
      structured.tests = parseTests(output.tests, "tests", errors, true);
      structured.risks = parseRisks(output.risks, "risks", errors, true);
      break;
    case "generate":
      // generate bypasses SidecarResult parsing; handled by buildGenerateResult.
      break;
  }

  if (errors.length > 0) {
    throw new Error(`PROTOCOL_ERROR: assistant structured output invalid: ${errors.join("; ")}`);
  }

  return structured;
}

export function mergeStructuredOutput(
  request: SidecarRequest,
  output: StructuredOutput,
  base: Pick<SidecarResult, "status" | "workflow" | "rawEventLogRef" | "normalizedRequest" | "modelPolicy">,
): SidecarResult {
  return {
    ...base,
    summary: output.summary,
    confidence: output.confidence,
    recommendedNextAction: output.recommendedNextAction,
    findings: output.findings,
    risks: output.risks,
    pass: output.pass,
    missingTools: output.missingTools,
    openQuestions: output.openQuestions,
    missingTests: output.missingTests,
    residualRisks: output.residualRisks,
    fileReferences: output.fileReferences,
    tests: output.tests,
    sourceBoundaries: [
      ...(output.sourceBoundaries ?? []),
      {
        label: "Codex App Server",
        source: "local codex app-server stdio",
        trust: "local",
      },
    ],
    recommendation: output.recommendation,
    objections: output.objections,
    assumptions: output.assumptions,
    failureModes: output.failureModes,
    workflow: request.workflow,
  };
}

function workflowSchema(workflow: SidecarRequest["workflow"]): string {
  switch (workflow) {
    case "review":
      return [
        "Review workflow fields:",
        "- findings: Array<{ severity, title, detail, evidence?: string, file?: string, line?: number, confidence, basis }>",
        "- missingTests: string[]",
        "- residualRisks: string[]",
      ].join("\n");
    case "risk-check":
      return [
        "Risk-check workflow fields:",
        "- risks: Array<{ severity, title, detail, affectedFiles, suggestedVerification?: string, confidence, basis }>",
      ].join("\n");
    case "auditor":
      return [
        "Auditor workflow fields:",
        "- pass: boolean",
        "- missingTools: Array<{ name: string, reason: string }>",
        "Use only exact tool names from the provided catalog/context. If no tool clearly applies, set pass=true and missingTools=[].",
      ].join("\n");
    case "opinion":
      return [
        "Opinion workflow fields:",
        "- recommendation: non-empty string",
        "- objections: string[]",
        "- assumptions: string[]",
        "- failureModes: string[]",
      ].join("\n");
    case "explore":
      return "Explore workflow fields: put the answer in summary and cite relevant files in fileReferences.";
    case "work":
      return [
        "Work workflow fields:",
        "- tests: Array<{ command: string, status: \"passed\" | \"failed\" | \"not-run\", summary?: string }>",
        "- risks: Array<{ severity, title, detail, affectedFiles, suggestedVerification?: string, confidence, basis }>",
      ].join("\n");
    case "generate":
      // generate uses a separate prompt (buildGenerationPrompt); never reaches here.
      return "";
  }
}

function assertRecord(value: unknown, path: string, errors: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }

  return value;
}

function requireString(record: Record<string, unknown>, key: string, errors: string[], path = key): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }

  return value;
}

function parseConfidence(value: unknown, path: string, errors: string[]): Confidence {
  const record = assertRecord(value, path, errors);
  if (typeof record.level !== "string" || !CONFIDENCE_LEVELS.has(record.level)) {
    errors.push(`${path}.level must be high, medium, low, or unknown`);
  }
  if ("rationale" in record && typeof record.rationale !== "string") {
    errors.push(`${path}.rationale must be a string when present`);
  }

  return {
    level: CONFIDENCE_LEVELS.has(String(record.level)) ? (record.level as Confidence["level"]) : "unknown",
    rationale: typeof record.rationale === "string" ? record.rationale : undefined,
  };
}

function parseStringArray(value: unknown, path: string, errors: string[], required = false): string[] | undefined {
  if (value === undefined) {
    if (required) {
      errors.push(`${path} must be an array`);
      return [];
    }
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    errors.push(`${path} must be a string array`);
    return [];
  }

  return value;
}

function parseBoolean(value: unknown, path: string, errors: string[]): boolean {
  if (typeof value !== "boolean") {
    errors.push(`${path} must be a boolean`);
    return false;
  }

  return value;
}

function parseMissingTools(value: unknown, path: string, errors: string[], required = false): SidecarMissingTool[] | undefined {
  const items = parseArray(value, path, errors, required);
  if (!items) {
    return undefined;
  }

  return items.map((item, index) => {
    const record = assertRecord(item, `${path}[${index}]`, errors);
    return {
      name: requireString(record, "name", errors, `${path}[${index}].name`),
      reason: requireString(record, "reason", errors, `${path}[${index}].reason`),
    };
  });
}

function parseFileReferences(value: unknown, path: string, errors: string[], required = false): FileReference[] | undefined {
  const items = parseArray(value, path, errors, required);
  if (!items) {
    return undefined;
  }

  return items.map((item, index) => {
    const record = assertRecord(item, `${path}[${index}]`, errors);
    const reference: FileReference = { path: requireString(record, "path", errors, `${path}[${index}].path`) };
    if ("line" in record) {
      if (typeof record.line !== "number" || !Number.isInteger(record.line) || record.line < 1) {
        errors.push(`${path}[${index}].line must be a positive integer when present`);
      } else {
        reference.line = record.line;
      }
    }
    if ("label" in record) {
      if (typeof record.label !== "string") {
        errors.push(`${path}[${index}].label must be a string when present`);
      } else {
        reference.label = record.label;
      }
    }
    return reference;
  });
}

function parseSourceBoundaries(value: unknown, path: string, errors: string[], required = false): SourceBoundary[] | undefined {
  const items = parseArray(value, path, errors, required);
  if (!items) {
    return undefined;
  }

  return items.map((item, index) => {
    const record = assertRecord(item, `${path}[${index}]`, errors);
    const trust = record.trust;
    if (typeof trust !== "string" || !TRUST_LEVELS.has(trust)) {
      errors.push(`${path}[${index}].trust must be a known trust level`);
    }
    if ("notes" in record && typeof record.notes !== "string") {
      errors.push(`${path}[${index}].notes must be a string when present`);
    }

    return {
      label: requireString(record, "label", errors, `${path}[${index}].label`),
      source: requireString(record, "source", errors, `${path}[${index}].source`),
      trust: TRUST_LEVELS.has(String(trust)) ? (trust as SourceBoundary["trust"]) : "unknown",
      notes: typeof record.notes === "string" ? record.notes : undefined,
    };
  });
}

function parseFindings(value: unknown, path: string, errors: string[], required = false): SidecarFinding[] | undefined {
  const items = parseArray(value, path, errors, required);
  if (!items) {
    return undefined;
  }

  return items.map((item, index) => {
    const record = assertRecord(item, `${path}[${index}]`, errors);
    const finding: SidecarFinding = {
      severity: parseSeverity(record.severity, `${path}[${index}].severity`, errors),
      title: requireString(record, "title", errors, `${path}[${index}].title`),
      detail: requireString(record, "detail", errors, `${path}[${index}].detail`),
      confidence: parseConfidence(record.confidence, `${path}[${index}].confidence`, errors),
      basis: parseBasis(record.basis, `${path}[${index}].basis`, errors),
    };

    if ("evidence" in record) {
      if (typeof record.evidence !== "string") {
        errors.push(`${path}[${index}].evidence must be a string when present`);
      } else {
        finding.evidence = record.evidence;
      }
    }
    if ("file" in record) {
      if (typeof record.file !== "string") {
        errors.push(`${path}[${index}].file must be a string when present`);
      } else {
        finding.file = record.file;
      }
    }
    if ("line" in record) {
      if (typeof record.line !== "number" || !Number.isInteger(record.line) || record.line < 1) {
        errors.push(`${path}[${index}].line must be a positive integer when present`);
      } else {
        finding.line = record.line;
      }
    }

    return finding;
  });
}

function parseRisks(value: unknown, path: string, errors: string[], required = false): SidecarRisk[] | undefined {
  const items = parseArray(value, path, errors, required);
  if (!items) {
    return undefined;
  }

  return items.map((item, index) => {
    const record = assertRecord(item, `${path}[${index}]`, errors);
    const risk: SidecarRisk = {
      severity: parseSeverity(record.severity, `${path}[${index}].severity`, errors),
      title: requireString(record, "title", errors, `${path}[${index}].title`),
      detail: requireString(record, "detail", errors, `${path}[${index}].detail`),
      affectedFiles: parseFileReferences(record.affectedFiles, `${path}[${index}].affectedFiles`, errors, true) ?? [],
      confidence: parseConfidence(record.confidence, `${path}[${index}].confidence`, errors),
      basis: parseBasis(record.basis, `${path}[${index}].basis`, errors),
    };

    if ("suggestedVerification" in record) {
      if (typeof record.suggestedVerification !== "string") {
        errors.push(`${path}[${index}].suggestedVerification must be a string when present`);
      } else {
        risk.suggestedVerification = record.suggestedVerification;
      }
    }

    return risk;
  });
}

function parseTests(value: unknown, path: string, errors: string[], required = false): TestRecord[] | undefined {
  const items = parseArray(value, path, errors, required);
  if (!items) {
    return undefined;
  }

  return items.map((item, index) => {
    const record = assertRecord(item, `${path}[${index}]`, errors);
    const status = record.status;
    if (status !== "passed" && status !== "failed" && status !== "not-run") {
      errors.push(`${path}[${index}].status must be passed, failed, or not-run`);
    }
    if ("summary" in record && typeof record.summary !== "string") {
      errors.push(`${path}[${index}].summary must be a string when present`);
    }

    return {
      command: requireString(record, "command", errors, `${path}[${index}].command`),
      status: status === "passed" || status === "failed" || status === "not-run" ? status : "not-run",
      summary: typeof record.summary === "string" ? record.summary : undefined,
    };
  });
}

function parseArray(value: unknown, path: string, errors: string[], required: boolean): unknown[] | undefined {
  if (value === undefined) {
    if (required) {
      errors.push(`${path} must be an array`);
      return [];
    }
    return undefined;
  }

  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }

  return value;
}

function parseSeverity(value: unknown, path: string, errors: string[]): Severity {
  if (typeof value !== "string" || !SEVERITIES.has(value as Severity)) {
    errors.push(`${path} must be critical, high, medium, or low`);
    return "low";
  }

  return value as Severity;
}

function parseBasis(value: unknown, path: string, errors: string[]): EvidenceBasis {
  if (typeof value !== "string" || !BASES.has(value as EvidenceBasis)) {
    errors.push(`${path} must be observed, inferred, or hypothetical`);
    return "inferred";
  }

  return value as EvidenceBasis;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
