# factory-diagnostics stdout完全性修理plan

## 目的

実CLIの `factory-diagnostics` がready JSONを最後までflushせずexit 0になる欠陥を修理し、
machine-readable診断契約を復旧する。

## 成功条件

- [x] 実CLIのready出力をpipeして `JSON.parse` / `jq` できる
- [x] readyはexit 0、not-ready / unverifiedは既存契約どおり非0を維持する
- [x] process終了直前のstdout flushを、pipe容量を超える65KiB超の実CLI出力を遅延読取する回帰testで固定する
- [x] focused test、関連CLI test、buildがgreen
- [ ] build後のpackaged smokeがgreen（pack / fresh install未実施）
- [ ] version bump、publish、global install、公開後smokeの可否と証跡を記録する（本taskではすべて禁止範囲のため未実施）

## 境界

- factory diagnosticsのJSON shapeやprivacy境界を変更しない
- workflow実行、Codex agent起動、active worktreeへのsidecar writeは行わない
- publish / global install / pushは目的・影響・rollbackを明示した承認境界として扱う

## 監査で判明した同根P1

`factory-diagnostics`の修理監査中に、通常の`diagnostics`へ大きなpromptを渡すと、終了コード0の
ままstdoutが65,536 byteで切れ、JSONとして読めないことを再現した。workflow結果を含む他の
machine-readable出力も`printJson`直後に`process.exit`する同じ根本原因を持つ。

- [x] 全machine-readable CLIのJSON出力を、write完了後に終了する共通経路へ統一する
- [x] 大容量`diagnostics`を実processのpipeで回収し、完全JSONと終了コード0を固定する
- [x] factory診断の大容量・EPIPE・privacy回帰を維持する
- [x] CLI testとworkspace buildをgreenにする
- [ ] pack / fresh install / version更新 / publish / global install / 公開後smokeをrelease gateで閉じる
