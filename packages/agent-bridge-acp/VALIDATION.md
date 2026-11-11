# P4 CodeBuddy validation — 2026-11-11

P4 implements an opt-in dialect, not a default-engine switch. Hermes and the
existing DSH behavior are unchanged. Initial source baseline: `cc5e82b176`. Final integration rebases onto
`9254a39731` (P3b DSH), with a fresh complete verification below.

## Deterministic checks

`tests/agent-bridge/codebuddy.test.ts` runs the real bridge against a separate
native fixture process. It covers both receipt orders (including coalesced
stdout and insertion/admission after the run boundary), both message-id locations, wrong admission owner, wrong insertion
owner, wrong session/id, each missing receipt, admission-only pending → unknown,
slash/image/unknown-content rejection, explicit queue fallback, probe text drift
and late old-run insertion. It also verifies ignored native cancel, explicit native
refusal, contradictory refusal/insertion and rejection of unknown fallback fields.
Successful and unknown deltas are fed through the real assembler and AppServer
projection, preserving native message id/run id or the unknown terminal state.
Three recording tests check allowlisted errors, cross-platform paths/credentials
and correlation-preserving opaque ids. The native wire must contain one main prompt and
one steer, with no implicit cancel/replay. Success evidence includes the actual
native message id and run owner.

| Check | Result |
| --- | --- |
| CodeBuddy deterministic fixture + recording policy | 21 + 3 passed |
| `npm run test:agent-bridge`, 10 consecutive runs | 197 passed each, 0 failures each |
| `npm run typecheck` (root) | passed after rebasing onto `9254a39731` |
| `npm run check:boundaries` | passed |
| Strict standalone smoke/recording script typecheck | passed |
| Final standalone bridge bundle + `node --check` | passed |
| Staged diff through `gitleaks detect --pipe --redact --no-banner` | no leaks found |

The test environment omits only the invalid exported Bash function name (see
implementation decisions). The source and lockfile do not change to achieve
these results. Independent review results are appended after completion.

## Real-account evidence: 未验（外部阻塞）

The installed CodeBuddy is 2.182.0. Its initialize succeeds. The no-model probe
returns `-32602`, message `Invalid params`, and string data
`Steer operation requires "sessionId"`; that is a supported probe result.

The installed account's model catalog/help includes `hy3-ioa`; the installed
product metadata lists it as x0.00 credits, the lowest price alongside the
synthetic Echo model. Hy3 is selected for the real task. No paid fallback model
is used. Native session creation returns `-32603 / Internal error`, with
`Request failed with status code 500`, both directly and through the independent
Host. This happens before any `session/prompt` or live steer. The Host attempt
uses a self-contained SHA-256-pinned bundle and the test process backend; its
recorded hash identifies that failed attempt, before final evidence projection
refinements. It does
not establish production sandbox isolation.

Recordings (redacted, no machine paths or credentials):

- [Host control-plane recording](../../design/agent-bridge/recordings/p4/codebuddy-host.json)
- [Single non-ACP control](../../design/agent-bridge/recordings/p4/codebuddy-non-acp-control.json)

Per the parent instruction, the same lowest-price model was tried exactly once
with `codebuddy -p`, tools/MCP disabled, and a minimal one-word prompt. Exit code
was 0, stdout empty, stderr `ENOENT: no such file or directory, open '<path>'`.
It produced no valid answer, so the control is inconclusive; it does not prove
that non-ACP works or that both modes share the HTTP 500 cause. No retry was
made. Read-only comparison with the installed compatibility adapter found the
same ACP `session/new {cwd, mcpServers:[]}` shape; model is supplied through the
CLI in the smoke. No unsupported parameter fix or account mutation was applied.

To repeat after account/service repair, explicitly choose the current cheapest
usable model, then run:

```sh
node --import tsx scripts/smoke/agent-bridge/p4-codebuddy-host.ts <model-id>
```

The script starts one minimal harmless sleep task, steers during the tool,
checks same-owner admission and same-run insertion, and refuses to mark success
without both. Existing failed recording must not be read as real double-receipt
acceptance. No real model consumption or Web/client integration is claimed.

## Integration with P3b

The DSH merge was rebased before delivery. Shared-file conflicts retained both
dialect ids and evidence upper bounds, DSH native withdrawal and its asynchronous
`AcpConnection.spawn()` lifecycle. CodeBuddy awaits that spawn before its private
probe. Its receipt observer, Stop handling and unknown-field gate run only for
CodeBuddy; DSH's side channel and settlement barrier remain unchanged. Native-id
evidence narrowing added by P4 is likewise scoped to CodeBuddy. Full-suite reruns
include DSH's cases. Dependencies are now an independent local copy, so removing
another worktree cannot invalidate this workspace's verification environment.

