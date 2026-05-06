# Archived Handoff: Spotter Claude / Codex Dual Support

This was an external implementation brief for Spotter. It is archived here for
historical context. Check the Spotter repository and current `codex-sidecar`
docs before treating any item as active.

# Spotter: Claude / Codex 両対応計画

この文書は Spotter repository に貼り付けるための実装ブリーフです。目的は、Spotter を Claude Code と Codex の両方から安全に使える形へ育てることです。

## 目標

Spotter は agent-neutral な detection / reporting infrastructure になるべきです。

Claude-oriented workflow での既存動作は維持しつつ、Spotter findings を Codex が structured context として consume し、`codex-sidecar` 経由で machine-readable な risk / review result を返せるようにします。

目指す形:

- Spotter core は特定 agent に依存しない。
- Claude integration は first-class のまま維持する。
- Codex integration は adapter と execution option として追加する。
- 既存の Claude command、report format、hook、prompt を壊さない。

## 優先順位

1. この project 内で background Claude subagent が担っている作業を、適切な範囲で Codex sidecar に移す。
2. その次に、Spotter 本体を Claude だけでなく Codex にも対応させる。

最初の task は、自然に独立している background agent role を特定することです。audit、risk-check、second-pass review、scoped verification は Codex sidecar に向いています。

runtime environment で Codex が使えない場合は、現在の Claude subagent behavior をそのまま維持します。Codex adapter が存在するからといって、既存の Claude path を削ったり劣化させたりしないでください。

## Architecture 方針

概念上、次の layer に分けます。

| Layer | Responsibility |
|---|---|
| Agent-neutral core | scan input、detector、finding、severity、reference、report |
| Claude adapter | Claude-facing command、hook、prompt、report rendering |
| Codex adapter | `codex_risk_check`、`codex_review`、`codex_explore` 向け context block、structured result handling |
| Shared fixtures | Claude / Codex adapter の両方で使う scan fixture と expected report |

Spotter を Claude 実装と Codex 実装に分岐させないでください。detector / reporting core は 1 つに保ち、複数の agent adapter を持つ形にします。

## Codex Sidecar Integration

Spotter は findings を plain JSON context block として Codex に渡せます。専用 kind がまだない場合は、dedicated Spotter context kind を導入するまで `manual_note` または `codegraph_context` を使ってください。

Example:

```json
{
  "kind": "manual_note",
  "source": "spotter",
  "trust": "local",
  "summary": "Spotter found a high-risk OAuth callback surface and missing regression coverage.",
  "references": [
    {
      "path": "src/oauth/callback.ts",
      "line": 42,
      "label": "callback handler"
    }
  ],
  "data": {
    "detector": "oauth-callback-risk",
    "severity": "high",
    "ruleId": "SPOTTER-OAUTH-001"
  }
}
```

Codex-facing workflow では、Spotter findings を次の用途に使います。

- `codex_risk_check`: Spotter signal を deeper risk analysis に変換する。
- `codex_review`: Spotter findings を context に入れて diff を review する。
- `codex_explore`: detector が trigger した理由を調査する。
- `codex_opinion`: remediation plan を challenge する。
- `codex_work`: 明示的に許可された場合だけ、isolated worktree で小さな scoped fix を行う。

## Claude Behavior を守る

コード変更の前に、現在の Claude contract を特定して文書化してください。

- command name と argument
- report format
- detector output schema
- hook behavior
- prompt template
- markdown / JSON field name
- Claude behavior を表す test / fixture

Codex のために Claude report shape を変更しないでください。Codex projection を追加します。

## Background Subagent Shift

Spotter が現在 background Claude subagent に finding inspection、detector validation、risk classification、remediation proposal などを任せている場合、task が独立しているなら Codex sidecar を優先します。

Codex sidecar に向いている task:

- Spotter findings の second-pass risk analysis
- detector changes の review
- finding が参照する files の exploration
- fixture / test の小さな worktree-backed fix
- remediation plan への independent critique

Claude-specific command flow や active conversation state に依存する task は Claude primary のまま維持します。

## 懸念: Codex が Codex を呼ぶ場合

ユーザーが Claude から Spotter を使っている場合、この形には価値があります。

```text
Claude primary -> Spotter -> codex-sidecar -> Codex second opinion
```

一方、ユーザーが Codex から Spotter を使っている場合、次の形を無条件で行わないでください。

```text
Codex primary -> Spotter -> codex-sidecar -> Codex again
```

Codex-on-Codex は具体的な境界がある場合だけ使います。

- isolated worktree execution
- Spotter が必要とする structured `SidecarResult`
- diagnostics に必要な raw App Server log
- risk analyst / critic など明確に異なる prompt role
- independent second pass を明示的に要求された場合

これらがない場合、Spotter は findings を現在の Codex session に直接渡すべきです。

Recommended policy:

| Host agent | Sidecar choice |
|---|---|
| Claude | independent review、risk、exploration、scoped fix には Codex sidecar を優先 |
| Codex | isolation、durable structured result、explicit second-pass analysis がある場合のみ Codex sidecar を使う |
| Unknown / automation | explicit config を要求し、recursive delegation を推測しない |

Availability policy:

| Codex availability | Behavior |
|---|---|
| `unavailable` | `codex-sidecar` が存在しない、実行不能、この repo 向けに未設定、または diagnostics 失敗。既存の Claude subagent path を維持 |
| `configured` | `codex-sidecar diagnostics --project <repo>` が成功。request shaping、dry-run、docs、planned read-only integration は使ってよい |
| `operational` | `codex_explore` など read-only smoke が成功。approved review、explore、opinion、risk-check sidecar task に使ってよい |
| `work-capable` | `codex_work` smoke が成功し、allowed paths が設定済み。worktree-backed scoped edit に使ってよい |
| explicitly disabled | 既存の Claude subagent path を維持 |

これは hidden fallback ではありません。互換モードです。Codex が使えない環境では、現在の Claude-backed behavior を baseline とします。

「Codex が使える」の最小実用定義は、単に `codex` binary があることではありません。`codex-sidecar` が存在し、対象 repository で diagnostics を成功させられることです。`codex-sidecar` がない場合、Spotter は Codex unavailable と扱ってください。

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

- 既存の Claude command、report、hook、fixture を audit する。
- 現在の Claude behavior を固定する test を追加する。
- stable Spotter finding schema を特定する。
- Spotter-to-`SidecarContextBlock` conversion path を追加する。
- Codex context block と `SidecarResult` consumption の fixture snapshot を追加する。
- Claude primary、Codex primary、automation mode の docs を追加する。
- 不要な Codex-on-Codex recursion を防ぐ execution policy を追加する。
- background Claude subagent task を移す前に Codex availability check を入れる。sidecar absent または diagnostics failure なら Claude subagent compatibility mode。
- `codex-sidecar` read-only smoke を追加する。理想は `codex_risk_check`。

## Done Definition

Spotter が dual-supported になったと言える条件:

- 既存の Claude workflow が通る。
- Spotter findings を Codex が structured context として consume できる。
- Codex risk / review result を prose scraping なしで保存できる。
- Codex primary mode が意味のない recursive Codex delegation を避ける。
- Codex-unavailable environment では既存の Claude subagent behavior を維持する。
- いつ Codex sidecar が有用で、いつ current-agent direct handling がよいか docs に説明されている。
