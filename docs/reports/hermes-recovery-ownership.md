# Hermes live recovery ownership (2026-09-08)

## Reference behavior

- Hermes Desktop `use-session-actions/utils.ts:appendLiveSessionProjection`
  merges backend `inflight` into the current live tail, preserves a structured
  tail over a flat assistant dump, orders corrections by offsets, and exposes
  retained failures. Completed historical replies cannot hide a repeated prompt.
- `apps/shared/src/json-rpc-gateway.ts:fetchReplay` retains per-session cursors
  across warm reconnects and parks competing live frames while fetching replay.
- Desktop's localStorage journal is optional crash recovery, not transcript
  authority. This change does not introduce a browser-owned history database.

## Implemented

`HermesProjectionRecovery` couples a live projection owner, accepted pending
owners, queue boundaries, and replay watermark. Socket replacement may retain
that object; account changes and gateway epochs invalidate it. A bare checkpoint
is no longer accepted as a BrowserHermesBridge option. Unowned watermarks are
removed before reconnect. This is a connection-local replica, not durable state.

Warm activation reuses the exact state machine, including its streamed-segment
identity, before replay. Cold activation discards detached replay and reads
`session.activate(omit_messages=true)` for the current backend tail. The new
Turn/Item projection consumes inflight text, corrections, start time and failure
state; structured tool/reasoning tails take precedence over a flat text dump.
Both embedded and cursor-bootstrap history paths receive the recovered tail.

A truncated replay or replay failure falls back to snapshot recovery rather
than emitting a known incomplete suffix. Frames arriving after the snapshot
response are held until the new projection owner is installed.

## Limits (not new protocol guarantees)

The upstream snapshot does not carry an atomic event watermark. Discarding
pre-response frames during cold snapshot replacement is a best-effort boundary,
not proof that a concurrently emitted event is represented by the snapshot.
Exact snapshot/event consistency requires an upstream contract; local storage
cannot create that guarantee. No production deployment or browser visual
acceptance was performed in this change. Local journal/crash-tail persistence
and full queued-prompt snapshot parity remain separate work.

Verification: 186 targeted tests passed, including retained-owner reconstruction,
cold inflight continuation, repeated historical prompts, correction offsets,
structured-tail precedence, failures, replay truncation and snapshot release.
Web/Expo type checks passed. Protocol tests use a temporary style-import stub.
