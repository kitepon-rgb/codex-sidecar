# 長時間 `codex_work` の切断耐性計画

Status: 緊急コンテキスト緩和完了・本修正契約は反証通過・Slice 0/1 完了・Slice 2 の耐久 auth/recovery 完了・async 実行統合を継続中
作成日: 2026-07-12  
対象: `codex_work`、MCP stdio/HTTP frontends、`packages/core` の実行境界  
優先度: P0  
正本: 本ファイルのみ

## 目的

長時間の `codex_work` を MCP request と stdio MCP process の寿命から切り離す。
Claude Code が終了・再起動・resume されても、caller が既知の idempotency key で同じ
run を再発見し、最終 `SidecarResult` または明示的な中断状態を回収できるようにする。

「接続断を起こさない」ことは完了条件ではない。接続断、start response 喪失、worker
crash を通常の故障モードとして扱い、曖昧な成功や hidden fallback を作らない。

## 緊急緩和 — GPT-5.6 context / compaction 上限

長時間taskの入力が272K tokensを越えて膨張する前にauto compactionを発火させるため、次を
先行適用する。これはMCP process切断の根本修正ではなく、長時間runのtoken消費と巨大context化を
抑える独立・可逆な緩和策である。

```toml
model_context_window = 272000
model_auto_compact_token_limit = 240000
```

適用scope:

1. user global `~/.codex/config.toml`。
2. trusted project override `.codex/config.toml`。
3. codex-sidecarが作るisolated `CODEX_HOME/config.toml`。既存のMCP/provider隔離を崩さず、上記2 key
   だけをglobal source configから明示allowlist継承する。

公式Codex config referenceで両keyがnumber型のtop-level setting、project-local overrideが
trusted projectでloadされることを確認済み。指定値そのものはowner指定を正とする。

- [x] `~/.codex`をbackupし、global configへ2 keyを重複なく追加する。
- [x] project-local `.codex/config.toml`へ同じ2 keyを追加する。
- [x] isolated Codex homeのminimal config allowlistへ2 keyを追加するcharacterization testを先に張る。
- [x] sidecar実装を更新し、MCP config等の非allowlist値を引き続きdropする。
- [x] TOML parse/config diagnostics、core test/typecheck/buildをgreenにする。
- [x] local core packageを安全にpackし、global CLI/MCP installのnested coreへ反映して実物確認する。

## 調査結論

主因は、Claude Code が spawn した stdio MCP server と、その子の Codex App Server が
親アプリの終了・再起動にライフサイクル結合していること。報告2件に加え同じ署名の
過去2件を確認した。4件とも inbound event の途中で JSONL が正常な改行境界のまま終わり、
`turn/completed`、`run/error`、`client/close`、`process/exit` が無い。

同じ `gpt-5.5/high`・`turnTimeoutMs=1,500,000` で15分27秒、16分12秒の正常完了例が
あるため、15分固定 timeout ではない。Claude Code 2.1.205 世代の stdio idle default は
30分で、対象 MCP config に短い per-server timeout も無い。progress は hard timeout を
延長せず、親 process kill を防げない。

原因クラスの確度は high。ただし正確な終了機構（SIGTERM、SIGKILL、process-tree kill、
pipe close の組み合わせ）は未観測である。

## 独立反証の裁定

refuter は初版計画を「採用不可」と判定した。detached worker の核心は生き残ったが、
次の blocking finding を反映しない限り実装へ進まない。

| Finding | 初版の破損経路 | 本版の裁定 |
| --- | --- | --- |
| start response 喪失 | spawn 後・response 到達前に切れると runId が永久喪失 | caller-supplied `idempotencyKey` を必須化し、runId を決定的に導出。retry は同一runを返す |
| spawn ≠ ready | import/manifest/log open直後にworkerが死んでもhandleを返す | worker `ready.json` とearly-exitを競争。ready前は成功応答しない |
| multi-writer競合 | state/heartbeat/reconcile/cancelがlast-writer-wins | immutable manifest/ready/cancel/result/terminalと単一writer heartbeatへ分離。immutable recordは完全書込後にatomic no-replace publish |
| worker死亡後の孤児 | App Serverがworktreeを書き続ける間にsalvage | worker process groupを記録し、group消滅確認前はsalvage禁止 |
| auth rotation競合 | 別project runが同じrefresh token snapshot/write-backを競合 | canonical `CODEX_HOME/auth.json` 単位のglobal auth leaseで全projectを直列化 |
| `preserveWorktree=false` | worktree削除後・result永続化前にkillされる | execution/collectionとcleanupを分離。terminal commit後だけcleanup |
| public型の混同 | running/interruptedを`SidecarResult.status`へ混在 | run controlは別のdiscriminated union。terminal payloadだけ既存`SidecarResult` |
| active tree汚染/秘密 | `<project>/.codex-sidecar/runs`がgit statusへ出る | `git rev-parse --git-common-dir`配下へ保存。全directory 0700/file 0600 |
| process groupの過信 | worker group消滅後も`setsid`等で離脱した孫がworktreeを書き得る | 異常終了後は自動salvage/path-policy評価/cleanupを常に禁止し、manual recoveryへ倒す |
| public contractの穴 | cancel shape、operation error、dry-run/terminal retry、CLI構文が未定 | 下記tool別unionとCLI構文をP0の固定契約にする |
| fake-green release | fake workerだけでは実際のClaude Code teardownを再現しない | real App Server kill試験と実Claude Code再起動試験を必須release gateへ戻す |

