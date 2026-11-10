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
| `npm run test:agent-bridge` | **77 passed**. 20 new Pi/Host-settlement cases plus the 57 P1a/P1b cases |
| `npm run check:boundaries` | passed |
| `node scripts/build-pi-bridge.mjs` | `plugins/pi-bridge/dist/main.mjs`, 9,004,191 bytes, SHA-256 `f6dd7d43c754474b6dc82640bd42f47871e256d7757131af6c983457d2fa754e` |
| `PI_BRIDGE_KEEP=1 node --import tsx scripts/smoke/execution/smoke-pi-bridge.ts` | passed on the real local Pi account; details below |

## New deterministic cases

`tests/agent-bridge/pi-bridge.test.ts` (16):

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
  still take precedence, and queue-entry evidence upgrades an unknown
  admission to accepted so Host release is not permanently blocked;
- retry of a terminal stale/unknown input id repeats the same refusal instead
  of returning a successful duplicate; a completed turn start retry is
  idempotent and does not create a second native run;
- `session/resume` seeds the current native snapshot and emits no historical
  turn/item deltas; completed history is not duplicated, while later native
  changes still stream;
- callback ids are unique per runtime, so close→resume cannot collide with the
  Host's callback-id idempotency table;
- the Host settlement helper maps `invalid`, `unsupported`, `stale-target`,
  `auth`, `quota` and `explicit-reject` to rejected, leaving `unknown` only for
  ambiguous outcomes.

`tests/agent-bridge/pi-owner.test.ts` (2):

- one bridge Thread opens exactly one native SQLite owner with metadata and a
  non-empty database; a second `create` refuses adoption and a live `resume`
  fails on the native lock; a deleted database is never recreated as an empty
  writer;
- a pending metadata record (crash after native open) is recoverable by
  `resume`, never adopted by a second `create`; resume refuses an unknown
  bridge Thread. Typed `PiSessionOpenError` failures distinguish
  exists/pending/locked/missing.

`tests/agent-bridge/pi-host.test.ts` (1):

- the independent Host pins and launches the built bridge artifact, negotiates
  the declaration, commits `thread/identity`, records exactly one SQLite holder
  (a bridge child, not the Host process), answers `maintenance/probe`, settles a
  stale steer as rejected, settles a missing-database resume as rejected, and
  releases the Thread. `host.test.ts` also pins the typed-error settlement map
  directly.

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

- `sqlite-holders 550540`, `bridge-pid 550540` — `lsof` saw exactly one writer;
  the old AppServer Pi engine and the Host process held no descriptor.
- `input.accepted` + `input.delivery(admitted=true)` for both steers.
- `input.evidence(admission)` for both, keyed by durable submission id.
- `input.evidence(queue-change)` for both, with distinct evidence refs; no
  `context-confirmed` delta appeared.
- `tool.txt` became `"alpha\nSTEER-OK\nSTEER-OK\n"` in the final run (another
  post-fix run produced one line). This is useful behaviour evidence, but the
  protocol evidence remains admission/queue-change only.

Evidence tier: **native admission + native inbox/entry transition
(evidence-observed)**. It is not model-context confirmation and not a claim
that the model understood or executed the instruction.

## Independent review closure

An independent review thread (`thr_udyy2i8p8f`) reviewed commit `18d159583a`.
It reported seven P1 findings; all were accepted and fixed (a second commit
follows):

1. close→resume reused delta callback ids; fixed with a per-runtime callback id
   and a regression test that walks close→resume→new turn.
2. `create` could leave an orphan database between native open and active
   metadata; fixed with an atomic pending reservation, cleanup on post-open
   failure, and resume recovery of a pending record.
3. stale steer/session refusals settled as Host `unknown`; fixed by typed
   `PiSessionOpenError` plus Host `dispatchSettlement`, which now rejects
   deterministic typed refusals and keeps `unknown` only for ambiguity.
4. resume replayed settled native turns; fixed by seeding the mapper from the
   current snapshot and emitting no historical deltas, with a `staleTurn`
   recovery hint when an active turn is present.
5. duplicate input-id retries turned prior stale/unknown failures into
   success; fixed by preserving the terminal state/reason and repeating the
   typed refusal.
6. queue-change evidence resolved outcome but left admission unknown, blocking
   Host release; fixed by upgrading unknown admission to accepted on
   queue-entry/native-input/context evidence.
7. owner lock/missing-database messages were not classified as explicit
   rejections; fixed with typed failures and Host integration coverage.

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
