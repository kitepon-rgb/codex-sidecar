import type { SidecarRequest } from "./types.js";

export type SidecarOutputSchema = Record<string, unknown>;

const nonEmptyString = { type: "string", minLength: 1 } as const;
const stringValue = { type: "string" } as const;
const stringArray = { type: "array", items: stringValue } as const;
const confidence = {
  type: "object",
  properties: {
    level: { type: "string", enum: ["high", "medium", "low", "unknown"] },
  },
  required: ["level"],
  additionalProperties: false,
} as const;
const fileReference = {
  type: "object",
  properties: { path: nonEmptyString },
  required: ["path"],
  additionalProperties: false,
} as const;
const sourceBoundary = {
  type: "object",
  properties: {
    label: nonEmptyString,
    source: nonEmptyString,
    trust: { type: "string", enum: ["official", "unofficial", "local", "generated", "inferred", "unknown"] },
  },
  required: ["label", "source", "trust"],
  additionalProperties: false,
} as const;
const finding = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    title: nonEmptyString,
    detail: nonEmptyString,
    confidence,
    basis: { type: "string", enum: ["observed", "inferred", "hypothetical"] },
  },
  required: ["severity", "title", "detail", "confidence", "basis"],
  additionalProperties: false,
} as const;
const risk = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    title: nonEmptyString,
    detail: nonEmptyString,
    affectedFiles: { type: "array", items: fileReference },
    confidence,
    basis: { type: "string", enum: ["observed", "inferred", "hypothetical"] },
  },
  required: ["severity", "title", "detail", "affectedFiles", "confidence", "basis"],
  additionalProperties: false,
} as const;

export function buildSidecarOutputSchema(request: SidecarRequest): SidecarOutputSchema | undefined {
  if (request.workflow === "generate") return undefined;

  const properties: Record<string, unknown> = {
    summary: nonEmptyString,
    confidence,
    recommendedNextAction: nonEmptyString,
    openQuestions: stringArray,
    fileReferences: { type: "array", items: fileReference },
    sourceBoundaries: { type: "array", items: sourceBoundary },
  };
  const required = [
    "summary",
    "confidence",
    "recommendedNextAction",
    "openQuestions",
    "fileReferences",
    "sourceBoundaries",
  ];

  switch (request.workflow) {
    case "review":
      properties.findings = { type: "array", items: finding };
      properties.missingTests = stringArray;
      properties.residualRisks = stringArray;
      required.push("findings", "missingTests", "residualRisks");
      break;
    case "risk-check":
      properties.risks = { type: "array", items: risk };
      required.push("risks");
      break;
    case "auditor":
      properties.pass = { type: "boolean" };
      properties.missingTools = {
        type: "array",
        items: {
          type: "object",
          properties: { name: nonEmptyString, reason: nonEmptyString },
          required: ["name", "reason"],
          additionalProperties: false,
        },
      };
      required.push("pass", "missingTools");
      break;
    case "opinion":
      properties.recommendation = nonEmptyString;
      properties.objections = stringArray;
      properties.assumptions = stringArray;
      properties.failureModes = stringArray;
      required.push("recommendation", "objections", "assumptions", "failureModes");
      break;
    case "work":
      properties.tests = {
        type: "array",
        items: {
          type: "object",
          properties: {
            command: nonEmptyString,
            status: { type: "string", enum: ["passed", "failed", "not-run"] },
          },
          required: ["command", "status"],
          additionalProperties: false,
        },
      };
      properties.risks = { type: "array", items: risk };
      required.push("tests", "risks");
      break;
    case "explore":
      break;
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