独立反証後の採用条件は、下記4契約を先に固定すること。

1. idempotency/recovery contract。
2. single-writer、lease generation、terminal commitを持つ状態機械。
3. App Server process groupとglobal auth rotationの所有権。
4. poll/cancel/interruptedのpublic tagged union。

## P0 の公開 contract

### `codex_work_start`

既存 `codex_work` と同じ work/safety inputに、`idempotencyKey` を必須追加する。

- keyはcallerが生成する22〜128文字のbase64urlまたはUUID相当。tool call引数として
  transcriptに残るため、responseを失ってもcallerは同じkeyを再送できる。
- `projectStoreIdentity`はgit common dirのcanonical identityとし、
  `runId = sha256(projectStoreIdentity + NUL + idempotencyKey)` でkeyから決定的に導出する。
- storeにはkey本文を残さずdigestだけを保存する。
- 同じkey・同じcanonical raw start input digestのretryは同じrunを返す。canonical raw inputは
  callerが再送できるtool/CLI引数へAPI固定defaultだけを適用したJSONで、config/presetから派生した
  normalized値や可変なgit解決結果を含めない。`projectRoot`はcanonical caller worktree pathへ正規化し、
  caller-supplied `baseRef`文字列（default `HEAD`）を含める。key本文はdigest対象外とする。
- store namespace、idempotency identity、execution snapshotを混同しない。新規runのpublish候補だけが
  `baseRef`を一度commit OIDへ解決し、winner manifestへimmutable execution sourceとして保存する。
  既存run発見時は現在の`HEAD`/`baseRef`を再解決せず、same raw digestならwinner manifestのOIDを返す。
  同じcommon dirでも別linked worktree path、または異なる明示`baseRef`文字列のsame-key requestは
  `RUN_KEY_CONFLICT`で拒否する。
- workerはcaller側の`HEAD`やbranch名を再解決せず、winner manifestに固定されたcommit OIDだけを
  `git worktree add`のbaseとして使う。
- 同じkey・異なるrequestは`RUN_KEY_CONFLICT`で拒否する。
- 既存runを発見したretryはconfigを再load/normalizeせず、winner manifest内のnormalized requestを正とする。
  `.codex-sidecar.yml`やpresetが実行中に変わってもresponse-loss recoveryを拒否しない。
- run directoryは完全なimmutable manifestを持つtemp directoryを作ってから、決定的runId
  pathへatomic publishする。並行startはpublish winnerのmanifestを再読する。
- manifest publish前にgeneration/token付き`launch.lock`をtemp directory内へ作る。publisherが
  publish後・spawn前に死んでもretryは同じrunを発見し、launch ownerの生存/heartbeatを確認する。
- retryがlaunchを引き継ぐ時はgenerationを増やし、新tokenでclaimする。旧workerはready作成前と
  auth/worktree side effect前にcurrent claimを再検証し、fenceされたら終了する。
- `dryRun=true` はworkerを起動せず、同じrun contractのterminal dry-run resultを作る。
- manifest publish後のMCP disconnect/`extra.signal`はrunをcancelしない。publish前のabortだけ中止する。

startの公開返却型は次のunionとする。`dryRun=true`、またはsame-key retry時にrunが既に
terminalなら`run_terminal`をその場で返す。`run_handle`だけを成功型と仮定しない。

```ts
interface SidecarRunHandle {
  kind: "run_handle";
  workflow: "work";
  runId: string;
  state: "starting" | "queued" | "running";
  createdAt: string;
  pollAfterMs: number;
}

type SidecarRunStartResult =
  | SidecarRunHandle
  | SidecarRunTerminal
  | SidecarRunInterrupted
  | SidecarRunOperationError;
```

coordinatorはNode `spawn` eventだけで応答しない。launch claimにはowner PID/token/generation、
heartbeat、spawn後のchild PIDを記録する。workerはpermit pipeを追加した状態でspawnし、permitを
受け取るまでmanifest/auth/worktreeへ一切触れない。coordinatorは完全な`spawn.json`をatomic publish
してからpermit pipeを閉じる。workerはpermit受信またはEOF時に`spawn.json`のtoken/generation/PIDを
再読し、一致するrecordが無ければ副作用前に終了する。これにより実spawn後・spawn record前に
publisherが死ぬ窓ではchildが自動停止し、record公開後のpublisher喪失ではworkerが継続できる。

permit検証後、workerはattempt固有boot markerを書き、
manifest検証、current launch claim再検証、signal handler設置、run-local log利用開始を済ませて
attempt固有`ready.json`をatomic no-replace publishする。ready marker、child early-exit、ready
timeoutを競争させる。publisher死亡時のretryは、owner不在だけで即stealせずboot graceを待ち、
spawned child/boot markerも不在または停止済みと確認してから次generationをclaimする。

launch recoveryを安全側に限定する。

- manifest publish後・spawn前、または実spawn後でも`spawn.json` publish前にpublisherが死んだ
  場合だけ、owner identity不一致、`spawn.json`不存在、boot grace経過、boot marker不存在を確認して
  次generationが自動引継ぎする。permit無しの旧childは副作用前に終了する契約でfenceする。
- spawn済みworkerがreadyを作らない場合、元coordinatorが有効な`ChildProcess` handleを保持中なら
  そのhandleから停止を要求し、exit確認後にdurable `READY_TIMEOUT`をcommitする。
- valid `spawn.json`公開後はworkerへownershipがdurable handoffされ、launcher ownerの死は異常判定に
  使わない。retry/pollはboot/ready/heartbeat/terminalを観測し、自動steal・signalを行わない。
