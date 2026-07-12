import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { currentProcessIdentity } from "./process-identity.js";
import { attemptDirectory, publishRecord, readClaim, readRecord } from "./run-records.js";
import { sha256, stableJson } from "./run-foundation.js";

const runDirectory = process.argv[2]!;
if (process.env.FIXTURE_NEVER_READ_PERMIT === "1") {
  process.on("SIGTERM", () => {});
  await waitForever();
}
readFileSync(3); // Permit EOF is the only pre-side-effect gate.
const lock = join(runDirectory, "launch.lock");
const claim = await readClaim(lock);
const spawned = await readRecord(lock, "spawn.json");
const identity = await currentProcessIdentity();
if (!spawned || spawned.kind !== "spawn" || spawned.generation !== claim.generation || spawned.token !== claim.token || spawned.pid !== process.pid || spawned.pgid !== process.pid || stableJson(spawned.processIdentity) !== stableJson(identity)) process.exit(0);
if (process.env.FIXTURE_EARLY_EXIT === "1") process.exit(0);
const attempt = await attemptDirectory(runDirectory, claim.generation, claim.token);
await publishRecord(attempt, "boot.json", { kind: "boot", generation: claim.generation, token: claim.token, pid: process.pid, pgid: process.pid, processIdentity: identity, createdAt: new Date().toISOString() });
if (stableJson(await readClaim(lock)) !== stableJson(claim)) process.exit(0);
process.on("SIGTERM", () => { if (process.env.FIXTURE_IGNORE_TERM !== "1") process.exit(0); });
if (process.env.FIXTURE_HANG === "1") await waitForever();
if (process.env.FIXTURE_MALFORMED_READY === "1") {
  const body = { version: 1, kind: "ready", generation: claim.generation, token: claim.token, pid: 0, pgid: process.pid, processIdentity: identity, createdAt: new Date().toISOString() };
  await writeFile(join(attempt, "ready.json"), `${JSON.stringify({ ...body, digest: sha256(stableJson(body)) })}\n`, { mode: 0o600 });
  await waitForever();
}
if (process.env.FIXTURE_BAD_READY === "1") {
  await publishRecord(attempt, "ready.json", { kind: "ready", generation: claim.generation, token: "a".repeat(43), pid: process.pid, pgid: process.pid, processIdentity: identity, createdAt: new Date().toISOString() });
  await waitForever();
}
await publishRecord(attempt, "ready.json", { kind: "ready", generation: claim.generation, token: claim.token, pid: process.pid, pgid: process.pid, processIdentity: identity, createdAt: new Date().toISOString() });
await waitForever();

function waitForever(): Promise<never> { return new Promise(() => { setInterval(() => {}, 1_000); }); }
