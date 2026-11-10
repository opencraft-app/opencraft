# P4 CodeBuddy validation — 2026-11-11

P4 implements an opt-in dialect, not a default-engine switch. Hermes and the
parallel DSH adapter are untouched. Source baseline: `cc5e82b176`.

## Deterministic checks

`tests/agent-bridge/codebuddy.test.ts` runs the real bridge against a separate
native fixture process. It covers both receipt orders (including coalesced
stdout), both message-id locations, wrong admission owner, wrong insertion
owner, wrong session/id, each missing receipt, admission-only pending → unknown,
slash/image/unknown-content rejection, explicit queue fallback, probe text drift
and late old-run insertion. The native wire must contain one main prompt and
one steer, with no implicit cancel/replay. Success evidence includes the actual
native message id and run owner.

| Check | Result |
| --- | --- |
| CodeBuddy deterministic fixture | 13 passed |
| `npm run test:agent-bridge`, 10 consecutive runs | 176 passed each, 0 failures each |
| `npm run typecheck` (root) | passed twice, including final source |
| `npm run check:boundaries` | passed |
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

## Implementation decisions

- Reimplemented the user's confirmed CodeBuddy patch semantics in an independent
  module; did not copy the shared compatibility proxy or its retry/cancel loop.
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

## Independent review: blocked by automatic approval

All deterministic checks passed before dispatch. The required `autoreview` /
`bb-model-routing` workflow prepared a read-only review of the complete staged
P4 diff. No reviewer thread was created: the first sandboxed call could not
write the dispatch cache lock; both elevated attempts were rejected by automatic
approval. Read-only checks confirmed the BB endpoint is the current local
loopback service and the user's medium route uses configured Codex accounts.
The second rejection nevertheless required explicit authorization for that
Codex destination to process repository contents. No alternate dispatch route
was used. Independent review and P1 closure remain pending that approval.