- valid spawn後にready/heartbeatがstaleな場合の`orphaned`はterminal recordでなく観測上の
  quarantine stateである。pollは`pollAfterMs`を返し、遅延workerが後からready/terminalをcommitすれば
  pending/terminalへ遷移できる。自動path-policy/cleanup/salvageは引き続き禁止する。
- 旧generation workerはcurrent claim tokenを失った時点でside effectを始めない。side effect開始後の
  claim stealは禁止する。

### `codex_work_result`

inputは`projectRoot + idempotencyKey`。runIdを知っていてもkey無しcontrolはP0で許可しない。
resultは次のdiscriminated union。

```ts
interface SidecarRunTerminal {
  kind: "run_terminal";
  runId: string;
  state: "completed" | "failed" | "cancelled";
  result: SidecarResult;
  cleanup: "not-requested" | "pending" | "completed" | "failed";
}

interface SidecarRunInterrupted {
  kind: "run_interrupted";
  runId: string;
  state: "interrupted" | "orphaned";
  error: SidecarRunFailure;
  worktreePath?: string;
  processGroup: "stopped" | "alive" | "unknown";
  salvageAllowed: false;
  terminal: boolean;
  pollAfterMs?: number;
}

type SidecarRunPollResult =
  | { kind: "run_pending"; runId: string; state: "starting" | "queued" | "running";
      phase: string; heartbeatAt?: string; worktreePath?: string; pollAfterMs: number }
  | SidecarRunTerminal
  | SidecarRunInterrupted
  | SidecarRunOperationError;
```

- `SidecarResult.status`へ`running`や`interrupted`を追加しない。
- `result.json`が有効なら、terminal marker欠落時もcompleted/failedへ回復し、interruptedへ降格しない。
- heartbeat staleでもprocess groupがalive/unknownなら`orphaned`を返し、worktreeを走査しない。
- `orphaned`観測だけではterminal claimを作らない。late workerのvalid result/terminalを受理し、
  callerは`pollAfterMs`後に再pollする。operatorが下記manual recoveryでquarantine markerを作るまでは
  stateを不可逆に固定しない。
- manual recoveryは、operator確認後にcreate-only `quarantine.json`を先にpublishする。workerはpermit後、
  auth取得前、worktree作成前、App Server開始前にquarantineを再確認し、存在時は副作用前に終了する。
  既にApp Server開始markerがあるrunは自動quarantineせずmanual inspectionを要求する。
- 異常終了でworkerのclean shutdown/terminal commitを確認できないrunは、process groupが消滅しても
  P0では`salvageAllowed=false`とする。離脱した孫processを排除できないため、自動path-policy評価、
  worktree cleanup、patch採用を行わない。manual recoveryの手順と証拠pathだけ返す。

### `codex_work_cancel`

inputは`projectRoot + idempotencyKey`。返却はack-onlyの次の型とし、terminal状態は
`codex_work_result`で確認する。

```ts
interface SidecarRunCancelAck {
  kind: "run_cancel_ack";
  runId: string;
  accepted: boolean;
  terminal: boolean;
  state: "cancellation_requested" | "already_requested" | "already_terminal";
  mode: "pre_start_fenced" | "cooperative" | "terminal";
  pollAfterMs: number;
}

type SidecarRunCancelResult = SidecarRunCancelAck | SidecarRunOperationError;
```

- `cancel.json`はrun-levelの不可逆intentを表すcreate-only marker。要求時に観測したgenerationは
  診断値として残せるが、適用対象をそのgenerationへ限定しない。重複cancelはidempotent。
- terminal runへのcancelは`accepted=false, terminal=true`。
- running workerはcancel markerを検出し、`turn/interrupt`後にApp Serverをcloseする。
- pre-spawn launch takeover、cancel publish、workerの最初のexecution side effectは後述のrun transition
  leaseで線形化する。cancelが`execution-started.json`より先なら`mode="pre_start_fenced"`で、新generation、
  auth取得、worktree/App Serverを開始しない。execution startが先なら`mode="cooperative"`で、ackは
  interrupt intentの受理を意味し、既に開始済みのside effectがゼロとは保証しない。
- workerはpermit直後、auth lease待機中、lease取得直後、worktree作成前、App Server write-ahead marker前にも
  cancelを再確認する。auth待機はcancel-aware pollとし、pre-start cancel後に開始しない。
- current workerがcontrolを受け取れる間だけworker自身がApp Server/childを停止する。
- coordinatorが失われ、PID/PGID記録しかないstale workerへcontrol側からsignalしない。macOS/Linuxの
  PID/PGID再利用と離脱孫に対する安全なhandleが無いため、`orphaned`かつ`salvageAllowed=false`とする。
- cancel要求と自然完了が競合した場合、実際にcreate-only terminalを先取した結果を正とする。

全operation共通の失敗型を固定する。

```ts
type SidecarRunErrorCode =
  | "RUN_NOT_FOUND"
  | "RUN_KEY_CONFLICT"
  | "RUN_STORE_CORRUPT"
  | "RUN_READY_TIMEOUT"
  | "RUN_ORPHANED"
  | "RUN_AUTH_UNCERTAIN"
  | "RUN_UNSUPPORTED_PLATFORM"
  | "RUN_INVALID_INPUT"
  | "RUN_INTERNAL_ERROR";

// 既存SidecarError.code unionへSidecarRunErrorCodeの全値を追加する。
interface SidecarRunFailure extends SidecarError {
  code: SidecarRunErrorCode;
}

interface SidecarRunOperationError {
  kind: "run_error";
  runId?: string;
  error: SidecarRunFailure;
  retryable: boolean;
}
```

