# P5 Cursor validation — 2026-11-11

Source base: latest `origin/main` at `e89ade206d` (rebased with `--no-autostash`). This is a standalone opt-in SDK adapter. Default
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

Eight separate-process Host cases verify delivered, rejected, unknown, missing
key, retry after a typed create rejection, preparing/consume cleanup failures
and close retry through command custody, the
assembler and existing AppServer projection.
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
SDK transcript or model-context proof. The final recording pins the built
artifact after the review fixes and rebase;
this is a local Host run, not a deployed client claim. Earlier restricted-environment
SDK attempts remained unknown and were never replayed; their precise stall cause
was not established. They are retained locally as diagnostics, not success proof.
A later session-create attempt returned unknown before any model send; its
[redacted failure record](../../design/agent-bridge/recordings/p5/cursor-sdk-create-blocked.json)
is retained separately. No unknown mutation was replayed. Independent no-model
SDK and built-worker creation probes passed; a subsequent fresh Host task produced
the final successful recording. The transient creation cause remains unestablished.

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

8. Once native Stop is confirmed, Worker termination owns local close completion.
   SDK disposal is best effort; failed Worker termination stays retryable. Failed
   attachment disposal retains session custody and refuses reuse until cleaned.

## Final checks and independent review

| Check | Result |
| --- | --- |
| Cursor adapter + Host deterministic cases | 46 passed |
| `npm run test:agent-bridge`, 10 consecutive final-source runs | 275 total, 274 passed, 1 existing skip, 0 failures each |
| Root `npm run typecheck` | passed |
| Cursor app and strict standalone smoke/fixture/test typechecks | passed |
| `npm run check:boundaries` | passed |
| Standalone main/worker build and syntax checks | passed |
| Public recordings path/credential redaction check | passed |
| Staged diff through gitleaks | no leaks |

The first SDK review was explicitly stopped on direction change and is not a
passing review. Fresh full review: `thr_m2mji72uwt` (simple, DSH via configured
bb-dispatch routing). Incremental repair review: `thr_y72sju4uye` (same configured
simple routing); it reported two additional cleanup/close P1 findings, fixed below.


### First final-review findings and fixes

Review `thr_m2mji72uwt` reported seven P1 findings. All were accepted and fixed:
SDK create refusals preserve typed invalid/quota/busy errors; every steer first
registers its client request and target (without asserting admission); Stop
checks supplied turn targets; a failed close retains its owner; clientRequestId
is deduplicated; preparation failure settles failed without SDK dispatch; and
cleanup failure cannot skip native cancel. Regression cases cover all seven,
including a rejected create followed by successful same-Thread creation/close.
Open tools are also given a terminal failed shape on cancellation. The initial extended
Cursor suite had 38 cases. Post-rebase final results are recorded in the table above.

### Post-rebase Claude test race

The first full run had 265 passes, 1 skip and 1 failure: Claude Host release said
“Thread events remain unacknowledged”. The test took its event snapshot before
session/close, then acknowledged that old snapshot after close; the adapter emits
session.ended during close. The test now rereads events after the close receipt,
acknowledges them and retains the original releaseThread assertion. This small
test correction is a separate commit. The failed initial run is excluded from
the required consecutive final runs; it is not hidden by retrying the assertion.

### Incremental review findings and closure

Both P1 findings from `thr_y72sju4uye` were accepted and fixed. Preparing inputs
publish withdrawal even when local disposal fails. A confirmed native stop with
failed local cleanup is explicitly rejected, retaining files for a later close;
it is not mislabeled as an unknown native mutation. Consume always clears its
active owner, retains failed files in session custody and prevents new turns
until cleanup succeeds. The stopped run's completed promise remains usable.

Factory close refusal preserves the session and returns explicit-reject. After
a confirmed stop, the SDK's disposal RPC is best effort; actual Worker termination
is the local close boundary. Successful termination is memoized, failed termination
can retry, and neither path replays SDK close. This is an additional implementation
decision. This does not turn an unknown running task into a confirmed stop.

46 deterministic cases now include second-clean failure with preparing withdrawal,
consume cleanup failure, factory close refusal, Worker termination retry and
separate-process Host cases that recover and release the route. The primary agent
verified these bounded repairs after round two; no third review was dispatched,
in accordance with the review skill's two-round limit.

The first post-cleanup-fix loop stopped on run 5: the pending initial-send test
exhausted 1000 immediate callbacks in about 13 ms while awaiting attachment IO.
It now waits for a deferred fake-SDK send-entry signal, with a 5-second test
timeout, then asserts the same deletion and native cancellation behavior. This
removes scheduler-spin counting rather than retrying or weakening assertions.
The final ten consecutive runs start after this test-boundary correction.

The same bounded correction covers explicit input/withdraw: publish definitive
withdrawal before local disposal, retain failed files and return explicit-reject
for cleanup retry. Final-source checks start after that correction.

A superseded loop that overlapped the final loop and root typecheck also observed
one AGY locked-database test failure (“Missing expected rejection”). AGY was not
modified; the fact and parallel-run conditions were reported to the parent. This
was not reproduced in the final ten runs. No claim about its cause is made.
