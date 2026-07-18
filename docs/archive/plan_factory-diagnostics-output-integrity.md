# factory-diagnostics stdout完全性修理plan

Status: completed on 2026-07-19 with release `v0.3.8`.

## 目的

実CLIの `factory-diagnostics` がready JSONを最後までflushせずexit 0になる欠陥を修理し、
machine-readable診断契約を復旧する。

## 成功条件

- [x] 実CLIのready出力をpipeして `JSON.parse` / `jq` できる
- [x] readyはexit 0、not-ready / unverifiedは既存契約どおり非0を維持する
- [x] process終了直前のstdout flushを、pipe容量を超える65KiB超の実CLI出力を遅延読取する回帰testで固定する
- [x] focused test、関連CLI test、buildがgreen
- [x] 0.3.8のpackaged smokeがgreen（pack / fresh local-prefix install実施）
- [x] 0.3.8のroot/core/CLI/MCP versionとCLI/MCPのcore workspace依存を整合し、lockfileを更新する
- [x] 0.3.8のpublish、global install、公開後smokeの証跡を記録する

## 境界

- factory diagnosticsのJSON shapeやprivacy境界を変更しない
- workflow実行、Codex agent起動、active worktreeへのsidecar writeは行わない
- publish / global install / pushは目的・影響・rollbackを明示した承認境界として扱う

## 監査で判明した同根P1

`factory-diagnostics`の修理監査中に、通常の`diagnostics`へ大きなpromptを渡すと、終了コード0の
ままstdoutが65,536 byteで切れ、JSONとして読めないことを再現した。workflow結果を含む他の
machine-readable出力も`printJson`直後に`process.exit`する同じ根本原因を持つ。

- [x] 全JSON-producing CLI pathsを、write完了後に終了する共通経路へ統一する
- [x] 大容量`diagnostics`を実processのpipeで回収し、完全JSONと終了コード0を固定する
- [x] factory診断の大容量・EPIPE・privacy回帰を維持する
- [x] CLI testとworkspace buildをgreenにする
- [x] pack / fresh install / publish / global install / 公開後smokeをrelease gateで閉じる

## 0.3.8 release台帳（完了）

- [x] root、core、CLI、MCPを`0.3.8`へ揃え、CLI/MCPの
  `codex-sidecar-core` workspace依存も`workspace:0.3.8`へ揃える
- [x] `corepack pnpm install --lockfile-only`でworkspace lockfileを整合する
- [x] `corepack pnpm -r typecheck`を通す
- [x] release preflightとしてdirty treeとstashを確認し、npm registryでcore / CLI /
  MCPの`0.3.8`座標がいずれも未公開であることを確認する
- [x] core build、core / CLI / MCPの全test、workspace全体のtypecheckとbuildを通す
- [x] 全packageのpack dry-runとtarball manifestでregistry-safeな
  `codex-sidecar-core@0.3.8`依存を確認する
- [x] scoped publication commitを作成してpushし、remote `origin/main`がexact SHAを指すことと、
  そのSHAのCIがgreenであることを確認する
- [x] core → CLI → MCPの順に`0.3.8`をpublishし、各registry座標を確認する
- [x] Docker HTTP initializeをsmokeする（永続hostへのdeployは行わない）
- [x] fresh registry installでCLIのversion、MCP initialize、factory-diagnosticsをsmokeする
- [x] global install後にCLIのversionとMCP initializeがともに`0.3.8`を返すことをsmokeする
- [x] verified publication SHAへannotated tagとGitHub Release `v0.3.8`を作成する
- [x] 最終公開証跡を記入し、planをarchiveしてindex / overviewを更新する
- [x] bookkeeping commitをpushし、tag commitが`origin/main`の祖先であることを確認する
- [x] rollback方針を記録する。npm公開済みversionはunpublishせず、部分公開または
  不具合時は3 packageを同一の後続patch versionで是正する

## Completion Evidence

- Publication commit: `92a61198558df3e261c7d3a9e029877939db3d1a`。最初の
  `c2f25b6`に対するCIはNode 24のSQLite experimental warningをアプリstderrと誤認する
  testで失敗したため、既知の定型warningだけを区別するfocused fixを追加した。
- Exact-SHA CI: GitHub Actions run
  [29664703626](https://github.com/kitepon-rgb/codex-sidecar/actions/runs/29664703626)
  がpublication commitに対してsuccess。
- Repository gates: core 268 tests、CLI 32 tests、MCP 19 tests、workspace typecheck /
  buildがgreen。Node 24でCLI 32 testsもgreen。
- Packed artifacts: core / CLI / MCPのtarballをpublication commitから再生成し、
  CLI / MCPの依存がregistry-safeな`codex-sidecar-core@0.3.8`であることを確認。
  fresh local-prefix installのCLI、MCP initialize、factory-diagnosticsもgreen。
- Registry: `codex-sidecar-core@0.3.8` → `codex-sidecar-cli@0.3.8` →
  `codex-sidecar-mcp@0.3.8`の順にpublishし、3座標を再照会して確認。
- Post-publication smoke: 一時Colima VM上のDocker HTTP initialize、fresh registry install、
  このMacのglobal CLI / MCP / factory-diagnosticsがすべて`0.3.8`。一時containerを削除し、
  Colimaは元の停止状態へ戻した。
- Release: annotated tagと
  [GitHub Release v0.3.8](https://github.com/kitepon-rgb/codex-sidecar/releases/tag/v0.3.8)
  はpublication commitへ束縛した。

## Rollback

npm公開済みversionはimmutableとして扱い、unpublishや履歴改変を行わない。部分公開または
公開後不具合では3 packageを同一の上位patch versionへ揃える。このMacのglobal installだけを
戻す場合は、core / CLI / MCPを明示的に`0.3.7`指定で再インストールする。