CLIは既存同期`codex-sidecar work`を維持し、P0では次を独立workflow名として追加する。

```text
codex-sidecar work-start  --project-root <path> --idempotency-key <key> [既存work flags]
codex-sidecar work-result --project-root <path> --idempotency-key <key>
codex-sidecar work-cancel --project-root <path> --idempotency-key <key>
codex-sidecar work-recover --project-root <path> --idempotency-key <key> \
  [--action quarantine --confirm-no-running-processes]
codex-sidecar work-auth-recover --project-root <path> --idempotency-key <key> \
  --strategy <write-back-run-local|keep-canonical-after-login|release-never-started|release-clean> \
  --confirm-no-running-processes
codex-sidecar auth-status
codex-sidecar auth-recover --session-id <id> \
  --strategy <write-back-run-local|keep-canonical-after-login|release-never-started|release-clean> \
  --confirm-no-running-processes
```

core API/tool inputのrecovery strategyも同じ4値enumとし、未知値は`RUN_INVALID_INPUT`で拒否する。

stdoutは各公開unionのJSONだけを出す。exit codeは`run_handle`/`run_pending`/successful
`run_terminal`/cancel ackを0、terminal failed/refusedと`run_error`を1、
`RUN_UNSUPPORTED_PLATFORM`を2とする。usage/parser errorは既存CLIどおり1とする。

`work-recover`は既定でread-only inspectionを返す。operatorが`--action quarantine`と
`--confirm-no-running-processes`を両方指定した時だけ、create-only `quarantine.json`をpublishし、
current generationをfenceしてからcreate-only interrupted terminalをcommitする。以後のpollは
`run_interrupted(terminal=true, salvageAllowed=false)`を返す。確認flagが無い、既に別terminalがある、
claim/tokenが変化した場合は変更しない。late workerは各side-effect境界のquarantine checkで終了し、
terminal競合に勝っていたvalid resultがある場合はそちらを正として降格しない。
stuck transition leaseがある場合は、そのowner不在とtoken/inode不変を確認し、operator確認付き操作の
監査recordを先に残してexact current hard-linkだけを解除する。その後、自身のtransition leaseを取得して
quarantineへ進む。token/inodeが変わった場合やowner生存時は変更しない。

`work-auth-recover`は異常終了runが保持するglobal auth lease専用のoperator commandである。

- 既定はread-only inspectionで、run journal、lease owner、canonical/run-local auth hash、候補strategyを
  JSON表示する。mutation用のstrategy/confirmation flagsが揃わない限りwrite-back/lease解除しない。
- `write-back-run-local`はrun-local authがvalid、canonicalがinitial hashのまま、対象runがcurrent lease
  owner、final hashがinitialと異なる、かつ`auth/run-local-rotation.json`のnew identity/hashと一致する
  時だけrun固有tempからatomic replaceする。validでも同一hash、in-place rewrite、rotation marker欠落は
  使用済みrefresh tokenの可能性があるため拒否する。
- `keep-canonical-after-login`はoperatorが`codex login`を完了し、canonical authがvalidかつinitial hash
  から変わった時だけ選べる。run-local tokenは採用しない。
- `release-never-started`はglobal lease recordのexact token/inodeとowner不在を再検証し、operatorが
  全関連process停止を確認し、`auth/app-server-started.json`が存在しない時だけauthを書き戻さず解除する。
  `lease-acquired.json`や`snapshot.json`が未作成でも、lease claimに埋め込んだowner kind/id/journal pathを
  監査recordへ残す。started marker欠落だけを自動解除の根拠にはしない。
- `release-clean`は`app-server-exited.json`、`auth-written-back.json`、`clean-shutdown.json`がすべてvalidで、
  canonical/final hash（initially absentならabsent sentinelを含む）がjournalと整合し、exact lease
  token/inodeが不変な時だけ、書き戻しを再実行せず解除する。
- 成功時はcreate-only `auth/operator-recovery.json`を監査記録としてpublishしてからleaseを解除する。
  hash競合、owner不一致、process停止確認なしでは`RUN_AUTH_UNCERTAIN`のままfail-closedする。

`auth-status`と`auth-recover --session-id`は、既存同期/read-only workflowが残したdurable auth session用の
同等contractである。statusはcurrent global leaseからowner kind/id/journal pathを列挙するだけで変更せず、
recoverは同じhash/rotation/confirmation条件と監査recordを満たした時だけexact lease tokenを解除する。

## 耐久ストレージと状態機械

git work対象のstore rootは`git rev-parse --path-format=absolute --git-common-dir`で解決し、
`<git-common-dir>/codex-sidecar/runs/<runId>/`に置く。active working treeは変更しない。

