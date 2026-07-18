# ADR 0012: factory-diagnostics のflush修理を回帰test不足で再作業する

Date: 2026-07-19

## Decision

最初の実装案は、`factory-diagnostics` がJSONのstdout書込み完了を待ってから終了する点では
実機smokeを満たした。しかし追加testは既存fixtureへの末尾改行assertだけで、旧実装でも通る。
「process終了直前のstdout flushを回帰testで固定する」という受入条件を満たさないため、
このWorker成果は受け入れず、同じTaskの新しいretry Runで次を行う。

- 本番の出力helperを使い、pipeの容量を超える大きなJSONを子processから出す。
- 旧実装の即時`process.exit`では不完全出力になり、修正版では完全なJSONになる対照を固定する。
- readyと失敗の既存factory診断test、終了コード、privacy境界を維持する。
- stdoutの`error` eventを未処理にしない設計にする。

version bump、publish、global install、公開後smokeは、修理の受入後に別のrelease gateとして扱う。
未実施のまま成功条件を完了扱いにしない。

## Evidence

- 旧実装相当の1,364 byte出力は、このhostで100回すべて完全出力となり、現fixtureでは欠陥を
  再現しなかった。
- 旧実装相当の1,000,001 byte出力は20回すべて65,536 byteで途切れた。
- 最初の実装案のwrite callback待ちは、同じ大容量対照を20回すべて完全出力した。
- `packages/cli/src/index.test.ts` の既存testは修正前から`JSON.parse`と完全object比較を行っており、
  末尾改行assertの追加だけでは新しい回帰保証にならない。

## Consequences

最初のWorker Reportと変更は履歴から消さない。成果を棄却した後、新しいRunが同じ変更を
必要に応じて修正・拡張する。旧Runを再dispatchしたことにはしない。
