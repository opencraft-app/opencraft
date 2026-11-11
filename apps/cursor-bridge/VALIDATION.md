# P5 Cursor validation — 2026-11-11

Source base: `bc296ac855`. This is a standalone opt-in SDK adapter. Default
engine selection, Hermes and P6's ACP implementation are unchanged. Final user
scope: native SDK steer only; revert is rejected, with no automatic followup.

## Behavior verified deterministically

Both SDK results are tested independently. complete_delivered emits native-inject
plus admission evidence only. revert_to_followup emits rejected / “not inserted
into the current turn”, never another send. Queue, interrupt and queue fallback
are refused before dispatch. SDK user/history echo cannot confirm context.

Tests cover stale targets, duplicate input/Host command ids, one unresolved
input, missing steer support, unknown outcomes and future enum values, late acks,
run end/close races, missing-key guidance, environment or stored credentials,
and unknown withdrawal retaining unknown through the assembler. Attachment
cleanup covers conversion, dispatched steer, explicit withdrawal, rejection,
completion, failed/hung native cancel, pending initial send and callback loss.
Callback failure fences writes without poisoning later callback serialization.
SDK assistant chunks assemble into one complete canonical message.

Four separate-process Host cases verify delivered, rejected, unknown and missing
key through command custody, the assembler and existing AppServer projection.
The unknown case retains custody and refuses route release instead of replaying.
The fixtures do not use the network or execute a model/tool.

## Real-account evidence: SDK delivered only

The local SDK credential store was already authenticated; no key was copied,
printed, created or changed. SDK model/list included `claude-haiku-5-5`.
[Official pricing](https://cursor.com/docs/models-and-pricing) listed it at $0.10
input / $0.50 output per million tokens, below the other fixed SDK models
checked. No Auto or more expensive fallback was selected.

[Final redacted Host recording](../../design/agent-bridge/recordings/p5/cursor-sdk-final.json):

- A SHA-256-pinned main bundle and verified worker run through the independent
  Host with the process test backend; no production isolation claim.
- One minimal sleep tool task and one steer invocation. The trace records
  SDK steer-dispatch after the same run's tool running and before completed.
- The same native run returns complete_delivered and then finished. Native send
  count 1 and steer count 1; create/task/steer/close receipts accepted.
- The canonical input is native-inject + admission/evidence-observed, never
  context-confirmed. Local user echo and the model answer do not upgrade it.

The recording fixes SDK 1.0.32, protocol/grammar 1, permission mode, mapper,
artifact/worker hashes and opaque correlation ids. Only selected native facts
and event projections are exported; raw errors, text, tool arguments, account
information, key material and machine paths are omitted. This is not a complete
SDK transcript or model-context proof. Later assistant-chunk grouping and auth
wording were checked deterministically; the recording pins the actual attempted
artifact, not a claim of a deployed current build. Earlier restricted-environment
SDK attempts remained unknown and were never replayed; their precise stall cause
was not established. They are retained locally as diagnostics, not success proof.

CLI ACP and hooks were separately investigated; [feasibility](../../design/agent-bridge/p5-cursor-cli-feasibility.md)
records the actual cancel-replace, absent hook calls and blocked print/plugin
probe. No CLI steer/queue/interrupt adapter is delivered. The hook-negative
observation is limited to this installed version and exercised paths.

## Self-introduced decisions

1. A standalone app avoids shared ACP/P6 changes. The published SDK is fixed at
   1.0.32 and external; its proprietary terms are preserved. The upstream runner,
   history writer and approval retry loop are independently replaced, not copied.
2. Only native-inject is declared. Revert is a definitive rejection with a plain
   explanation. No platform next-turn queue, implicit interrupt or retry loop.
3. P5 requires explicit full permission mode, shell tools, model, workspace and
   private stateDirectory. The SDK sandbox is disabled for full mode; the Host
   backend owns containment. No history/resume/usage/CLI/reasoning claim.
4. SDK runtime/storage run in a Worker, whose digest is checked by the main
   artifact. The public JsonlLocalAgentStore keeps vendor storage off network loops.
5. Attachments are bounded base64 inputs converted to generated private local
   paths (64 KiB encoded total, 16 files), not rich SDK attachments. Stop removes
   them before waiting for a possibly hanging SDK send/cancel.
6. One unresolved steer, a 30s deadline and unknown fencing prevent replay.
   Confirmed Stop permits a new explicit turn; uncertain Stop stays fenced. Missing credentials fail
   before creating an agent and link to API Keys and bridge launch configuration.
7. Suite execution removes only exported BASH_FUNC_* environment entries: existing
   fixtures pass all process.env into the strict sandbox validator. No source,
   dependency, sandbox policy or baseline is changed to bypass that validation.

## Final checks and independent review

| Check | Result |
| --- | --- |
| Cursor adapter + Host deterministic cases | 29 passed |
| `npm run test:agent-bridge`, 10 consecutive final-source runs | 226 passed, 0 failures each |
| Root `npm run typecheck` | passed |
| Cursor app and strict standalone smoke/fixture/test typechecks | passed |
| `npm run check:boundaries` | passed |
| Standalone main/worker build and syntax checks | passed |
| Public recordings path/credential redaction check | passed |
| Staged diff through gitleaks | no leaks |

The first SDK review was explicitly stopped on direction change and is not a
passing review. Fresh final review: `thr_m2mji72uwt` (simple, DSH via configured
bb-dispatch routing), current full staged diff. Its result is recorded below
before commit.


### First final-review findings and fixes

Review `thr_m2mji72uwt` reported seven P1 findings. All were accepted and fixed:
SDK create refusals preserve typed invalid/quota/busy errors; every steer first
registers its client request and target (without asserting admission); Stop
checks supplied turn targets; a failed close retains its owner; clientRequestId
is deduplicated; preparation failure settles failed without SDK dispatch; and
cleanup failure cannot skip native cancel. Regression cases cover all seven,
including a rejected create followed by successful same-Thread creation/close.
Open tools are also given a terminal failed shape on cancellation. The extended
Cursor suite is 38 cases. Post-rebase final suite/check results replace the
pre-review counts above before delivery.