```text
<git-common-dir>/codex-sidecar/runs/<runId>/
├── manifest.json        # normalized request + canonical raw input/key digest
├── launch.lock/         # mkdir排他のcurrent launcher claim
│   ├── claim.json       # owner identity/token/generation
│   ├── heartbeat.json   # launcherだけがatomic replace
│   └── spawn.json       # child handle保有中にpublisherがcreate-only publish
├── attempts/<generation>-<token>/
│   ├── boot.json        # worker entrypoint到達
│   └── ready.json       # worker pid/pgid/generation/identity
├── heartbeat.json       # workerだけがatomic replace
├── transition/
│   ├── claims/<token>.json # 完全書込済み短期transition claim
│   └── current.json        # claim inodeへのatomic no-replace hard-link
├── cancel.json          # control側create-only、任意
├── execution-started.json # cancelとの線形化後、最初のside effect許可
├── quarantine.json      # operator確認済みmanual fence、任意
├── result.json          # worker create-only、lossless SidecarResult
├── terminal.json        # worker/recoveryの単一create-only terminal claim
├── cleanup.json         # terminal後のworktree cleanup結果
├── auth/
│   ├── snapshot.json            # canonical path identity、initial hash
│   ├── lease-acquired.json      # global lease token
│   ├── app-server-started.json  # spawn前write-aheadのauth消費可能性境界
│   ├── run-local-rotation.json  # atomic置換で回転済みと観測した証拠、任意
│   ├── app-server-exited.json   # owned handleでexit確認済み
│   ├── auth-written-back.json   # final/canonical hash
│   ├── clean-shutdown.json      # 正常auth lifecycle完了
│   └── operator-recovery.json   # manual解除の監査記録、任意
├── codex-home/          # crash recoveryまで残すrun-local isolated CODEX_HOME
├── worker.stdout.log
├── worker.stderr.log
└── app-server.jsonl
```

規則:

- run directoryは0700、全fileは0600。
- immutable JSONは最終名を`open(O_EXCL)`してから書かない。同一directoryのtemp fileへ0600で
  完全書込・flush・closeした後、POSIX hard-link等で最終名へatomic no-replace publishし、tempを消す。
  killがtemp書込中なら最終名は存在せずretry可能、publish後なら完全なinodeだけが見える。
- manifest/boot/ready/cancel/execution-started/quarantine/result/terminal/cleanupと全auth journal recordは上記
  create-only publishを使う。auth phaseをmutable snapshot一個へ上書きしない。
- 既存immutable recordがparse/hash検証に失敗した場合は上書き修復せず`RUN_STORE_CORRUPT`で
  fail-closedし、元fileを証拠として保持する。
- heartbeatのwriterは現generation workerだけ。
- run transition leaseはglobal auth leaseと同じ「完全なunique claim inode→固定current hard-link」の
  cross-process mutexとする。launch generation交代、cancel publish、execution-start publish、manual
  quarantineをこの短期lease内で直列化する。transition owner crash/current破損は自動reclaimせず
  nonterminal orphanへ倒し、operator確認付き`work-recover`だけが解除できる。
- `launch.lock/`の新規claimはatomic `mkdir`で一意にする。generation reclaimはtransition lease保持中に
  stale判定対象のlaunch claim inode/tokenを再読し、同一であることを確認してからattempt tombstoneへ
  atomic renameする。rename後のinode/tokenも元対象と一致した場合だけ新claimを設置する。不一致なら
  live claimを触らず中止する。自動stealは`spawn.json`不存在かつowner不在の場合に限定し、attempt
  directoryの最大generation+1を使う。spawn済み/side effect開始済みclaimは自動stealしない。
- workerはtransition lease内でcancel/quarantine/current generationを確認し、勝てた場合だけ
  global auth leaseのatomic claimを試みる。auth leaseがbusyならexecution markerを作らずtransitionを
  解放してqueuedへ戻る。auth claimに勝った時は`auth/lease-acquired.json`をwrite-ahead commitし、続いて
  `execution-started.json`をatomic publishしてからtransitionを解放する。cancel側も同じtransition lease内で
  terminal/execution markerを再読してintentをpublishするため、auth queuedを含むpre-start cancelと
  execution startには一意の先行関係ができる。lock順はrun transition→global authで固定する。
- terminal claimはatomic no-replace publish。後勝ち上書きは禁止。
- 全worker writeにgenerationを含め、異なるgenerationを拒否する。
- result作成後・terminal作成前のcrashでは、valid resultをterminalへ昇格する。
- terminal作成後だけworktree cleanupを開始し、成否をcleanup.jsonへ残す。
- P0はprocess crash耐性を対象とする。power-loss durabilityを名乗らず、fsync範囲は別途明記する。

## worker、process group、auth ownership

core package自身が`import.meta.url`相対でworker entrypointを解決し、`process.execPath`で起動する。
POSIXでは`detached:true`、親非接続stdio、`unref()`を使い、worker PIDをPGIDとして扱う。
App Serverはworkerのprocess groupを継承する。

P0 async pathはmacOS/Linuxに限定する。Windowsではprocess-group回収契約を満たせないため
`RUN_UNSUPPORTED_PLATFORM`でfail-closedし、既存同期`codex_work`は変更しない。

正常稼働中はworkerが自身の`ChildProcess` handleを所有し、cancel時にApp Serverへinterrupt/closeを
送りexitを待つ。外部recovery controllerはPID/PGID記録だけからsignalしない。macOS/Linuxにpidfd
相当の再利用不能handleがなく、`setsid`等でsession/groupを離脱した孫も完全列挙できないためである。
worker/launcher喪失後はprocess observationを診断表示にだけ使い、停止済み表示であっても
`salvageAllowed=false`を維持する。async promptにはbackground/daemon化をunsupportedと明記するが、
安全保証をpromptだけに依存しない。

Codex authはproject lockでは守れない。lease keyはauth内容digestではなく、canonical
`CODEX_HOME` directoryのreal pathと、その直下のintended `auth.json` path identityをhashしたものとする。
`auth.json`が不存在でも同じintended pathを使い、snapshotにはinitially absentのsentinelを残す。
canonical home directory自体が解決不能ならApp Serverを起動せず明示errorにする。codex-sidecar-owned user
cache内のglobal leaseを、auth snapshot作成からApp Server close、rotated auth write-back完了まで
保持し、全projectを直列化する。

