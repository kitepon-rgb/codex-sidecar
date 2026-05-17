# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the canonical contract for agents working in this repo and applies to Claude as well. Read it before making engineering decisions. This file is the Claude-focused supplement.

## Commands

Use `corepack pnpm`. Bare `pnpm` is not guaranteed to be on PATH in this environment and the project pins `pnpm@10.10.0` via `packageManager`. Do not switch package managers.

```bash
corepack pnpm install
corepack pnpm typecheck   # builds core first, then typechecks every package
corepack pnpm test        # core + mcp tests
corepack pnpm build
```

Test runner is `node --test` against **compiled** `dist/*.test.js`, not source. Each package's `test` script does `tsc -p tsconfig.json && node --test dist/...test.js`. Implications:

- Running a single core test file directly:
  ```bash
  corepack pnpm --filter codex-sidecar-core build
  node --test packages/core/dist/safety.test.js
  ```
- Running a single MCP test:
  ```bash
  corepack pnpm --filter codex-sidecar-mcp build
  node --test packages/mcp/dist/index.test.js
  ```
- Filtering by test name uses node's native runner: `node --test --test-name-pattern='<regex>' packages/core/dist/<file>.test.js`.
- After editing `.ts`, you must rebuild before re-running a single test, or the new code is invisible.

`packages/cli` has no test script — it is a thin delegator to core.

Smoke a read-only App Server turn against this repo (after `corepack pnpm build`):

```bash
node packages/cli/dist/index.js diagnostics --project /Users/kite/Developer/codex-sidecar --preset review
node packages/cli/dist/index.js explore --project /Users/kite/Developer/codex-sidecar 'Reply exactly: OK'
```

## Architecture

Two layers, three packages, strict one-way dependency:

```
caller (human / Claude Code / MCP client / hook)
  ↓
packages/cli ──┐
packages/mcp ──┤──→ packages/core ──→ Codex App Server (stdio)
               │                  └─→ isolated git worktree (codex_work only)
```

`packages/core` owns everything non-trivial: config loading (`config.ts`), preset expansion (`presets.ts`), path safety + safety profiles (`safety.ts`, `paths.ts`, `profiles.ts`), App Server lifecycle (`app-server-*.ts`), prompt shaping and JSON parsing (`structured-output.ts`), worktree isolation (`worktree*.ts`), and result schemas (`results.ts`, `types.ts`). CLI and MCP stay thin: they translate input into `SidecarRequest`, call core, return `SidecarResult`.

Dependency direction is enforced:

- CLI → core, MCP → core. **Never** core → CLI/MCP.
- App Server wire-format details (event names, message shapes) must not leak past `packages/core/src/app-server-*`.
- Ecosystem context (Relay / Throughline / Caveat / SmartClaude / CodeGraph) enters core as **plain JSON context blocks**, not direct imports. The `context.ts` adapter is the boundary.

`packages/core/src/index.ts` re-exports the entire public surface. When adding a module, add it there.

## Result contract (do not break)

Every workflow — `review`, `explore`, `opinion`, `risk-check`, `auditor`, `work` — returns a single `SidecarResult` JSON object. `structured-output.ts` parses the Codex assistant turn as one JSON object; if it is not valid JSON or workflow-specific required fields are missing, the run fails with `PROTOCOL_ERROR`. **There is no prose fallback. Do not add one.**

Workflow-specific required fields (see `docs/PROTOCOL.md` §Structured App Server Output):

- `review`: `findings`, `missingTests`, `residualRisks`
- `risk-check`: `risks`
- `auditor`: `pass`, `missingTools`
- `opinion`: `recommendation`, `objections`, `assumptions`, `failureModes`
- `explore`: answer in `summary`, citations in `fileReferences`
- `work`: `tests`, `risks`

Stable contracts that must not break across releases: `SidecarRequest`, `SidecarResult`, workflow names, safety error codes, finding/risk schemas, file reference schema, context block schema, raw event log reference schema.

## Invariants

These are load-bearing. Read `AGENTS.md` §Engineering Rules for the full list.

- **`codex_work` never edits the active working tree.** The runner does `git worktree add --detach`, points App Server's `projectRoot` at the isolated path, validates changed files against `allowedPaths` / `denyPaths`, and preserves the worktree by default for human review. Do not add an "active-tree" code path.
- **No hidden fallback.** If a source, transport, or protocol path fails, return an explicit error (e.g. `APP_SERVER_TIMEOUT`, `SAFETY_REFUSAL`, `PROTOCOL_ERROR`). Never silently substitute another source — especially across official/unofficial, secret/non-secret, or auth/non-auth boundaries.
- **Deny by default for sensitive files.** `.env*`, `**/*.key`, `**/*.pem`, OAuth/token stores, SQLite auth DBs, hook config, deploy config — these stay denied unless the consuming project's `.codex-sidecar.yml` explicitly opts in to read-only inspection.
- **Source boundaries are explicit.** Findings and risks carry `basis: "observed" | "inferred"` and result records distinguish trust levels. Don't blur them in normalization.
- **Model policy is opt-in, not defaulted.** If neither caller, preset, nor `defaults` set `model` / `modelReasoningEffort`, sidecar omits the `-c model=...` startup flag so Codex inherits its own `CODEX_HOME` configuration. `modelPolicy.source` is `explicit` or `inherited` — preserve that distinction.

