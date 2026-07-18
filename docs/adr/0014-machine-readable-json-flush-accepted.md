# ADR 0014: 全machine-readable CLIの完全JSON出力修理を受け入れる

Date: 2026-07-19

## Decision

`diagnostics`、非同期work操作、auth操作、factory error store、通常workflow結果を含む全ての
machine-readable CLI出力を、stdoutの終了完了後に終了コードを設定してreturnする共通経路へ
統一した修理を受け入れる。実装commitは`736e0fd`である。

即時`process.exit`と例外sentinelは使わない。正常・失敗の各分岐はJSON書込み完了をawaitした後に
returnする。pipe読取側が閉じた場合は壊れたstdoutへ再出力せず終了コード1とする。

## Verification

- 100,000文字のpromptを含む`diagnostics`を実process pipeで完全JSONとして回収し、exit 0を確認
- factory診断の65 KiB超not-ready、EPIPE、privacy境界を維持
- factory設定失敗、auth引数エラー、async work lookupエラーでstderrが空
- CLI test 32件、workspace build、`git diff --check`がgreen

pack、fresh install、version更新、registry publish、global install、公開後smokeはrelease gateで
別途閉じる。未実施のまま公開済みとは扱わない。