global leaseはin-memory mutexにしない。user cacheの
`codex-sidecar/auth-leases/<canonical-path-hash>/`にunique tokenの完全なclaim JSONを0600で作り、
そのinodeを固定名`current.json`へPOSIX hard-linkするatomic no-replace claimとする。`link` winnerだけが
lease ownerで、claim JSONはlink前にowner kind/idとdurable journal pathを必ず含める。loserはcurrent
owner/tokenを読む。releaseはcurrent recordのtoken/inode一致を再検証して
unlinkし、token不一致/破損は`RUN_AUTH_UNCERTAIN`でfail-closedする。実OS別process競合testを必須にする。

lease参加対象はasync work workerだけでなく、sidecarが起動する**全App Server session**とする。
`review`、`explore`、同期`work`、`opinion`、`risk-check`、`auditor`、`generate`も共通
`DurableAuthSession`を経由し、`AppServerClient.start()`内の無管理temp snapshot/write-backを廃止する。

- async workはrun directory内のauth journal/codex-homeを使い、lease待機中は`queued`として返す。
- 既存同期/read-only callは、App Server起動前に
  `<user-cache>/codex-sidecar/auth-sessions/<sessionId>/`（0700、file 0600）へimmutable owner、同じauth
  phase journal、durable run-local codex-homeを作る。global lease owner recordはowner kind/idとjournal pathを持つ。
- 同期/read-only callでleaseが既にheldなら長いMCP request内で待たず、App Serverを起動せず
  `AUTH_LEASE_BUSY`（既存`SidecarError.code`へ追加）を明示返却する。async側はcancel-aware queueとする。
- 同期/read-only coordinatorがkillされた場合もsession directory/global leaseを残し、hashが整合しても
  自動解放しない。`auth-status`で発見し、上記`auth-recover --session-id`だけで明示回復する。
- 正常終了はasyncと同じwrite-ahead/rotation/write-back/clean marker順でleaseを解放する。clean済みsessionは
  retention対象として後でpruneできるが、P0では監査recordを即削除しない。

この直列化により、長いasync work中の短いread-only callが`AUTH_LEASE_BUSY`になるのはP0の明示的な
安全トレードオフである。隠れた無lease fallbackは作らない。

async workerのisolated CODEX_HOMEは削除前提のOS tempではなくrun-local `codex-home/`に置き、
initial auth hashを`auth/snapshot.json`へ残し、phase遷移は`auth/lease-acquired.json`、
`app-server-started.json`、`app-server-exited.json`、`auth-written-back.json`、
`clean-shutdown.json`のcreate-only journalで表す。正常終了時はglobal lease保持中にrotated authを
canonicalへatomic write-backしてからclean markerをcommitし、leaseを解放してrun-local authをcleanupする。

auth/App Server境界は次のwrite-ahead順序を変えない。

1. canonical auth path identityを解決する。async workerはrun transition lease保持下でcancelを再確認し、
   global leaseをatomic claimする。同期sessionは直接global leaseをclaimする。
2. lease tokenを`auth/lease-acquired.json`へcommitする。async workerはこの後
   `execution-started.json`をcommitしてrun transitionを解放する。
3. lease保持下でcanonical authをparse/copyし、initial hashを`auth/snapshot.json`へcommitする。
4. cancel/quarantine/current generationを再確認する。
5. `auth/app-server-started.json`を**App Server spawn前**にcommitする。このmarkerは「開始完了」でなく
   「この先authが消費済みかもしれない」というwrite-ahead境界である。
6. App Serverをspawnする。spawn失敗をowned workerが確認できた場合だけexited/clean journalへ進む。

lease claim直後・`lease-acquired.json`前後・snapshot前後を含む1〜6の各境界killをfault-injection
gateにする。`app-server-started.json`不存在だけを根拠に
外部recoveryがleaseを自動解放することはなく、abnormal worker lossは常にoperator recoveryへ送る。

workerはrun-local `auth.json`の初期file identity/hashを保持する。App Server実行中に新inodeへの
atomic置換を観測し、変更後JSONを二回連続で同じstat/hashとしてparseでき、かつfinal hashがinitialと
異なる場合だけcreate-only `auth/run-local-rotation.json`へold/new identityとhashを記録する。
in-place rewrite、同一hash、観測前worker killはabnormal write-backの証拠として採用しない。

workerがApp Serverのowned handleを保持する正常系のlease回収は次の順序を必須とする。

1. workerが所有するhandleでApp Server exitを確認し、`app-server-exited.json`をcommitする。
2. auth phaseがApp Server開始前なら安全にleaseを解放する。
3. App Server開始後ならrun-local authをparseし、initial/final/canonical hashを比較する。
4. canonicalがinitialのまま・finalがvalidにrotate済みなら、lease保持中にfinalをwrite-backする。
5. canonicalが既にfinalならno-op。外部login等で別値、final欠損/破損、判定不能なら
   `RUN_AUTH_UNCERTAIN`でfail-closedしleaseを自動解放しない。re-login/明示 recoveryを要求する。
6. `auth-written-back.json`、続いて`clean-shutdown.json`をcommitした後だけleaseを解放する。
   written-back後、clean後、lease unlink前の各killもfault-injection gateとし、journal完了後の残留leaseは
   operator-confirmed `release-clean`でexact token/inodeだけを解除できる。

