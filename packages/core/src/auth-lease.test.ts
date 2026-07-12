import assert from "node:assert/strict";
import { chmod, lstat, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  __authLeaseTestHooks, claimAuthLease, inspectAuthLease, recoverAuthLease, releaseAuthLease,
  writeAuthLeaseMarker, type AuthLeaseInput,
} from "./auth-lease.js";
import { currentProcessIdentity } from "./process-identity.js";

async function fixture(t: test.TestContext): Promise<AuthLeaseInput> {
  const root = await mkdtemp(join(tmpdir(), "codex-sidecar-auth-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const home = join(canonicalRoot, "home");
  const cacheRoot = join(canonicalRoot, "cache");
  const journalPath = join(canonicalRoot, "journal");
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cacheRoot, { mode: 0o700 }), mkdir(journalPath, { mode: 0o700 })]);
  await Promise.all([chmod(home, 0o700), chmod(cacheRoot, 0o700), chmod(journalPath, 0o700)]);
  return { home, cacheRoot, owner: { kind: "test", id: "owner", journalPath, processIdentity: await currentProcessIdentity() } };
}

async function claimThenCrash(input: AuthLeaseInput, clean = false): Promise<void> {
  const module = new URL("./auth-lease.js", import.meta.url).pathname;
  await new Promise<void>((resolve, reject) => {
    const code = `import {claimAuthLease,writeAuthLeaseMarker} from ${JSON.stringify(module)}; import {currentProcessIdentity} from ${JSON.stringify(new URL("./process-identity.js", import.meta.url).pathname)}; const i=${JSON.stringify(input)}; i.owner.processIdentity=await currentProcessIdentity(); const lease=await claimAuthLease(i); ${clean ? "for (const kind of ['app-server-started','app-server-exited','auth-written-back','clean-shutdown']) await writeAuthLeaseMarker(lease,kind);" : ""}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`fixture child failed: ${code}`)));
  });
}

function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function writeRawJson(path: string, value: object): Promise<void> { await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await chmod(path, 0o600); }
function rawMarker(kind: string, lease: NonNullable<Awaited<ReturnType<typeof inspectAuthLease>>["claim"]>, createdAt: string, extra: Record<string, string> = {}): Record<string, unknown> {
  const body = { version: 1, kind, token: lease.token, canonicalAuthPath: lease.canonicalAuthPath, ...extra, createdAt };
  return { ...body, digest: digest(stable(body)) };
}
async function waitReady(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not become ready")), 5_000);
    let out = "";
    child.stdout?.on("data", (chunk) => { out += chunk; if (out.includes("READY\n")) { clearTimeout(timeout); resolve(); } });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { if (!out.includes("READY\n")) { clearTimeout(timeout); reject(new Error(`child exited before ready: ${code}`)); } });
  });
}
async function waitExit(child: ReturnType<typeof spawn>): Promise<void> { await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("child did not exit")), 5_000); child.once("error", reject); child.once("exit", () => { clearTimeout(timeout); resolve(); }); }); }
function childCode(input: AuthLeaseInput, statement: string): string {
  const module = new URL("./auth-lease.js", import.meta.url).pathname;
  const identity = new URL("./process-identity.js", import.meta.url).pathname;
  return `import {__authLeaseTestHooks,claimAuthLease,recoverAuthLease,releaseAuthLease,writeAuthLeaseMarker} from ${JSON.stringify(module)}; import {currentProcessIdentity} from ${JSON.stringify(identity)}; const i=${JSON.stringify(input)}; i.owner.processIdentity=await currentProcessIdentity(); ${statement}`;
}
function stoppedChild(input: AuthLeaseInput, statement: string): ReturnType<typeof spawn> { return spawn(process.execPath, ["--input-type=module", "-e", childCode(input, statement)], { stdio: ["ignore", "pipe", "pipe"] }); }
async function killStopped(child: ReturnType<typeof spawn>): Promise<void> { child.kill("SIGKILL"); await waitExit(child); }
async function mutexNames(input: AuthLeaseInput): Promise<string[]> {
  const lease = (await inspectAuthLease(input)).claim;
  const root = lease?.leaseDirectory ?? join(input.cacheRoot, "codex-sidecar", "auth-leases", digest(join(input.home, "auth.json")));
  return (await readdir(join(root, "mutex"))).filter((name) => /^\d{20}\.(claim|released)\.json$/.test(name)).sort();
}

test("claim crash recovery requires confirmation and a never-started journal, then leaves a durable operator record", async (t) => {
  const input = await fixture(t);
  await claimThenCrash(input);
  await assert.rejects(() => claimAuthLease(input), { code: "AUTH_LEASE_BUSY" });
  assert.equal((await inspectAuthLease(input)).state, "held");
  await assert.rejects(() => recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: false }), { code: "RUN_AUTH_UNCERTAIN" });
  const crashedClaim = await inspectAuthLease(input);
  assert.equal(crashedClaim.state, "held");
  await recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true });
  assert.equal((await inspectAuthLease(input)).state, "available");
  assert.equal((await lstat(join(input.owner.journalPath, "operator-recovery.json"))).mode & 0o777, 0o600);
  await claimAuthLease(input);
});

test("clean crash recovery accepts only all matching clean markers", async (t) => {
  const input = await fixture(t);
  await claimThenCrash(input, true);
  const lease = (await inspectAuthLease(input)).claim!;
  await assert.rejects(() => recoverAuthLease(input, { strategy: "release-clean", confirmNoRunningProcesses: false }), { code: "RUN_AUTH_UNCERTAIN" });
  await recoverAuthLease(input, { strategy: "release-clean", confirmNoRunningProcesses: true });
  assert.equal((await inspectAuthLease(input)).state, "available");
});

test("clean recovery rejects an incomplete or foreign marker journal", async (t) => {
  const incomplete = await fixture(t);
  await claimThenCrash(incomplete);
  const lease = (await inspectAuthLease(incomplete)).claim!;
  await writeRawJson(join(incomplete.owner.journalPath, "app-server-exited.json"), rawMarker("app-server-exited", lease, "2021-01-01T00:00:00.000Z"));
  await writeRawJson(join(incomplete.owner.journalPath, "auth-written-back.json"), rawMarker("auth-written-back", lease, "2021-01-01T00:00:01.000Z", { initialAuthHash: "absent", finalAuthHash: "absent", canonicalAuthHash: "absent" }));
  await assert.rejects(() => recoverAuthLease(incomplete, { strategy: "release-clean", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal((await inspectAuthLease(incomplete)).state, "held");
});

test("recovery retries an exact durable operator record after interruption", async (t) => {
  const input = await fixture(t);
  await claimThenCrash(input);
  await recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true });
  assert.equal((await inspectAuthLease(input)).state, "available");
});

test("parallel OS processes have one winner and loser does not replace current", async (t) => {
  const input = await fixture(t);
  const module = new URL("./auth-lease.js", import.meta.url).pathname;
  const payload = JSON.stringify(input);
  const run = () => new Promise<string>((resolve, reject) => {
    const identity = new URL("./process-identity.js", import.meta.url).pathname;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {claimAuthLease} from ${JSON.stringify(module)}; import {currentProcessIdentity} from ${JSON.stringify(identity)}; const i=${payload}; i.owner.processIdentity=await currentProcessIdentity(); claimAuthLease(i).then(x=>console.log('ok:'+x.token), e=>console.log('err:'+e.code));`], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.on("error", reject); child.on("exit", () => resolve(out.trim()));
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal([a, b].filter((x) => x.startsWith("ok:")).length, 1, `${a} | ${b}`);
  assert.equal([a, b].filter((x) => x === "err:AUTH_LEASE_BUSY" || x === "err:RUN_AUTH_UNCERTAIN").length, 1);
});

