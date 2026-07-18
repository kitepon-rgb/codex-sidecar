# ADR 0013: factory-diagnostics の完全JSON出力修理を受け入れる

Date: 2026-07-19

## Decision

`factory-diagnostics` の成功、正常なnot-ready、設定読込失敗の各経路を、stdoutの書込み完了後に
従来の終了コードで終了させる修理を受け入れる。読取側がpipeを閉じた場合は壊れたstdoutへ
失敗JSONを再書込みせず、未処理のEPIPE stackも出さずに終了コード1とする。

最初の案は小さいfixtureしか持たず旧実装でもtestが通ったため、ADR 0012で棄却した。再作業では
65 KiBを超える実CLIのnot-ready JSONを100 ms読まずにpipeへ詰める回帰testを追加し、書込み完了を
待たない旧実装が再発し得る条件を固定した。EPIPE testは外部の`bash`や`head`へ依存せず、Nodeの
子process pipe読取側を閉じて検証する。

受入対象の実装commitは`a55c441`である。

## Verification

- `corepack pnpm --filter codex-sidecar-cli test`: passed
- `corepack pnpm build`: passed
- build済みCLIの`factory-diagnostics`を実projectへ実行し、`jq`で完全JSONを確認: passed
- `git diff --check`: passed

pack、fresh install、version更新、registry publish、global install、公開後smokeは未実施であり、
このDecisionでは完了扱いにしない。

## Follow-up

監査で、通常の`diagnostics`やworkflow結果にも同じ「JSON出力直後のprocess exit」が残り、
大きな出力で終了コード0のままJSONが途中切れすることを再現した。これは今回のfactory専用修理とは
別のP1として、共通JSON出力処理へ全machine-readable CLI経路を寄せてからrelease gateへ進める。