current workerまたはそのowned App Server handleを喪失した場合は、離脱孫とauth使用中を排除できない
ため、hashが一見整合してもautomatic write-back/releaseを行わない。`RUN_AUTH_UNCERTAIN`とglobal leaseを耐久保持し、
operatorがprocess/authを確認して明示recoveryするまで同じcanonical auth pathの新runを拒否する。
valid `spawn.json`後のlauncher/coordinator喪失だけではこの条件に該当しない。workerはglobal leaseを
保持したまま正常継続し、Claude Code/MCP server終了をauth quarantine理由にしない。
明示recoveryは上記`work-auth-recover` contract以外のlock file手動削除を正規手順にしない。

auth write-back temp名はrun固有にし、固定`auth.json.codex-sidecar.tmp`を共有しない。

## worktree lifecycle

現行runnerを次の二段に分ける。

1. `executeWorktreeAppServerRequest`: plan/create/run/collect/allowed-path検証まで。cleanupしない。
2. `cleanupWorktreeExecution`: durable terminal commit後だけ、`preserveWorktree=false`ならremove。

既存同期`runWorktreeAppServerRequest`は二段を内部で直列実行し、外部挙動を保つ。async workerは
execution resultを`result.json`/`terminal.json`へcommitしてからcleanupし、結果を失わない。
async側のcreateはraw `baseRef`でなくwinner manifestのresolved commit OIDを必須入力にする。

## MCP Tasks / progress / version

- `@modelcontextprotocol/sdk@1.29.0`の通常`registerTool`はlegacy Tasksを禁止し、最新
  `2026-06-30` extensionとはwire非互換。P0でTasksへ結合しない。
- progressはdurabilityの代替でないためP0から外す。async start/result完成後のP1。
- `codex-sidecar --version`機能もP1へ移す。ただしworker entrypointを含むpacked tarball/global
  install smokeとpackage version整合はP0 release gateに残す。

## 実装TODO（正本）

### Slice 0 — 反証とcharacterization

- [x] 4件のabrupt log、正常反例、Claude transcript、timeout仕様を照合する。
- [x] 現行baseline: core 66 tests、MCP 11 tests、全3 package typecheck/build green。
- [x] 初版計画をrefuterに反証させ、blocking 8件を本版へ反映する。
- [x] revised contractをrefuterへ再提示し、blocking zeroを確認する。
- [x] response配送前切断と同一key並行startのcharacterizationを先に追加する。
- [x] spawn後ready前crashのcharacterizationを追加する。
- [x] config drift後same-key retryのcharacterizationを追加する。
- [x] spawn→spawn record間publisher crashのcharacterizationを追加する。
- [x] linked worktree path conflictとHEAD移動後retry/固定OID executionを追加する。
- [x] auth lease claim直後/clean直後crash recoveryを追加する。

### Slice 1 — store/public types

- [x] run tagged unionとrun error codesをcoreに追加する。
- [x] start/result/cancel/recoveryのtool別input contractをcoreに追加する。
- [x] caller-reproducible canonical raw input digestと、既存runではconfigを再loadしないlookup順を実装する。
- [x] common-dir store、再送可能raw identity、winner固定base commit execution snapshotを分離する。
- [x] git-common-dir resolver、deterministic runId、atomic directory publishを実装する。
- [x] manifestと同時公開する初期launch claim/heartbeat、privateなcreate-only record基盤を実装する。
- [x] atomic no-replace record publish、launch claim/steal、generation fencing、result→terminal recoveryを実装する。
- [x] cross-process run transition lease、ABA-safe launch reclaim、execution-start/cancel線形化を実装する。
- [x] unit tests: key conflict、concurrent start、publisher death、temp書込途中kill、corrupt final拒否、
  terminal競合、result/terminal間crash。

### Slice 2 — worker/process/auth

- [x] worker entrypoint、ready handshake、parent非接続logs、heartbeatを実装する。
- [x] POSIX process group identity/stop/消滅確認を実装する。
- [x] canonical path identity global auth lease、run-local Codex home、run固有auth write-backを実装する。
- [x] immutable auth phase journalと4 strategyの`work-auth-recover` inspection/明示解除を実装する。
- [x] OS process間global auth lease、spawn前write-ahead marker、atomic rotation observerを実装する。
- [x] 全同期/read-only App Server callをdurable auth sessionへ移し、`auth-status/recover`を実装する。
- [ ] `work-recover` read-only inspectionと明示quarantine/terminal recoveryを実装する。
- [ ] tests: ready前即死、publisher死亡引継ぎ、worker SIGKILL後descendant消滅、別project auth直列化、
  rotated auth clean recovery、abnormal killで`AUTH_UNCERTAIN`/lease保持。
- [ ] auth各write-ahead境界kill、未回転valid tokenのwrite-back拒否、cancel中auth待機をtestする。
- [x] auth不存在identity、lease claim直後の`release-never-started`、clean直後の`release-clean`をtestする。

### Slice 3 — worktree durability

- [x] worktree executionとcleanupを分離し、同期wrapperの挙動を保つ。
- [x] async result/terminal commit後だけ`preserveWorktree=false` cleanupを実行する。
- [ ] 実git tests: allowed/deny、active tree不変、preserve false ordering、cleanup crash recovery。

### Slice 4 — MCP/CLI async tools

- [ ] tool別Zod schema/parserと`codex_work_start/result/cancel`を追加する。
- [ ] auth recovery 4 strategyをcore API/tool/CLIの同一enumにし、全4値と未知値のparser testを追加する。
- [ ] start後disconnect非cancel、cancel ack、poll union、CLI exit codeを実装する。
- [ ] stdio/HTTPを跨いだsame-key recovery integration testを追加する。
- [ ] packed tarball/global installでworker entrypointとversion整合を検証する。