## Implementation decisions

- Reimplemented the user's confirmed CodeBuddy patch semantics in an independent
  module; did not copy the shared compatibility proxy or its retry/cancel loop.
- Evaluate admission and main-prompt completion in native wire order through the
  existing frame observer; Promise scheduling cannot move a late insertion back
  inside its run.
- Use `native-input-id`, with actual message id and run owner, rather than
  a stronger model-consumption claim; insertion is not proof of consumption.
  The shared assembler projects this kind to `context-confirmed` in the design
  document’s sense: a native run/context path, never model understanding.
- Latch one owner per native run and retain prior owners during the session so
  stale notifications cannot rebind a later run. Refuse injection before owner
  discovery; unknown content fields cannot silently disappear during parsing.
- Retain the generic one-unsettled-native-input limit. Stable ids improve
  evidence correlation here; increasing parallel admission is outside P4.
- Match the user's 3-second admission window; insertion has no arbitrary timer
  and must arrive before the target run ends. Unknown never chooses a fallback.
- For repeatable checks on this host, remove only the exported Bash function
  `BASH_FUNC_which%%` from the test command environment: it is not a valid sandbox
  environment name. No production environment validation is weakened.

## Deviation and remaining gap

Implementation and deterministic verification can complete independently of
account health. The required real tool-time steer/double receipt remains
**未验（外部阻塞）**. P4 is not full real-account acceptance; a later authorized
retest must supply both native receipts before that row can be closed.

## Independent review and P1 closure

One independent review of frozen commit `c0b984c332` accepted six findings.
The review initially required explicit dispatch authorization; after the parent
provided it, the configured simple route completed the review. No second review
or real model acceptance was substituted for that review.

| Finding | Resolution and regression |
| --- | --- |
| Insertion after native run end in the same stdout batch counted as delivered | Observe admission and the main prompt response synchronously through the existing native frame hook; before-end coalesced receipts succeed, post-end insertion/admission stays unknown. The new insertion-after-end regression failed on the reviewed source before this fix. |
| Stop could leave a native input pending when cancel is ignored | Finish the run's evidence tracking on Stop/close, independently of native cancellation acknowledgement; ignored-cancel fixture asserts an unknown outcome delta. |
| Explicit native RPC refusals were wrapped as unknown | Preserve native RPC errors when no insertion has been observed, matching generic classification; contradictory insertion/refusal remains unknown, without replay. |
| Explicit fallback silently dropped unknown fields | Validate CodeBuddy input fields before every delivery path; slash and images retain existing explicit fallback support. |
| Recorder could persist native paths/config/error text | Replace raw errors, content and metadata with allowlisted fields and fixed error categories; hash opaque ids consistently for correlation. Recording tests include macOS, Windows and shell-home paths and synthetic secrets. |
| Query-only checks missed delta/assembler evidence regressions and owner gate | Assert exact native id/run id in emitted deltas and the real assembler/AppServer projection, unknown outcomes without evidence, and refusal before native owner discovery. |

All six were accepted and fixed locally with targeted regressions. The review
thread was archived with an accepted decision. Final deterministic checks are
listed above; there is no claim of a second independent review of the fixes.

## P6 AGY

AGY validation is isolated in [P6 implementation and acceptance](../../design/agent-bridge/p6-agy.md), with its own sanitized recordings and decisions. P4 evidence and remaining gaps above are unchanged.

## 2026-11-11 P4 retry status

**未验**。本轮 CodeBuddy `session/new` 没有重试：前置旧 Codex 对照仍报 429，
触发任务步骤 1 的停止条件；步骤 2 要求先解决 429。此前 HTTP 500 仍未排除。
见[本机复查](../../apps/agent-bridge-host/VALIDATION-LIVE-RECHECK.md)。

## 2026-11-11 resumed P4 retry

**未验**。Codex 对照恢复后，`hy3-ioa` 经 Host 重试一次 session/new，仍返回
HTTP 500，未进入 prompt/steer；按要求没有继续深挖。
[重试证据](../../design/agent-bridge/recordings/live-recheck/codebuddy-retry.json)，
[续验范围](../../apps/agent-bridge-host/VALIDATION-LIVE-RESUME.md)。
