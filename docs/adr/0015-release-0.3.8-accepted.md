# ADR 0015: 0.3.8の公開を受け入れる

Date: 2026-07-19

## Decision

完全JSON出力修理を含む`codex-sidecar` 0.3.8の公開を受け入れる。公開commitは
`92a61198558df3e261c7d3a9e029877939db3d1a`であり、annotated tagと
[GitHub Release v0.3.8](https://github.com/kitepon-rgb/codex-sidecar/releases/tag/v0.3.8)
を同commitへ束縛する。

npm packageは`codex-sidecar-core`、`codex-sidecar-cli`、
`codex-sidecar-mcp`の順に0.3.8を公開した。CLI / MCPのtarballは
registry-safeな`codex-sidecar-core@0.3.8`へ依存する。

## Verification

- publication commitに対するGitHub Actions run
  [29664703626](https://github.com/kitepon-rgb/codex-sidecar/actions/runs/29664703626) がsuccess
- core 268 tests、CLI 32 tests、MCP 19 tests、workspace typecheck / buildがgreen
- Node 24でCLI 32 testsがgreen
- fresh packed installとfresh registry installでCLI、MCP initialize、
  factory-diagnosticsが0.3.8
- 一時Docker HTTP initializeが0.3.8。container削除後、検証用Colima VMを停止
- このMacのglobal CLI、MCP initialize、factory-diagnosticsが0.3.8
- 3 npm registry座標、annotated tag、GitHub Releaseを再照会して確認

最初のrelease commit `c2f25b6`に対するCIは、Node 24が出す既知のSQLite
experimental warningをアプリstderrと誤認するtestで失敗した。npm公開前に停止し、定型warning
だけを区別してその他のstderrを引き続き拒否する修理を`92a6119`へ追加した。公開はその
exact-SHA CIがgreenになった後だけ実施した。

完了した詳細台帳は
[plan_factory-diagnostics-output-integrity.md](../archive/plan_factory-diagnostics-output-integrity.md)
を参照する。

## Rollback

npm公開済みversionはimmutableとして扱い、unpublishや履歴改変を行わない。不具合時はcore /
CLI / MCPを同一の上位patch versionへ揃える。global installだけを戻す場合は3 packageを
`0.3.7`指定で再インストールする。
