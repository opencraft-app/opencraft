# Pi provider bridge (P2d, opt-in)

A standalone provider bridge for the existing Pi durable owner. It is launched
by the independent `apps/agent-bridge-host` generation, speaks the P1a bounded
JSONL protocol, and opens the same `PiDurableSession` the AppServer Pi engine
uses. It does **not** spawn a Pi RPC child and never opens a second writer for a
session.

The native owner is one `@earendil-works/pi-durable` session stored as one
SQLite file per bridge-owned Thread. The durable owner's lockfile, not a
process-name guess, is the writer fence. Bridge metadata and the SQLite file
live under a bridge-private directory so the AppServer Pi engine's catalog
cannot discover or adopt them. `session/create` refuses an existing metadata
record or orphaned database, and `session/resume` refuses a live writer or a
missing native database. Existing Pi Threads stay on the existing engine; only
new Threads explicitly routed to this bridge use it.

## Relationship to the design text

The design's Pi row asks for `streamingBehavior=steer` (the Pi RPC spelling).
The existing OpenCraft Pi owner has no RPC session; its native same-turn
delivery is the durable inbox item with `mode: "steer"`, placed after the
current tool round. This bridge uses that owner API directly. Spawning a Pi RPC
child would create a second writer for the same Thread, which is the hard
constraint this batch must not break. The semantic path is the same native
steer boundary; no RPC child, no second transcript, and no text-multiset queue
matching are used.

Evidence is deliberately limited:

- `input.accepted` is registration on the bridge.
- `input.delivery(native-inject, admitted)` records the owner's durable steer
  admission.
- `input.evidence(admission)` and `input.evidence(queue-change)` are
  **evidence-observed**: the durable submission exists and its inbox item moved
  into the transcript. This is correlated by the stable durable submission id,
  so duplicate text is not ambiguous.
- Queue removal / transcript placement never becomes `context-confirmed`.
  The bridge declares no `native-input-id` or `context-confirmed` kind.
- If a turn ends before a queued steer is placed, the bridge emits
  `input.outcome(failed, "Pi turn ended before steer was consumed")`; it does not
  turn that race into a success. Stop is not withdrawal.

## Build and run

```sh
node scripts/build-pi-bridge.mjs
# artifact: plugins/pi-bridge/dist/main.mjs (SHA-256 pinned by the Host generation)

PI_BRIDGE_DATA_DIR=/absolute/private/pi-bridge \
PI_BRIDGE_AGENT_DIR=/absolute/pi-agent \
node plugins/pi-bridge/dist/main.mjs
```

`PI_BRIDGE_DATA_DIR` is required and must be absolute. It holds
`sessions/<owner>.json` and `sessions/<owner>.sqlite` (directory mode 0700,
files 0600). `PI_BRIDGE_AGENT_DIR` supplies `auth.json` and `models.json`; it
defaults to the data directory. `PI_BRIDGE_MODEL_POLICY` optionally enables the
existing model-policy hook. The bridge writes protocol frames to stdout and
diagnostics to stderr only.

A Host generation launch must include the artifact path in `command` and the
two directories in `env`, for example:

```json
{
  "command": ["/usr/bin/node", "/srv/opencraft/generations/pi-bridge/main.mjs"],
  "cwd": "/",
  "env": {
    "PI_BRIDGE_DATA_DIR": "/var/lib/opencraft/pi-bridge",
    "PI_BRIDGE_AGENT_DIR": "/var/lib/opencraft/pi-agent"
  }
}
```

The Host already verifies the generation digest and starts the process in the
selected sandbox. This package does not install a service or change any engine
default.

## Command surface

`initialize` negotiates protocol/grammar and returns the declaration. The
declared native delivery path is `native-inject`; `next-turn` and
`interrupt-replace` are not declared. Text only; input is a non-empty array of
`{type:"text", text}` or a string.

| Command | Parameters (bridge-specific shape) |
| --- | --- |
| `model/list` | none; returns `{data, nextCursor}` |
| `session/create` | `threadId` (Host route), `cwd` (absolute), `model`, optional `thinkingLevel`, `baseInstructions`, `developerInstructions` |
| `session/resume` | `threadId`; only a bridge-owned durable session |
| `session/close` | `threadId`; fences new turn commands, rejects while a native turn is active, diffs one final native snapshot before `session.ended` |
| `turn/start` | `threadId`, `inputId`/`clientRequestId`, `input`; returns after durable admission, not after the answer |
| `turn/steer` | `threadId`, `inputId`/`clientRequestId`, `expectedTurnId`, `input`; returns admission immediately |
| `turn/stop` | `threadId`; aborts the native run and queued inputs, not a withdrawal |
| `input/query` | `threadId`, `inputId`; bridge evidence or native execution status |
| `input/withdraw` | refused: this bridge declares no withdrawal |
| `history/read` | `threadId`, optional `limit` (1–50); bounded native projection |
| `maintenance/probe` | none; owner/version/incarnation facts |

`session/create` atomically reserves a pending metadata record before it opens
the native database and removes the half-created session if any later step
fails. A second create for the same Thread never opens another native owner. A
crash between native open and active metadata leaves a recoverable pending
record; `session/resume` may adopt it after acquiring the native lock. A
resume seeds the mapper from the current native snapshot and emits no
historical turn/item deltas, so a Host checkpoint is not duplicated; if an
active native turn exists it also emits a `staleTurn` recovery hint. The bridge
does not auto-resume pending native work in this batch (a future provider
recovery pass reconciles it).

A retry with the same input id is idempotent only while the first steer is
still admitted/evidence-observed. If the first attempt ended stale, failed or
unknown, the bridge repeats that typed refusal (or unknown outcome) instead of
returning a successful duplicate. A completed `turn/start` retry is likewise
idempotent and does not create a second native run.

Deterministic provider refusals (`explicit-reject`, `invalid`, `unsupported`,
`stale-target`, `auth`, `quota`) settle as Host `rejected`; `unknown` is
reserved for ambiguous native outcomes. A rejected `session/create` releases
the fresh Host route binding only for invalid/unavailable/orphaned refusals;
pending/exists/locked keep the binding so the same native writer can be
resumed. A genuinely ambiguous command remains unknown custody until an
explicit reconcile operation; this bridge never auto-replays it.

## Files and ownership

- The bridge is the only writer for its `sessions/*.sqlite` while alive.
- Bridge sessions use the ordinary coding tools (including `bash`) and disable
  the AppServer PTY worker (`shell: false` in the durable owner). The old Pi
  engine keeps its PTY path unchanged.
- The Host owns command custody, outbox and generation draining. The bridge
  owns the native session and emits semantic deltas; P1a owns grammar and
  assembly.

## Validation

```sh
npm run typecheck --workspace @opencraft/plugin-pi-engine
npm run typecheck --workspace @opencraft/plugin-pi-bridge
npm run test:agent-bridge
node scripts/build-pi-bridge.mjs
PI_BRIDGE_AGENT_DIR="$HOME/.pi/agent" \
  node --import tsx scripts/smoke/execution/smoke-pi-bridge.ts
```

The opt-in smoke uses one minimal task on the cheapest available Pi model and
requires local Pi credentials. It is not a CI gate. Deterministic tests cover
tool-interleaved steer, duplicate text with distinct native ids, the
end-before-consumption race and one-writer lock contention. See
[VALIDATION.md](VALIDATION.md) for the recorded run and evidence tier.
