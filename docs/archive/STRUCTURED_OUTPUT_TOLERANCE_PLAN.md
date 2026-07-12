# Structured Output Tolerance Plan

Status: Complete

Canonical plan for making the sidecar's structured-output layer tolerant of the
model dialect drift that produces `PROTOCOL_ERROR` on otherwise-complete reports.
This file is the TODO; check items off as they land.

## Problem (measured 2026-07-12, gpt-5.6-terra × modelReasoningEffort=medium)

`codex_work` returns `PROTOCOL_ERROR` and `status=failed` even though the
implementation turn finished and the worktree holds the change. Two failing runs
(Throughline repo, `.codex-sidecar/logs/app-server/2026-07-11T145139743Z-work-*`
and `2026-07-11T151322525Z-work-*`) show the model emits a *looser but
semantically complete* dialect for `risks[]`:

| field | run 1 | run 2 | lossless to coerce? |
|---|---|---|---|
| `confidence` | `"high"` | `"high"` | **yes** — string is a valid enum level |
| `affectedFiles` | `["…mjs"]` | `[3 paths]` | **yes** — element is the path |
| `severity` | `"high"` ✓ | `"blocker"` ✗ | **no** — synonym needs a guessed mapping |
| `basis` | `"Observed EPERM…"` | `` "`rg…` has no…" `` | **no** — free-text; guessing the enum invents a trust level |

Root cause: [structured-output.ts](../../packages/core/src/structured-output.ts)
`workflowSchema()` lists `risks: Array<{ …confidence, basis }>` by field name only
and does not restate the nested shapes, so at medium effort the model fills the
"natural" compact forms. `high` effort re-derives the shapes and passes.

Today the parse failure is caught in
[app-server-runner.ts](../../packages/core/src/app-server-runner.ts) and returned as
`errorResult` (`status=failed`); `worktree-runner.ts` still merges `changedFiles`
and `worktreePath`, so the artifact is recoverable — but the run reads as a flat
failure and every field the model *did* produce is discarded.

## Principles this fix must honor

- **No prose fallback.** If the assistant turn is not valid JSON, keep the hard
  `PROTOCOL_ERROR`. We never reinterpret prose as the answer.
- **No fabrication.** Never coerce a value that requires *guessing* a
  trust/severity classification (`basis`, `severity` synonyms). Preserve the
  model's original text instead.
- **Disclose every normalization.** Any lossless coercion applied is recorded in
  the result JSON (`normalizationNotes`).
- **Additive contract only.** Existing `status` values and typed field shapes keep
  their meaning; we only add.

## Design — three layers

### Layer 0 — prompt hardening (root cause)
- [x] Expand `workflowSchema()` for `review`, `risk-check`, `work` so the nested
      shapes are explicit inline: `confidence: {level:"high"|…, rationale?}`,
      `affectedFiles: Array<{path:string, line?:number}>`,
      `basis: "observed"|"inferred"|"hypothetical"`,
      `severity: "critical"|"high"|"medium"|"low"`.

### Layer 1 — lossless coercion + disclosure
- [x] `confidence`: bare valid-level string (`"high"`) → `{ level: "high" }`, at
      any position (top-level and inside findings/risks). Record a note.
- [x] `affectedFiles` / `fileReferences`: string element (`"a.ts"`) →
      `{ path: "a.ts" }`. Record a note.
- [x] Do **not** coerce `severity` synonyms or `basis` free-text.
- [x] Collect notes into `SidecarResult.normalizationNotes: string[]` (present on
      `ok` and `partial` results whenever coercion happened).

### Layer 2 — honest degraded salvage
- [x] Split validation into **hard core** (`summary`, `recommendedNextAction`,
      and a recoverable `confidence`) vs **soft** (everything else, incl. all
      workflow-specific fields).
- [x] Hard-core failure or `JSON.parse` failure → keep hard `PROTOCOL_ERROR`.
- [x] Soft failure only → return `status: "partial"` carrying: parsed common
      fields, `unvalidatedReport` (the raw parsed object, verbatim — no fabricated
      typed fields leaked), `error` with the exact violation list, and
      `normalizationNotes`. `work` additionally carries `changedFiles`,
      `worktreePath`, `worktreePreserved`.
- [x] Applies to every workflow (parser is shared).

### Contract changes (additive)
- [x] `SidecarResult.status` gains `"partial"`.
- [x] `SidecarResult.normalizationNotes?: string[]`.
- [x] `SidecarResult.unvalidatedReport?: unknown`.
- [x] CLI exit: `partial` → 0 (artifact usable; loudness via JSON + status).
- [x] MCP `isError`: `partial` → false (deliver the artifact, don't error the tool).
- [x] Update `docs/PROTOCOL.md` §Structured App Server Output to describe the
      `partial` status and the hard-vs-soft split.

## Tests
- [x] Layer 1: bare-string confidence and string `affectedFiles`/`fileReferences`
      coerce and emit `normalizationNotes`.
- [x] Layer 2: a work/risk-check report with drifted `severity`+`basis` returns
      `status="partial"` with `unvalidatedReport` populated and `error` listing the
      violations — not a throw.
- [x] Hard core still throws: non-JSON, and missing `summary`/`recommendedNextAction`.
- [x] Update the two existing `assert.throws` tests (`rejects invalid auditor
      fields`, `rejects missing workflow-specific fields`) to assert the new
      degraded outcome while still proving the violations are surfaced.
- [x] Regression: the two real-log payloads run through the compiled parser both
      go `failed` → `partial` — confidence+affectedFiles are coerced (disclosed in
      `normalizationNotes`) while the residual un-coercible drift (file 1: `basis`;
      file 2: `severity`+`basis`) is surfaced in `validationErrors`, not guessed.
      (Neither reaches `status="ok"`, because Layer 1 deliberately refuses to coerce
      those fields.)

## Gates
- [x] `corepack pnpm typecheck`
- [x] `corepack pnpm test`

## Placement (per orchestrate 着手ゲート)
- **F (統括直轄):** `types.ts`, `structured-output.ts`, `app-server-runner.ts`,
  `worktree-runner.ts`, CLI/MCP consumers — public `SidecarResult` contract,
  source-boundary invariant, the no-fallback boundary.
- **A (委譲可):** bulk test expansion once the parser API is frozen.
