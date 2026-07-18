# Codex implementer routing smoke（2026-07-19）

- agent path: `/root/sidecar_diag_impl`
- role: `implementer`
- model: `gpt-5.6-terra`
- effort: `medium`
- developer instructions: applied
- verifier: `routing-check: OK`
- sandbox: actual `danger-full-access`。role TOML期待値との差はrouting判定から分離した。

子の自己申告はroleを`default`、model / effortを継承と述べたが、Codex rolloutを読む親側verifierは
上記の実効値を確認した。Controlのexecutor証拠には親側verifierだけを採用する。