### Slice 5 — integration/review/docs

- [ ] coordinator SIGTERM/SIGKILL/stdio close後、新processからresultを取得する。
- [ ] spawn後・response配送前に切断し、same-key retryで同じrunIdを取得する。
- [ ] real Codex App Server実行中にcoordinatorをkillし、worker完了/結果回収を確認する。
- [ ] 実Claude Code stdio MCPでstartし、Claude Code終了・再起動後にsame-key resultを回収する。
- [ ] worker killで自動salvage/cleanupが行われず、auth leaseが明示回復まで保持されることを確認する。
- [ ] config変更後もsame raw start retryがwinner manifestから同じrunを返すことを確認する。
- [ ] refuter再監査、全tests/typecheck/build/package smokeを実行する。
- [ ] `README.md`、`USAGE.md`、`ARCHITECTURE.md`、`PROTOCOL.md`を更新する。
- [ ] 完了後、本計画を`docs/archive/`へ移し、`docs/TODO.md`を完了へ更新する。

## Release gate

1. same idempotency keyのretryは、start responseの配送有無に関係なく同じrunIdを返す。
   config/presetが変化していてもcanonical raw inputが同じならwinner manifestを再利用する。
   manifest publish後にcaller `HEAD`が移動しても現在値を再解決せず既存runを回収し、workerはmanifestの
   固定OIDから実行する。同じcommon dirでもcaller worktree pathまたは明示`baseRef`文字列が異なれば
   `RUN_KEY_CONFLICT`になる。
2. ready marker前にworkerが死に、元coordinatorがvalid `ChildProcess` handleでexit/停止を確認できる
   場合はaccepted handleを返さずdurable failureを返す。valid spawn後にcoordinatorも失われた場合は
   terminal化せずnonterminal orphanを返し、late completionまたはmanual recoveryを待つ。
3. immutable recordのtemp書込途中killでは最終名が出ず、publish後killでは完全JSONだけが出る。
4. publisherがmanifest公開後・spawn record前に死んでも、permit無しchildは副作用前に終了し、
   same-key retryが次generationを安全に起動する。valid spawn record後のowner喪失ではworkerが継続する。
5. concurrent start/terminal/cancelでcreate-only commitが一意。valid resultをinterruptedへ降格しない。
   pre-start cancelは全future generation/auth queued stateへ適用されside effect開始をfenceする。
   `execution-started.json`後のcancel ackはcooperative interruptであり、開始済みside effectゼロを名乗らない。
6. coordinator kill後もworkerが完了し、新しいstdio/HTTP sessionからterminal resultを取得できる。
7. current worker/owned App Server handle異常喪失後はprocess group表示に関係なく自動salvage/path policy/cleanupをしない。
8. 別projectの同時startでも同じcanonical auth pathのlifecycleが直列化される。
   既存同期/read-only callも同じleaseを迂回せず、held時は`AUTH_LEASE_BUSY`でApp Serverを起動しない。
9. clean shutdown時だけrotated authを安全に回収する。worker killでは`RUN_AUTH_UNCERTAIN`とglobal
   leaseを保持し、明示recovery前の新runをfail-closedする。
10. `preserveWorktree=false`でもresult/terminalが先に残り、cleanup成否を回収できる。
11. active working treeはrun state作成でdirtyにならず、all artifactsが0700/0600。
12. allowed/deny pathsとworktree isolationはasync pathでも同じ。
13. packed tarball/global installからworkerがreadyになり、全package runtime versionが一致する。
14. core/MCP/CLI tests、typecheck、build、package smokeがgreen。
15. real App Server coordinator-kill testと、実Claude Code終了/再起動same-key回収testがgreen。
16. abnormal auth leaseをread-only inspectionでき、確認flagsなしでは解除せず、4つの明示strategyだけが
    journalを残して安全に解除できる。`write-back-run-local`はinitialと異なるhash/atomic rotation
    marker無しでは拒否する。App Server開始前crashは`release-never-started`、clean journal完了後の
    unlink前crashは`release-clean`だけがexact lease token/inodeを解除できる。
17. orphan観測は非terminalでlate completionを受理し、明示`work-recover --action quarantine`だけが
    generation fence後にterminal interruptionへ遷移させる。
18. run transition leaseでlaunch reclaimのABAとpre-start cancel/execution startを線形化し、
    transition owner crashは自動reclaimせずmanual recoveryへ倒す。
19. auth file不存在でもcanonical homeのintended auth pathで全sessionが同じglobal leaseへ参加し、
    lease claim直後からunlink直前までの全kill境界にoperator-confirmed recoveryがある。

## P0で行わないこと

- kill済みCodex App Server turnのprotocol-level resume。
- worker自動再起動、generation 2以降のexecution resume。
- process groupがalive/unknownな状態での自動salvage。
- legacy MCP Tasks、progress notification、`--version` CLI機能。
- Windows async worker、multi-node EventStore、外部queue/daemon installer。
- active working treeへの自動apply/commit。

## 調査資料

- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [MCP Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview)
- [SEP-2663 Tasks Extension](https://modelcontextprotocol.io/seps/2663-tasks-extension)
- [Node.js child_process `options.detached`](https://nodejs.org/api/child_process.html#optionsdetached)
- repository-local raw snapshots: `rag/mcp-long-running/raw/`
