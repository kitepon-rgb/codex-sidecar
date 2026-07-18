# factory-diagnostics stdout完全性修理plan

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
- [ ] 0.3.8のpublish、global install、公開後smokeの可否と証跡を記録する（本taskでは未実施）

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
- [ ] pack / fresh install / publish / global install / 公開後smokeをrelease gateで閉じる

## 0.3.8 release台帳（公開準備中）

- [x] root、core、CLI、MCPを`0.3.8`へ揃え、CLI/MCPの
  `codex-sidecar-core` workspace依存も`workspace:0.3.8`へ揃える
- [x] `corepack pnpm install --lockfile-only`でworkspace lockfileを整合する
- [x] `corepack pnpm -r typecheck`を通す
- [x] release preflightとしてdirty treeとstashを確認し、npm registryでcore / CLI /
  MCPの`0.3.8`座標がいずれも未公開であることを確認する
- [x] core build、core / CLI / MCPの全test、workspace全体のtypecheckとbuildを通す
- [x] 全packageのpack dry-runとtarball manifestでregistry-safeな
  `codex-sidecar-core@0.3.8`依存を確認する
- [ ] scoped publication commitを作成してpushし、remote `origin/main`がexact SHAを指すことと、
  そのSHAのCIがgreenであることを確認する
- [ ] core → CLI → MCPの順に`0.3.8`をpublishし、各registry座標を確認する
- [ ] Docker HTTP initializeをsmokeする（永続hostへのdeployは行わない）
- [ ] fresh registry installでCLIのversion、MCP initialize、factory-diagnosticsをsmokeする
- [ ] global install後にCLIのversionとMCP initializeがともに`0.3.8`を返すことをsmokeする
- [ ] verified publication SHAへannotated tagとGitHub Release `v0.3.8`を作成する
- [ ] 最終公開証跡を記入し、planをarchiveしてindex / overviewを更新する
- [ ] bookkeeping commitをpushし、tag commitが`origin/main`の祖先であることを確認する
- [ ] rollback方針を記録する。npm公開済みversionはunpublishせず、部分公開または
  不具合時は3 packageを同一の後続patch versionで是正する