test("corrupt, symlink, mode and ABA replacement fail closed", async (t) => {
  const input = await fixture(t);
  const lease = await claimAuthLease(input);
  await chmod(lease.currentPath, 0o644);
  await assert.rejects(() => inspectAuthLease(input), { code: "RUN_AUTH_UNCERTAIN" });
  await chmod(lease.currentPath, 0o600);
  await rm(lease.currentPath);
  await symlink(lease.claimPath, lease.currentPath);
  await assert.rejects(() => releaseAuthLease(lease), { code: "RUN_AUTH_UNCERTAIN" });
});

test("missing auth.json uses canonical home identity across owners and journals", async (t) => {
  const input = await fixture(t);
  await claimAuthLease(input);
  const otherJournal = join(input.cacheRoot, "other-journal");
  await mkdir(otherJournal, { mode: 0o700 });
  const other = { ...input, owner: { ...input.owner, id: "other", journalPath: otherJournal } };
  await assert.rejects(() => claimAuthLease(other), { code: "AUTH_LEASE_BUSY" });
});

test("operator recovery survives a subprocess crash after publishing its exact record", async (t) => {
  const input = await fixture(t);
  await claimThenCrash(input);
  const module = new URL("./auth-lease.js", import.meta.url).pathname;
  const identity = new URL("./process-identity.js", import.meta.url).pathname;
  const code = `import {__authLeaseTestHooks,recoverAuthLease} from ${JSON.stringify(module)}; import {currentProcessIdentity} from ${JSON.stringify(identity)}; const i=${JSON.stringify(input)}; i.owner.processIdentity=await currentProcessIdentity(); __authLeaseTestHooks.afterRecoveryRecord=async()=>{console.log('READY');process.kill(process.pid,'SIGSTOP')}; await recoverAuthLease(i,{strategy:'release-never-started',confirmNoRunningProcesses:true})`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  await waitReady(child);
  const held = (await inspectAuthLease(input)).claim!;
  await assert.rejects(() => recoverAuthLease(input, { strategy: "release-clean", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
  assert.deepEqual((await inspectAuthLease(input)).claim, held);
  await child.kill("SIGKILL"); await waitExit(child);
  await recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true });
  assert.equal((await inspectAuthLease(input)).state, "available");
});

test("abandoned recovery mutex cannot mutate a foreign current", async (t) => {
  for (const variant of ["strategy", "token", "path"] as const) await t.test(variant, async (t) => {
    const input = await fixture(t); await claimThenCrash(input);
    const lease = (await inspectAuthLease(input)).claim!;
    const module = new URL("./auth-lease.js", import.meta.url).pathname;
    const identity = new URL("./process-identity.js", import.meta.url).pathname;
    const code = `import {__authLeaseTestHooks,recoverAuthLease} from ${JSON.stringify(module)}; import {currentProcessIdentity} from ${JSON.stringify(identity)}; const i=${JSON.stringify(input)}; i.owner.processIdentity=await currentProcessIdentity(); __authLeaseTestHooks.afterRecoveryRecord=async()=>{console.log('READY');process.kill(process.pid,'SIGSTOP')}; await recoverAuthLease(i,{strategy:'release-never-started',confirmNoRunningProcesses:true})`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
    await waitReady(child); child.kill("SIGKILL"); await waitExit(child);
    if (variant !== "strategy") {
      const path = join(input.owner.journalPath, "operator-recovery.json");
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      record[variant === "token" ? "token" : "canonicalAuthPath"] = variant === "token" ? `${lease.token.slice(0, -1)}x` : "/foreign/auth.json";
      record.digest = digest(stable(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "digest"))));
      await writeRawJson(path, record);
    }
    const before = await inspectAuthLease(input);
    await assert.rejects(() => recoverAuthLease(input, { strategy: variant === "strategy" ? "release-clean" : "release-never-started", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
    assert.deepEqual(await inspectAuthLease(input), before);
  });
});

test("foreign subprocess normal release is rejected and leaves current unchanged", async (t) => {
  const input = await fixture(t);
  const lease = await claimAuthLease(input);
  const module = new URL("./auth-lease.js", import.meta.url).pathname;
  const code = `import {releaseAuthLease} from ${JSON.stringify(module)}; const lease=${JSON.stringify(lease)}; releaseAuthLease(lease).then(()=>console.log('ok'),e=>console.log(e.code));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); await waitExit(child);
  assert.equal(output.trim(), "RUN_AUTH_UNCERTAIN");
  assert.equal((await inspectAuthLease(input)).claim!.token, lease.token);
});

test("clean recovery rejects digest-valid raw markers with invalid schema or causality", async (t) => {
  const cases: Array<[string, (lease: NonNullable<Awaited<ReturnType<typeof inspectAuthLease>>["claim"]>, records: Record<string, Record<string, unknown>>) => void]> = [
    ["started欠落で後続あり", (_lease, records) => { delete records.started; }],
    ["時刻逆順", (_lease, records) => { records.exited.createdAt = "2020-01-01T00:00:00.000Z"; records.exited.digest = digest(stable(Object.fromEntries(Object.entries(records.exited).filter(([key]) => key !== "digest")))); }],
    ["foreign token", (lease, records) => { records.exited.token = `${lease.token.slice(0, -1)}x`; records.exited.digest = digest(stable(Object.fromEntries(Object.entries(records.exited).filter(([key]) => key !== "digest")))); }],
    ["foreign canonical path", (_lease, records) => { records.exited.canonicalAuthPath = "/foreign/auth.json"; records.exited.digest = digest(stable(Object.fromEntries(Object.entries(records.exited).filter(([key]) => key !== "digest")))); }],
    ["initial hash invalid", (_lease, records) => { records.written.initialAuthHash = "bad"; records.written.digest = digest(stable(Object.fromEntries(Object.entries(records.written).filter(([key]) => key !== "digest")))); }],
    ["final hash invalid", (_lease, records) => { records.written.finalAuthHash = "bad"; records.written.digest = digest(stable(Object.fromEntries(Object.entries(records.written).filter(([key]) => key !== "digest")))); }],
    ["canonical hash invalid", (_lease, records) => { records.written.canonicalAuthHash = "bad"; records.written.digest = digest(stable(Object.fromEntries(Object.entries(records.written).filter(([key]) => key !== "digest")))); }],
    ["clean digest mismatch", (_lease, records) => { records.clean.authWrittenBackDigest = "0".repeat(64); records.clean.digest = digest(stable(Object.fromEntries(Object.entries(records.clean).filter(([key]) => key !== "digest")))); }],
  ];
  for (const [name, corrupt] of cases) await t.test(name, async (t) => {
    const input = await fixture(t); await claimThenCrash(input); const lease = (await inspectAuthLease(input)).claim!;
    const records = {
      started: rawMarker("app-server-started", lease, "2021-01-01T00:00:00.000Z"),
      exited: rawMarker("app-server-exited", lease, "2021-01-01T00:00:01.000Z"),
      written: rawMarker("auth-written-back", lease, "2021-01-01T00:00:02.000Z", { initialAuthHash: "absent", finalAuthHash: "absent", canonicalAuthHash: "absent" }),
      clean: {} as Record<string, unknown>,
    };
    records.clean = rawMarker("clean-shutdown", lease, "2021-01-01T00:00:03.000Z", { authWrittenBackDigest: String(records.written.digest) });
    corrupt(lease, records);
    for (const [key, record] of Object.entries(records)) if (key !== "started" || record) await writeRawJson(join(input.owner.journalPath, `${key === "started" ? "app-server-started" : key === "exited" ? "app-server-exited" : key === "written" ? "auth-written-back" : "clean-shutdown"}.json`), record);
    await assert.rejects(() => recoverAuthLease(input, { strategy: "release-clean", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
    assert.equal((await inspectAuthLease(input)).state, "held");
  });
});

test("never-started recovery rejects each later marker even alone", async (t) => {
  for (const kind of ["app-server-exited", "auth-written-back", "clean-shutdown"] as const) await t.test(kind, async (t) => {
    const input = await fixture(t); await claimThenCrash(input); const lease = (await inspectAuthLease(input)).claim!;
    if (kind === "auth-written-back") await writeRawJson(join(input.owner.journalPath, `${kind}.json`), rawMarker(kind, lease, "2021-01-01T00:00:00.000Z", { initialAuthHash: "absent", finalAuthHash: "absent", canonicalAuthHash: "absent" }));
    else if (kind === "clean-shutdown") await writeRawJson(join(input.owner.journalPath, `${kind}.json`), rawMarker(kind, lease, "2021-01-01T00:00:00.000Z", { authWrittenBackDigest: "0".repeat(64) }));
    else await writeRawJson(join(input.owner.journalPath, `${kind}.json`), rawMarker(kind, lease, "2021-01-01T00:00:00.000Z"));
    await assert.rejects(() => recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
    assert.equal((await inspectAuthLease(input)).claim!.token, lease.token);
  });
});

test("same-content replacement with a distinct inode is rejected by inspect and release", async (t) => {
  const input = await fixture(t); const lease = await claimAuthLease(input);
  const copied = join(lease.leaseDirectory, "same-content.json");
  await writeFile(copied, await readFile(lease.claimPath), { mode: 0o600 }); await chmod(copied, 0o600);
  await rm(lease.currentPath); await link(copied, lease.currentPath);
  await assert.rejects(() => inspectAuthLease(input), { code: "RUN_AUTH_UNCERTAIN" });
  await assert.rejects(() => releaseAuthLease(lease), { code: "RUN_AUTH_UNCERTAIN" });
});

test("write-back and recovery reject valid-format hashes that disagree with canonical auth", async (t) => {
  const input = await fixture(t); const lease = await claimAuthLease(input);
  const foreign = "a".repeat(64);
  await assert.rejects(() => writeAuthLeaseMarker(lease, "auth-written-back", { initialAuthHash: "absent", finalAuthHash: foreign, canonicalAuthHash: foreign }), { code: "RUN_AUTH_UNCERTAIN" });
  const crashed = await fixture(t); await claimThenCrash(crashed); const crashedLease = (await inspectAuthLease(crashed)).claim!;
  await writeRawJson(join(crashed.owner.journalPath, "app-server-started.json"), rawMarker("app-server-started", crashedLease, "2021-01-01T00:00:00.000Z"));
  await writeRawJson(join(crashed.owner.journalPath, "app-server-exited.json"), rawMarker("app-server-exited", crashedLease, "2021-01-01T00:00:01.000Z"));
  await writeRawJson(join(crashed.owner.journalPath, "auth-written-back.json"), rawMarker("auth-written-back", crashedLease, "2021-01-01T00:00:02.000Z", { initialAuthHash: "absent", finalAuthHash: foreign, canonicalAuthHash: foreign }));
  const written = JSON.parse(await readFile(join(crashed.owner.journalPath, "auth-written-back.json"), "utf8")) as { digest: string };
  await writeRawJson(join(crashed.owner.journalPath, "clean-shutdown.json"), rawMarker("clean-shutdown", crashedLease, "2021-01-01T00:00:03.000Z", { authWrittenBackDigest: written.digest }));
  await assert.rejects(() => recoverAuthLease(crashed, { strategy: "release-clean", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
});

test("marker write rejects a lease released before the marker operation", async (t) => {
  const input = await fixture(t); const lease = await claimAuthLease(input);
  await releaseAuthLease(lease);
  await assert.rejects(() => writeAuthLeaseMarker(lease, "app-server-started"), { code: "RUN_AUTH_UNCERTAIN" });
});

test("journal crashes before and after marker publication settle without releasing the lease", async (t) => {
  for (const phase of ["before-marker", "after-marker"] as const) await t.test(phase, async (t) => {
    const input = await fixture(t);
    const hook = phase === "before-marker" ? "afterMutexClaimPublished" : "afterLeaseMutationBeforeMutexRelease";
    const child = stoppedChild(input, `const lease=await claimAuthLease(i); __authLeaseTestHooks.${hook}=async(op)=>{if(op==='journal'){console.log('READY');process.kill(process.pid,'SIGSTOP')}}; await writeAuthLeaseMarker(lease,'app-server-started')`);
    t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
    await waitReady(child); await killStopped(child);
    assert.equal((await inspectAuthLease(input)).state, "held");
    const markerPath = join(input.owner.journalPath, "app-server-started.json");
    if (phase === "before-marker") {
      await assert.rejects(() => readFile(markerPath), { code: "ENOENT" });
      await recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true });
      assert.equal((await inspectAuthLease(input)).state, "available");
    } else {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as { kind: string };
      assert.equal(marker.kind, "app-server-started");
      await assert.rejects(() => recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
      assert.equal((await inspectAuthLease(input)).state, "held");
    }
  });
});

test("journal barrier prevents release from overtaking marker publication", async (t) => {
  const input = await fixture(t); const lease = await claimAuthLease(input);
  let enter!: () => void; let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  __authLeaseTestHooks.afterMutexClaimPublished = async (operation) => { if (operation === "journal") { enter(); await gate; } };
  t.after(() => { __authLeaseTestHooks.afterMutexClaimPublished = undefined; });
  const marker = writeAuthLeaseMarker(lease, "app-server-started");
  await entered;
  await assert.rejects(() => releaseAuthLease(lease), { code: "RUN_AUTH_UNCERTAIN" });
  resume(); await marker;
  await releaseAuthLease(lease);
  await assert.rejects(() => writeAuthLeaseMarker(lease, "app-server-exited"), { code: "RUN_AUTH_UNCERTAIN" });
});

test("auth write-back rechecks canonical auth after acquiring the journal barrier", async (t) => {
  const input = await fixture(t); const lease = await claimAuthLease(input);
  __authLeaseTestHooks.afterMutexClaimPublished = async (operation) => { if (operation === "journal") await writeFile(join(input.home, "auth.json"), "changed-at-barrier\n", { mode: 0o600 }); };
  t.after(() => { __authLeaseTestHooks.afterMutexClaimPublished = undefined; });
  await assert.rejects(() => writeAuthLeaseMarker(lease, "auth-written-back"), { code: "RUN_AUTH_UNCERTAIN" });
  await assert.rejects(() => readFile(join(input.owner.journalPath, "auth-written-back.json")), { code: "ENOENT" });
});

test("release crash after current unlink settles its generation before another claim", async (t) => {
  const input = await fixture(t);
  const child = stoppedChild(input, "const lease=await claimAuthLease(i); __authLeaseTestHooks.afterLeaseMutationBeforeMutexRelease=async(op)=>{if(op==='release'){console.log('READY');process.kill(process.pid,'SIGSTOP')}}; await releaseAuthLease(lease)");
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  await waitReady(child); await killStopped(child);
  assert.equal((await inspectAuthLease(input)).state, "available");
  await recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true });
  assert.deepEqual(await mutexNames(input), ["00000000000000000001.claim.json", "00000000000000000001.released.json", "00000000000000000002.claim.json", "00000000000000000002.released.json"]);
  await claimAuthLease(input);
});

test("abandoned release with foreign current fails closed and leaves it unchanged", async (t) => {
  const input = await fixture(t);
  const child = stoppedChild(input, "const lease=await claimAuthLease(i); __authLeaseTestHooks.afterLeaseMutationBeforeMutexRelease=async(op)=>{if(op==='release'){console.log('READY');process.kill(process.pid,'SIGSTOP')}}; await releaseAuthLease(lease)");
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  await waitReady(child); await killStopped(child);
  const leaseDirectory = join(input.cacheRoot, "codex-sidecar", "auth-leases", digest(join(input.home, "auth.json")));
  const original = JSON.parse(await readFile(join(leaseDirectory, (await readdir(leaseDirectory)).find((name) => name.endsWith(".claim.json"))!), "utf8")) as Record<string, unknown>;
  const foreignPath = join(leaseDirectory, "foreign.claim.json"); const foreignToken = "A".repeat(43);
  const foreign: Record<string, unknown> = { ...original, token: foreignToken, claimPath: foreignPath, currentPath: join(leaseDirectory, "current.json") }; foreign.digest = digest(stable(Object.fromEntries(Object.entries(foreign).filter(([key]) => key !== "digest"))));
  await writeRawJson(foreignPath, foreign); await link(foreignPath, join(leaseDirectory, "current.json"));
  const before = await readFile(join(leaseDirectory, "current.json"), "utf8");
  await assert.rejects(() => recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal(await readFile(join(leaseDirectory, "current.json"), "utf8"), before);
});

test("claim crashes before and after current publication settle without releasing a held lease", async (t) => {
  for (const phase of ["before-link", "after-link"] as const) await t.test(phase, async (t) => {
    const input = await fixture(t);
    const hook = phase === "before-link" ? "afterMutexClaimPublished" : "afterLeaseMutationBeforeMutexRelease";
    const child = stoppedChild(input, `__authLeaseTestHooks.${hook}=async(op)=>{if(op==='claim'){console.log('READY');process.kill(process.pid,'SIGSTOP')}}; await claimAuthLease(i)`);
    t.after(() => { if (!child.killed) child.kill("SIGKILL"); }); await waitReady(child); await killStopped(child);
    await recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true });
    assert.equal((await inspectAuthLease(input)).state, "available");
  });
});

test("recovery crash after unlink strictly rechecks target decision before settling", async (t) => {
  const input = await fixture(t); await claimThenCrash(input);
  const child = stoppedChild(input, "__authLeaseTestHooks.afterLeaseMutationBeforeMutexRelease=async(op)=>{if(op==='recover'){console.log('READY');process.kill(process.pid,'SIGSTOP')}}; await recoverAuthLease(i,{strategy:'release-never-started',confirmNoRunningProcesses:true})");
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); }); await waitReady(child); await killStopped(child);
  await recoverAuthLease(input, { strategy: "release-never-started", confirmNoRunningProcesses: true });
  assert.equal((await inspectAuthLease(input)).state, "available");
});

test("clean recovery settlement rechecks canonical auth after the operator decision", async (t) => {
  const input = await fixture(t); await claimThenCrash(input, true);
  const child = stoppedChild(input, "__authLeaseTestHooks.afterRecoveryRecord=async()=>{console.log('READY');process.kill(process.pid,'SIGSTOP')}; await recoverAuthLease(i,{strategy:'release-clean',confirmNoRunningProcesses:true})");
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  await waitReady(child); await killStopped(child);
  await writeFile(join(input.home, "auth.json"), "changed-after-decision\n", { mode: 0o600 });
  await assert.rejects(() => recoverAuthLease(input, { strategy: "release-clean", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal((await inspectAuthLease(input)).state, "held");
});

test("clean recovery rechecks canonical auth after acquiring the recovery barrier", async (t) => {
  const input = await fixture(t); await claimThenCrash(input, true);
  __authLeaseTestHooks.afterMutexClaimPublished = async (operation) => { if (operation === "recover") await writeFile(join(input.home, "auth.json"), "changed-at-recovery-barrier\n", { mode: 0o600 }); };
  t.after(() => { __authLeaseTestHooks.afterMutexClaimPublished = undefined; });
  await assert.rejects(() => recoverAuthLease(input, { strategy: "release-clean", confirmNoRunningProcesses: true }), { code: "RUN_AUTH_UNCERTAIN" });
  assert.equal((await inspectAuthLease(input)).state, "held");
});

test("two recovery subprocesses leave one released artifact per generation", async (t) => {
  const input = await fixture(t); await claimThenCrash(input);
  const run = () => stoppedChild(input, "await recoverAuthLease(i,{strategy:'release-never-started',confirmNoRunningProcesses:true}); console.log('ok')");
  const [a, b] = [run(), run()]; t.after(() => { for (const child of [a, b]) if (!child.killed) child.kill("SIGKILL"); });
  await Promise.all([waitExit(a), waitExit(b)]);
  assert.equal((await inspectAuthLease(input)).state, "available");
  const names = await mutexNames(input); assert.equal(names.length % 2, 0); for (let i = 0; i < names.length; i += 2) assert.equal(names[i]!.replace(".claim.json", ".released.json"), names[i + 1]);
});
