# P2d local validation — 2026-11-11

Source base: P1b `0d8f509517` (`feat/agent-bridge-p1b`, not yet merged to main).
The old Pi engine path is untouched by default; the bridge is a new opt-in
artifact and no existing engine selects it.

## Recorded checks

| Command / probe | Result |
| --- | --- |
| `npm run typecheck --workspace @opencraft/plugin-pi-engine` | passed after the optional `shell: false`/`lockRetries` additions; default behaviour is unchanged |
| `npm run typecheck --workspace @opencraft/plugin-pi-bridge` | passed |
| `npm run typecheck --workspace @opencraft/agent-bridge-protocol` | passed |
| `npm run typecheck --workspace @opencraft/agent-bridge-assembler` | passed |
| `npm run typecheck --workspace @opencraft/agent-bridge-host` | passed (unchanged) |
| `npm run test:agent-bridge` | **71 passed**. 14 new Pi cases plus the 57 P1a/P1b cases |
| `npm run check:boundaries` | passed |
| `node scripts/build-pi-bridge.mjs` | `plugins/pi-bridge/dist/main.mjs`, 8,996,904 bytes, SHA-256 `c12f70ee0ced3da3f2bb4bac3ff51a30421edc75adf40b893c29f6dee5834dfa` |
| `PI_BRIDGE_KEEP=1 node --import tsx scripts/smoke/execution/smoke-pi-bridge.ts` | passed on the real local Pi account; details below |

## New deterministic cases

`tests/agent-bridge/pi-bridge.test.ts` (11):

- declaration exposes only `native-inject`, `admission`/`queue-change`, and no
  `context-confirmed`/`native-input-id`;
- tool-interleaved steer is mapped to registration + `input.delivery` +
  admission evidence, then queue-change when the durable inbox item becomes a
  transcript entry;
- two identical texts with distinct input ids stay two native facts (no text
  multiset matching);
- an input still queued at the turn boundary emits
  `input.outcome(failed, "Pi turn ended before steer was consumed")`;
- the bridge returns immediately after steer admission, not after consumption;
- duplicate input id retry is idempotent and does not add a native execution;
- a stale target is an explicit reject with `delivery.admitted=false`, never a
  delivered label;
- a second create for an in-process live Thread does not open another owner;
- owner loss emits typed recovery and fences commands;
- the canonical assembler keeps an admission-only steer `failed` when the turn
  ends unconsumed, while a queue/entry transition reconciles an earlier
  `unknown`. This required a small P1a ordering fix in
  `packages/agent-bridge-assembler/src/steer.ts`: `deriveOutcome` used to let
  any `evidence-observed` facet mask a terminal failure. Admission-only
  evidence no longer masks failure; context-confirmed and queue-change proof
  still take precedence.

`tests/agent-bridge/pi-owner.test.ts` (2):

- one bridge Thread opens exactly one native SQLite owner with metadata and a
  non-empty database; a second `create` refuses adoption and a live `resume`
  fails on the native lock; a deleted database is never recreated as an empty
  writer;
- resume refuses an unknown bridge Thread.

`tests/agent-bridge/pi-host.test.ts` (1):

- the independent Host pins and launches the built bridge artifact, negotiates
  the declaration, commits `thread/identity`, records exactly one SQLite holder
  (a bridge child, not the Host process), answers `maintenance/probe`, accepts
  `session/close`, and releases the Thread.

## Real-account task and steer evidence

Model: `pi:ollama-cloud:deepseek-v4.1-flash` — the cheapest available zero-cost
model at run time (input/output/cache all 0 in the current catalog). One
minimal task in a temporary directory; no paid escalation after any failure.
Credentials stayed in the existing Pi agent directory and were never copied or
logged by the smoke.

The task asked for one `bash` tool call (`printf alpha; sleep 6; printf beta`)
and then a short answer. While the tool was running, the smoke sent two
byte-identical steers with distinct input ids (`steer-1`, `steer-2`), each
asking to append `STEER-OK`. Observed:

- `sqlite-holders 436241`, `bridge-pid 436241` — `lsof` saw exactly one writer;
  the old AppServer Pi engine and the Host process held no descriptor.
- `input.accepted` + `input.delivery(admitted=true)` for both steers.
- `input.evidence(admission)` for both, keyed by durable submission id.
- `input.evidence(queue-change)` for both, with distinct evidence refs; no
  `context-confirmed` delta appeared.
- `tool.txt` became `"alpha\nSTEER-OK\nSTEER-OK\n"`; the model followed both
  identical texts. This is useful behaviour evidence, but the protocol evidence
  remains admission/queue-change only.

Evidence tier: **native admission + native inbox/entry transition
(evidence-observed)**. It is not model-context confirmation and not a claim
that the model understood or executed the instruction.

## Gaps and honest limits

- The real accepted-but-unconsumed race did not trigger. Four real attempts
  (the two-steer task plus three immediate no-tool steers) all saw the steer
  placed before the boundary. The deterministic mapper/bridge tests cover the
  race (`Pi turn ended before steer was consumed`); this run does not claim a
  real reproduction.
- The real smoke drives the bridge process directly. `pi-host.test.ts` proves
  the Host launches/handshakes/creates/closes the artifact, but it does not run
  a real model through the Host. Host durability and restart are P1b's tested
  scope.
- Bridge restart does not auto-resume pending native work in this batch; a
  later provider recovery pass must reconcile it. A live second writer is
  refused by the native lock.
- The design text spells the steer boundary as Pi RPC
  `streamingBehavior="steer"`; the existing OpenCraft Pi owner has no RPC
  session. The bridge uses the owner's native inbox `mode:"steer"` path instead
  of spawning a second Pi writer. This is an intentional deviation with the
  same same-turn boundary and no second transcript.
- New Threads are opt-in only. Existing Pi Threads remain on the current engine;
  this batch does not change engine defaults or migrate them.
