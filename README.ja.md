<p align="center">
  <img src=".github/og.png" alt="codex-sidecar — safe Codex calls for real repos" width="100%">
</p>

# codex-sidecar

[![npm version](https://img.shields.io/npm/v/codex-sidecar-cli.svg?color=cb3837&logo=npm&label=codex-sidecar-cli)](https://www.npmjs.com/package/codex-sidecar-cli)
[![npm version](https://img.shields.io/npm/v/codex-sidecar-mcp.svg?color=cb3837&logo=npm&label=codex-sidecar-mcp)](https://www.npmjs.com/package/codex-sidecar-mcp)
[![CI](https://github.com/kitepon-rgb/codex-sidecar/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon-rgb/codex-sidecar/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/codex-sidecar-cli.svg?color=blue)](LICENSE)
[![node](https://img.shields.io/node/v/codex-sidecar-cli.svg?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![GitHub release](https://img.shields.io/github/v/release/kitepon-rgb/codex-sidecar?color=24292e&logo=github)](https://github.com/kitepon-rgb/codex-sidecar/releases)

[English](README.md) · **日本語**

> **Codex を安全な隔離 sidecar として呼び出し、チャットの会話ログではなく機械可読な答えを受け取る。**
> `codex-sidecar` は、人間・Claude Code・MCP client・hook から Codex にコードレビュー、調査、リスク確認、限定的な修正を依頼でき、active working tree に一切触れずに 1 回ごとに構造化された `SidecarResult` JSON を返します。

[Usage](docs/USAGE.md) · [Architecture](docs/ARCHITECTURE.md) · [Protocol](docs/PROTOCOL.md)

`codex-sidecar` は、Claude Code や MCP client、hook、その他の自動化から Codex を呼ぶための共通実行レイヤーです。Codex を主役に置き換えるのではなく、別視点のレビュー、調査、設計への反対意見、限定的な修正能力を安全な境界つきで差し込みます。

OpenAI API gateway でも画像生成 proxy でもありません。Codex App Server の実行、結果 JSON の正規化、raw log、worktree 隔離、安全 policy をまとめて扱うための土台です。
Codex の既存 model 設定を継承することも、workflow ごとに明示的な model policy を指定することもできます。

## 30 秒で試す

workspace を build:

```bash
npm install -g codex-sidecar-cli
npm install -g codex-sidecar-mcp
```

`codex-sidecar-mcp` は npm の `bin` として配布されます。global install では
PATH 上のコマンドが symlink になるため、この symlink 経由でも MCP stdio
server が起動することをテストで固定しています。

source から build する場合:

```bash
corepack pnpm install
corepack pnpm build
```

対象 repo の設定解決を確認:

```bash
codex-sidecar diagnostics \
  --project /path/to/project \
  --preset review \
  --model gpt-5.5 \
  --model-reasoning-effort medium
```

Codex に read-only 調査を依頼:

```bash
codex-sidecar explore \
  --project /path/to/project \
  "request safety がどこで検証されるか、file reference つきで答えて。"
```

隔離 worktree で小さな修正を依頼:

```bash
codex-sidecar work \
  --project /path/to/project \
  --preset work \
  "parser の最小 regression test を追加して。"
```

`codex_work` は生成した worktree をデフォルトで残すため、人間や呼び出し元が diff を確認してから取り込めます。

## Workflow

| CLI workflow | MCP tool | 目的 | 書き込み | 主な出力 |
|---|---|---|---:|---|
| `review` | `codex_review` | diff / branch / patch のレビュー | なし | `findings`, `missingTests`, `residualRisks` |
| `explore` | `codex_explore` | codebase 調査 | なし | `summary`, `fileReferences` |
| `opinion` | `codex_opinion` | 設計や方針への反対意見 | なし | `recommendation`, `objections`, `assumptions` |
| `risk-check` | `codex_risk_check` | secrets / MCP / OAuth / hooks / Docker / CI の重点確認 | なし | `risks`, `sourceBoundaries` |
| `auditor` | `codex_auditor` | primary tool-use auditor 判定 | なし | `pass`, `missingTools` |
| `work` | `codex_work` | 小さな実装作業 | 隔離 worktree のみ | `changedFiles`, `tests`, `worktreePath` |

すべての workflow は `SidecarResult` JSON を返します。下流ツールは prose を読むのではなく、構造化 field を利用できます。`codex_review` の呼び出しはおおむね次のような結果を返します:

```json
{
  "status": "ok",
  "workflow": "review",
  "summary": "No blocking regressions found.",
  "confidence": {
    "level": "medium",
    "rationale": "The review inspected the changed files but did not run tests."
  },
  "recommendedNextAction": "Run the relevant package tests before merging.",
  "fileReferences": [
    { "path": "packages/core/src/requests.ts", "line": 42, "label": "request execution boundary" }
  ],
  "rawEventLogRef": "/path/to/project/.codex-sidecar/logs/app-server/..."
}
```

workflow 固有 field がこの共通 field の上に乗ります — `review` は `findings` / `missingTests` / `residualRisks`、`work` は `changedFiles` / `tests` / `worktreePath` などを追加します。完全な contract は [docs/USAGE.md](docs/USAGE.md#structured-result-contract) を参照してください。

## 何が嬉しいか

| 直接使う手段 | 得意なこと | `codex-sidecar` が足すもの |
|---|---|---|
| Codex CLI 直叩き | 対話的な Codex session | 安定した request/result JSON、raw log、preset、安全 policy |
| Claude Code 単独 | 主作業の実行 | Claude の文脈を壊さず Codex の別視点を足す |
| repo 固有の MCP tool | 1 つの workflow | CLI/MCP/core contract を複数 repo で共有 |
| active tree への直接自動編集 | 速い local edit | `codex_work` が worktree に閉じ込め、changed files を返す |

## 構成

```mermaid
flowchart LR
  caller[Human, Claude Code, MCP client, hook, automation]
  cli[packages/cli]
  mcp[packages/mcp]
  core[packages/core]
  config[.codex-sidecar.yml]
  app[Codex App Server]
  worktree[isolated git worktree]
  logs[raw JSONL event logs]
  result[SidecarResult JSON]

  caller --> cli
  caller --> mcp
  cli --> core
  mcp --> core
  config --> core
  core --> app
  core --> logs
  app --> core
  core --> result
  core -->|codex_work only| worktree
  worktree --> app
```

CLI と MCP package は薄く保ち、`packages/core` が config、preset、安全 policy、App Server protocol、structured output、raw log、worktree 隔離を担当します。

## LAN MCP サーバー (Docker)

`packages/mcp` は npm `bin` 経由の stdio transport に加え、Streamable HTTP
transport を持っています。HTTP モードを使うと 1 台のホストで LAN 内の複数
MCP クライアント (別マシンの Claude Code、hook、automation) に対して
codex-sidecar を提供でき、すべてのワークステーションに
`codex-sidecar-mcp` を入れる必要がなくなります。

リポジトリには `Dockerfile` と `docker-compose.yml` が同梱されており、
選択した LAN IP のみにバインドします:

```bash
# sidecar を動かすホスト側
git clone https://github.com/kitepon-rgb/codex-sidecar.git
cd codex-sidecar
docker compose up -d --build
```

デフォルトは `192.168.1.2:39201/tcp` にバインドし、`~/.codex` (Codex CLI 認証)
と `~/projects` (対象 repo 群) をコンテナにマウントします。ホストごとに
env または `.env` で上書きできます:

```bash
CODEX_SIDECAR_BIND_HOST=10.0.0.5 \
CODEX_SIDECAR_PORT=39201 \
CODEX_HOME_HOST=/home/alice/.codex \
PROJECTS_HOST=/home/alice/projects \
docker compose up -d --build
```

UFW などでローカル subnet からのみアクセスできるよう制限します:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 39201 proto tcp comment 'codex-sidecar-mcp LAN'
```

bearer token を強制したい場合は compose で `CODEX_SIDECAR_MCP_BEARER` を
設定するとクライアントに `Authorization: Bearer <token>` を要求します。
DNS rebinding 保護 (`CODEX_SIDECAR_MCP_ALLOWED_HOSTS`) はデフォルトで
有効です。MCP SDK は `Host` ヘッダを verbatim で照合するため、bare host
と `host:port` の両形を列挙する必要があります。

MCP クライアント設定例:

```json
{
  "mcpServers": {
    "codex-sidecar-lan": {
      "type": "http",
      "url": "http://192.168.1.2:39201/mcp"
    }
  }
}
```

呼び出し側はクライアントマシンのパスではなく、サーバー側のパス (例:
`/projects/<repo>`) を `projectRoot` に渡してください。

詳細は [docs/USAGE.md](docs/USAGE.md#http-transport-and-lan-deployment) を
参照してください。

## 詳細

- [docs/USAGE.md](docs/USAGE.md): CLI / MCP / worktree / raw log / structured result の使い方。
- [docs/README.md](docs/README.md): docs index と archive map。
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): package 境界、layering、安全 model、result contract。
- [docs/PROTOCOL.md](docs/PROTOCOL.md): Codex App Server との protocol 境界。
- [docs/CODEX_MODEL_POLICY_TODO.md](docs/CODEX_MODEL_POLICY_TODO.md): Codex model policy の計画と TODO。

## 開発

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## License

MIT
