# Archived Handoff: Throughline Claude / Codex Dual Support

This was an external implementation brief for Throughline. It is archived here
for historical context. Check the Throughline repository and current
`codex-sidecar` docs before treating any item as active.

# Throughline: Claude / Codex 両対応計画

この文書は Throughline repository に貼り付けるための実装ブリーフです。目的は、Throughline を Claude Code と Codex の両方から安全に使える形へ育てることです。

## 目標

Throughline は agent-neutral な handoff / context compression infrastructure になるべきです。

Claude Code transcript と handoff behavior は守りつつ、`codex-sidecar` 経由で Codex に渡せる compact context も生成できるようにします。

目指す形:

- Throughline core は特定 agent に依存しない。
- Claude transcript support は first-class かつ stable のまま維持する。
- Codex support は `throughline_handoff` context block を出す adapter として追加する。
- 既存の Claude handoff behavior を壊さない。

## 優先順位

1. この project 内で background Claude subagent が担っている作業を、適切な範囲で Codex sidecar に移す。
2. その次に、Throughline 本体を Claude だけでなく Codex にも対応させる。

Claude transcript handling の置き換えから始めないでください。まず、review、risk-check、second-pass interpretation に向いた独立 background task を特定し、Codex へ委譲できるものを選びます。

runtime environment で Codex が使えない場合は、現在の Claude subagent behavior をそのまま維持します。Codex adapter が存在するからといって、既存の Claude path を削ったり劣化させたりしないでください。

## Architecture 方針

概念上、次の layer に分けます。

| Layer | Responsibility |
|---|---|
| Agent-neutral core | handoff record、compression output、reference、persistence、validation |
| Claude adapter | Claude Code transcript parsing、tool I/O assumption、Claude handoff command |
| Codex adapter | `throughline_handoff` context block、`codex-sidecar` request shaping、result capture |
| Shared fixtures | Claude / Codex adapter の両方で使う handoff example と expected output |

Codex path が Claude internals を parse するのは、それが明示的に adapter の責務である場合だけにしてください。core は stable handoff object を扱うべきです。

## Codex Sidecar Integration

Codex 向けには、Throughline が `codex-sidecar` contract に合う plain JSON context block を生成します。

```json
{
  "kind": "throughline_handoff",
  "source": "throughline",
  "trust": "local",
  "summary": "Compressed handoff summary for the next agent pass.",
  "references": [
    {
      "path": "docs/handoff.md",
      "line": 18,
      "label": "handoff source"
    }
  ],
  "data": {
    "sessionId": "optional-session-id",
    "intent": "continue implementation",
    "constraints": ["preserve Claude transcript contract"]
  }
}
```

Codex-facing workflow では、この context block を次の用途に使います。

- `codex_explore`: previous handoff context を使って repo question に答える。
- `codex_review`: last handoff を intent として current changes を review する。
- `codex_opinion`: handoff に含まれる plan を challenge する。
- `codex_risk_check`: handoff が触れている risky area を確認する。
- `codex_work`: isolated worktree で小さな scoped task を続行する。

## Claude Behavior を守る

コード変更の前に、現在の Claude contract を特定して文書化してください。

- transcript file shape
- tool input / output parsing assumption
- compaction format
- handoff markdown / JSON schema
- command name と argument
- resume behavior
- Claude session がまだ動くことを示す test / fixture

Codex のために既存の Claude-facing field を rename しないでください。必要なら Codex adapter projection を追加します。

## Background Subagent Shift

Throughline が現在 background Claude subagent に summarization audit、handoff review、continuity check、risk analysis などを任せている場合、task が Claude の active conversation から独立できるなら Codex sidecar を優先します。

Codex sidecar に向いている task:

- handoff が actionable か review する。
- handoff の missing assumption を洗い出す。
- 作業継続前に handoff を risk-check する。
- referenced files を explore し、handoff claim を検証する。
- 小さな handoff fixture / docs fix を worktree で実装する。

Claude transcript semantics を live に扱う必要がある task は Claude primary のまま維持します。

## 懸念: Codex が Codex を呼ぶ場合

ユーザーが Claude から Throughline を使っている場合、この形には価値があります。

```text
Claude primary -> Throughline -> codex-sidecar -> Codex second opinion
```

一方、ユーザーが Codex から Throughline を使っている場合、次の形を無条件で行わないでください。

```text
Codex primary -> Throughline -> codex-sidecar -> Codex again
```

Codex-on-Codex が有効なのは、sidecar に別の境界がある場合だけです。

- isolated worktree から実行される。
- durable `SidecarResult` を生成する。
- diagnosis 用の raw App Server log を書く。
- critic / reviewer / risk-analyst など prompt role が明確に違う。
- independent second pass として明示的に要求されている。

別の境界がないなら、Throughline は別の Codex に委譲せず、現在の Codex session に handoff を直接 consume させてください。

Recommended policy:

| Host agent | Sidecar choice |
|---|---|
| Claude | independent review、risk、exploration、scoped continuation には Codex sidecar を優先 |
| Codex | isolation、structured result capture、explicit second-pass review がある場合のみ Codex sidecar を使う |
| Unknown / automation | implicit recursion ではなく明示 config を要求 |

Availability policy:

| Codex availability | Behavior |
|---|---|
| `unavailable` | `codex-sidecar` が存在しない、実行不能、この repo 向けに未設定、または diagnostics 失敗。既存の Claude subagent path を維持 |
| `configured` | `codex-sidecar diagnostics --project <repo>` が成功。request shaping、dry-run、docs、planned read-only integration は使ってよい |
| `operational` | `codex_explore` など read-only smoke が成功。approved review、explore、opinion、risk-check sidecar task に使ってよい |
| `work-capable` | `codex_work` smoke が成功し、allowed paths が設定済み。worktree-backed scoped edit に使ってよい |
| explicitly disabled | 既存の Claude subagent path を維持 |

これは hidden fallback ではありません。互換モードです。Codex が使えない環境では、現在の Claude-backed behavior を baseline とします。

「Codex が使える」の最小実用定義は、単に `codex` binary があることではありません。`codex-sidecar` が存在し、対象 repository で diagnostics を成功させられることです。`codex-sidecar` がない場合、Throughline は Codex unavailable と扱ってください。

Preferred health check:

```bash
codex-sidecar diagnostics --project <repo> --preset review
```

Development-path health check:

```bash
node /home/kite/projects/codex-sidecar/packages/cli/dist/index.js diagnostics \
  --project <repo> \
  --preset review
```

## Implementation Checklist

- 既存の Claude transcript / handoff contract を audit する。
- adapter 変更前に、現在の Claude behavior を固定する test を追加する。
- stable handoff object がまだない場合は追加する。
- `throughline_handoff` 用の Throughline-to-`SidecarContextBlock` conversion path を追加する。
- Codex context block の fixture snapshot を追加する。
- Claude primary / Codex primary mode の docs を追加する。
- Codex-on-Codex recursion を避ける host-agent detection または explicit config を追加する。
- background Claude subagent task を移す前に Codex availability check を入れる。sidecar absent または diagnostics failure なら Claude subagent compatibility mode。
- sample handoff を使った read-only `codex-sidecar` smoke を追加する。

## Done Definition

Throughline が dual-supported になったと言える条件:

- 既存の Claude transcript / handoff behavior が通る。
- Codex が `throughline_handoff` context block を受け取れる。
- Throughline が Codex の structured result を保存または link できる。
- Codex primary mode が実質的な境界なしに recursive delegation しない。
- Codex-unavailable environment では既存の Claude subagent behavior を維持する。
- Claude、current Codex、Codex sidecar の使い分けが docs に説明されている。
