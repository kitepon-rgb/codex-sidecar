import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildEcosystemContextBlocks } from "./context.js";
import { normalizeSidecarRequest, type RequestInput } from "./presets.js";
import type { EcosystemContextInput, SidecarConfig, SidecarContextBlock, SidecarRequest } from "./index.js";

const fixtureRoot = join(process.cwd(), "..", "..", "examples", "fixtures");

test("ecosystem context adapters match fixture snapshot", async () => {
  const inputs = await readJson<EcosystemContextInput[]>("ecosystem-context.json");
  const expected = await readJson<SidecarContextBlock[]>("expected-context-blocks.json");

  assert.deepEqual(buildEcosystemContextBlocks(inputs), expected);
});

test("request normalization snapshots cover generic and ecosystem repo shapes", async () => {
  const snapshots = await readJson<
    Array<{
      name: string;
      config: SidecarConfig;
      input: RequestInput;
      expected: SidecarRequest;
    }>
  >("request-snapshots.json");

  for (const snapshot of snapshots) {
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeSidecarRequest(snapshot.config, snapshot.input))), snapshot.expected, snapshot.name);
  }
});

async function readJson<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureRoot, fileName), "utf8")) as T;
}
