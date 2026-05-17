# AGENTS.md

このリポジトリで作業する Codex / エージェント向けの入口メモ。

ユーザーとの会話は日本語で行う。

グローバルな鉄の約束は `/home/kite/.codex/AGENTS.md` を正とする。

## Project Purpose

`codex-sidecar` は、kitepon-rgb の AI 開発基盤群から Codex を sidecar agent
として安全に呼び出すための共通実行レイヤー。

単なる `codex review` CLI ではなく、Relay / Throughline / Caveat /
SmartClaude / CodeGraph / image-generator / IP-MCP などの既存プロジェクトと並ぶ
「AI 作業OS」の部品として設計する。Claude Code が主で動く環境に、
Codex の別視点、反対意見、レビュー、調査、限定的な修正能力を差し込む。

同時に、汎用ツールとしても成立させる。設計は「generic core」と
「kitepon-rgb ecosystem overlay」の二層に分ける。generic core は他の
リポジトリでも単体で使える CLI/MCP/安全実行基盤、overlay はユーザーの
MCP/OAuth/hook/memory/cost 系プロジェクトに強く刺さる preset / safety profile /
context adapter とする。

重要な前提:

- Claude が主導し、Codex は sidecar / second opinion として呼ばれる。
- 呼び出し元は人間だけでなく、MCP server、hook、memory tool、cost optimizer
  になり得る。
- 結果は人間向け文章だけでなく、他ツールが再利用できる machine-readable
  JSON として返す。
- この repo の判断は、公開 GitHub の kitepon-rgb リポジトリ群の実態を前提にする。

対象 workflow と MCP tool:

- CLI workflow `review` / MCP tool `codex_review`: diff / branch / patch の読み取り専用レビュー
- CLI workflow `explore` / MCP tool `codex_explore`: コードベース調査とファイル参照つき回答
- CLI workflow `work` / MCP tool `codex_work`: isolated git worktree 上での小さな修正
- CLI workflow `opinion` / MCP tool `codex_opinion`: 設計案への反対意見、見落とし、代替案の提示
- CLI workflow `risk-check` / MCP tool `codex_risk_check`: OAuth / MCP / secrets / Docker / hooks / CI などの重点リスク確認
- CLI workflow `auditor` / MCP tool `codex_auditor`: primary tool-use auditor 用の `pass` / `missingTools` 判定

非目的:

- 画像生成 API 課金の回避
- Codex App Server を一般 OpenAI API gateway として使うこと
- active working tree を Codex に自由編集させること
- approval prompt や危険操作を隠すこと

## Repository Shape

- `packages/core/`: config loading, safety policy, App Server/session handling,
  worktree isolation, normalized results
- `packages/cli/`: `codex-sidecar review|explore|work|opinion|risk-check|auditor`
- `packages/mcp/`: Claude Code などの MCP client から呼ぶ `codex_review` /
  `codex_explore` / `codex_work` / `codex_opinion` / `codex_risk_check` /
  `codex_auditor`
- `docs/`: 設計判断、protocol 方針、safety model
- `examples/`: consuming repo 側に置く `.codex-sidecar.yml` の例

## Ecosystem Context

設計時は以下の既存プロジェクトとの接続を常に意識する。

- `Relay`: Claude on iOS / Claude Code 間の会話・作業文脈を保存、検索、再開する MCP。
- `Throughline`: Claude Code の transcript / tool I/O を圧縮し、明示 handoff で継承する。
- `Caveat`: 罠、外部仕様の gotcha、repo-specific memory を markdown-in-git で保持する。
- `SmartClaude`: Claude Code の token / context / MCP tool 定義コストを計測、最適化する。
- `CodeGraph`: repository-local な symbol graph / semantic context を提供する。
- `image-generator`: OAuth 2.1 + MCP hub + stdio-to-HTTP proxy の実装知見を持つ。
- `IP-MCP`: official / unofficial source の分離、no fallback、quota-aware tool design の実例。

`codex-sidecar` はこれらを置き換えない。Codex を呼ぶための安全な実行境界、
結果正規化、worktree 隔離、App Server protocol 追従を担当する。

## Engineering Rules

- 既存差分はユーザーの作業として扱い、勝手に戻さない。
- `codex_work` は active working tree に直接書かせない設計を守る。
- 書き込み可能 workflow では `allowed_paths` を必須にし、`deny_paths` を尊重する。
- safety / config / prompt shaping は `packages/core` に寄せ、CLI と MCP は薄く保つ。
- protocol 追従や Codex App Server の lifecycle は `packages/core` に閉じ込める。
- 隠れたフォールバックで危険操作を進めない。失敗は明示的に返す。
- secrets / token / `.env` / OAuth DB / SQLite DB / hook config / deploy config は
  デフォルトで deny する方向を優先する。
- source の混同を避ける。official / unofficial / inferred / observed などの
  信頼境界がある場合は result schema に明示する。
- SmartClaude 的な観点で、Codex を呼ぶ価値、コスト、想定効果を結果に残せるようにする。

## Commands

想定コマンド:

```bash
rtk git status --short --branch
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

この環境では bare `pnpm` shim が PATH にない場合がある。`corepack pnpm` を使う。
勝手に別の package manager へ切り替えない。

RTK は Codex グローバル指示で導入済み。shell コマンドは原則 `rtk` を先頭につける。
正確な生出力が必要な検証では `rtk proxy <cmd>` を使う。

CodeGraph MCP は Codex グローバルに `codegraph` として登録済み。この
リポジトリの `.codegraph/` は初期化済みで、ローカル index として扱う。

## Current Notes

現在は CLI / MCP (stdio + Streamable HTTP) / read-only App Server / raw event log /
timeout control / worktree-backed `codex_work` / ecosystem context adapters /
explicit Codex model policy が実装済み。
MCP の HTTP transport は `CODEX_SIDECAR_MCP_TRANSPORT=http` で有効化し、
`Dockerfile` + `docker-compose.yml` で LAN bind の sidecar として
デプロイできる (詳細は README の LAN MCP セクション / docs/USAGE.md)。

まだ残っている主な穴:

- read-only result の workflow-specific structured fields は継続強化対象。
- Throughline / Caveat の完全な Codex 対応は各 upstream repository の作業。
  `codex-sidecar` ではまず reader/context adapter と fixture を扱う。
- HTTP transport は単一 Node プロセス内の in-memory session のみ。複数プロセス /
  マルチノードで共有する場合は `EventStore` を別途実装する必要がある。

## Related Docs

- [README.md](README.md): project overview and repository layout.
- [docs/README.md](docs/README.md): docs index and archive map.
- [docs/TODO.md](docs/TODO.md): durable task list, GitHub issues, and external coordination.
- [docs/CODEX_MODEL_POLICY_TODO.md](docs/CODEX_MODEL_POLICY_TODO.md): explicit Codex model policy plan and task list.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): package boundaries, layering, safety model, and result contract.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): Codex App Server protocol boundary and stable sidecar contracts.
