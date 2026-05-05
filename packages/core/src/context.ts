import type { FileReference, SidecarContextBlock } from "./types.js";

export type EcosystemContextKind = SidecarContextBlock["kind"];

export interface EcosystemContextInput {
  kind: EcosystemContextKind;
  source: string;
  summary: string;
  trust?: SidecarContextBlock["trust"];
  references?: FileReference[];
  data?: unknown;
}

export function buildEcosystemContextBlock(input: EcosystemContextInput): SidecarContextBlock {
  assertContextInput(input);

  const block: SidecarContextBlock = {
    kind: input.kind,
    source: input.source,
    trust: input.trust ?? defaultTrust(input.kind),
    summary: input.summary,
  };

  if (input.references !== undefined) {
    block.references = input.references;
  }

  if (input.data !== undefined) {
    block.data = input.data;
  }

  return block;
}

export function buildEcosystemContextBlocks(inputs: EcosystemContextInput[]): SidecarContextBlock[] {
  return inputs.map((input) => buildEcosystemContextBlock(input));
}

function assertContextInput(input: EcosystemContextInput): void {
  if (!isContextKind(input.kind)) {
    throw new Error(`CONFIG_INVALID: unsupported context kind: ${String(input.kind)}`);
  }

  if (typeof input.source !== "string" || input.source.trim().length === 0) {
    throw new Error("CONFIG_INVALID: context source must be a non-empty string");
  }

  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    throw new Error("CONFIG_INVALID: context summary must be a non-empty string");
  }

  if (input.references !== undefined) {
    for (const [index, reference] of input.references.entries()) {
      if (typeof reference.path !== "string" || reference.path.trim().length === 0) {
        throw new Error(`CONFIG_INVALID: context references[${index}].path must be a non-empty string`);
      }
      if (reference.line !== undefined && (!Number.isInteger(reference.line) || reference.line < 1)) {
        throw new Error(`CONFIG_INVALID: context references[${index}].line must be a positive integer`);
      }
    }
  }
}

function defaultTrust(kind: EcosystemContextKind): SidecarContextBlock["trust"] {
  switch (kind) {
    case "relay_entry":
    case "throughline_handoff":
    case "caveat_entry":
    case "smartclaude_cost_hint":
    case "codegraph_context":
      return "local";
    case "manual_note":
      return "user-provided";
  }
}

function isContextKind(value: string): value is EcosystemContextKind {
  return (
    value === "relay_entry" ||
    value === "throughline_handoff" ||
    value === "caveat_entry" ||
    value === "smartclaude_cost_hint" ||
    value === "codegraph_context" ||
    value === "manual_note"
  );
}