## MCP transport modes

`packages/mcp` ships two transports selected at runtime:

- **stdio** (default): preserves the `codex-sidecar-mcp` npm bin behavior. The symlinked-bin regression test ([packages/mcp/src/index.test.ts](packages/mcp/src/index.test.ts)) covers it.
- **Streamable HTTP**: enabled with `CODEX_SIDECAR_MCP_TRANSPORT=http`. Implementation in [packages/mcp/src/server-http.ts](packages/mcp/src/server-http.ts), tests in [packages/mcp/src/server-http.test.ts](packages/mcp/src/server-http.test.ts).

Env vars for HTTP mode:

| Var | Default | Notes |
|---|---|---|
| `CODEX_SIDECAR_MCP_HOST` | `127.0.0.1` | Bind a specific interface; use a LAN IP for cross-host access. |
| `CODEX_SIDECAR_MCP_PORT` | `39201` | TCP port. |
| `CODEX_SIDECAR_MCP_BEARER` | unset | When set, every request must include `Authorization: Bearer <token>`. |
| `CODEX_SIDECAR_MCP_ALLOWED_HOSTS` | derived from host/port | Comma-separated allowlist for DNS rebinding protection. Must include both bare host and `host:port`. |

### `allowedHosts` gotcha

The MCP SDK matches the `Host` HTTP header verbatim. `["127.0.0.1"]` alone rejects a client connecting to `http://127.0.0.1:39201/` with `Invalid Host header: 127.0.0.1:39201`. The `defaultAllowedHosts` helper in [server-http.ts](packages/mcp/src/server-http.ts) computes both forms. When writing tests that bind `port: 0` (ephemeral), either resolve the port before constructing the transport or omit `allowedHosts` to disable protection.

## LAN deployment (Docker)

[Dockerfile](Dockerfile), [.dockerignore](.dockerignore), and [docker-compose.yml](docker-compose.yml) build the MCP package and expose it on a single LAN IP. The compose file parameterizes the bind host/port/volumes via env so the committed defaults can be overridden per host:

- `CODEX_SIDECAR_BIND_HOST` / `CODEX_SIDECAR_PORT`: host bind for the published port (default `192.168.1.2:39201`).
- `CODEX_HOME_HOST`: host path to `~/.codex` (Codex CLI auth, sessions). Mounted to `/root/.codex` so the container reuses host login.
- `PROJECTS_HOST`: host path to consumer repositories. Mounted to `/projects`. Callers pass `projectRoot=/projects/<repo>` — these are server-side paths, not client paths.

The image pins codex CLI to `@openai/codex@${CODEX_CLI_VERSION}` (build arg) so the App Server invoked inside the container matches the host's codex version.

Operational reset: `docker compose down` removes the container; `docker compose up -d --build` rebuilds after source changes.

## MCP distribution: the symlinked-bin gotcha

`codex-sidecar-mcp` is consumed via `npm install -g`, which puts a **symlink** on PATH. Clients (Claude Code, other MCP hosts) launch the symlink, not `dist/server.js` directly. The stdio entrypoint resolves the symlink before deciding whether it was invoked as the executable.

If you change `packages/mcp/src/server.ts` startup logic or the `bin` wiring, the MCP test (`packages/mcp/src/index.test.ts`) is what catches a regression where the globally installed command exits immediately instead of running the stdio server. Don't skip it.

## Raw event logs

App Server runs write one JSONL per turn under `<projectRoot>/.codex-sidecar/logs/app-server/`. `SidecarResult.rawEventLogRef` is the local path. The directory is git-ignored because lines contain prompts, file paths, and stderr. Treat the ref as a local debug artifact, not a portable report.

## House style

- User-facing language with the human operator is Japanese (per `AGENTS.md`). Code, comments, commit messages, and docs stay in English unless the surrounding file is already Japanese (`README.ja.md`).
- Existing uncommitted diffs are the user's work — don't revert them as "cleanup".
- Don't add features beyond the task. Keep CLI / MCP thin; push logic into core.

## Key docs

- [AGENTS.md](AGENTS.md): engineering rules, ecosystem context, project purpose
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): layering, package boundaries, safety model
- [docs/PROTOCOL.md](docs/PROTOCOL.md): App Server protocol notes and stable sidecar contracts
- [docs/USAGE.md](docs/USAGE.md): CLI / MCP examples, worktree behavior, structured result shapes
- [docs/TODO.md](docs/TODO.md): durable task list
- [docs/CODEX_MODEL_POLICY_TODO.md](docs/CODEX_MODEL_POLICY_TODO.md): explicit model policy plan
