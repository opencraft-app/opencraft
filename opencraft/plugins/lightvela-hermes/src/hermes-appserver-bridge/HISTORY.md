# Hermes transcript history

The adapter consumes Hermes Desktop's message-window contract. It does not
require a backend schema or endpoint change.

## Source and scope

- Initial REST read: `GET /api/sessions/{storedId}/messages` with `limit=120`,
  `offset=0`, `order=latest`, `include_compacted=true`, and the resolved `profile`.
- Backfill: one request with the same parameters and the recorded offset.
  Never chase a user row, complete an execution Turn, or rescan from zero.
- Row IDs own deduplication. Tool-call IDs join declarations and results.
  A page starting with a tool result is valid; it does not require a preceding
  declaration to be fetched before it can be displayed.
- A connection owns its read cache; keys additionally contain profile and
  stored-session ID. Rebuilding the adapter transfers snapshots, not old HTTP
  clients. Account reset clears them. Bookkeeping is bounded to 256 entries.
- Refresh grafts a new tail onto a previously loaded prefix only at a shared
  durable row anchor. Failed/stale reads cannot commit cursor or cache changes.

## AppServer boundary

`initialize` advertises `opencraft/message-window-history` version 1.
`thread.historyMode` is `message-window`. For this mode:

- `thread/read(includeTurns=false)` reads metadata only, without runtime resume.
- `thread/resume` starts REST hydration and runtime activation concurrently.
  When the caller supplies `historyPreviewToken`, the REST result can emit
  `thread/history/preview {threadId, token, turns}` before Resume completes.
  Only the matching pending request can paint it. It establishes neither
  execution readiness nor a replay cursor.
- `initialTurnsPage`, or the prepared `thread/turns/list` bootstrap, exposes
  exactly that hydrated window. There is no second bootstrap REST request.
- `thread/turns/list` backfills one REST page and returns the **loaded window**,
  not a disjoint batch of complete execution Turns. Its cursor is opaque.
  `limit` does not redefine Hermes' 120-row source paging policy.
- History groups carry `historyWindowId`. Loading earlier rows can change a
  partial group's membership/ID. The session layer replaces previous history
  groups instead of append-merging them, and preserves separately owned live
  execution state. Item IDs remain based on source rows/tool calls.
- No automatic all-history drain is registered for this history strategy.
- Navigation waits for the history model to be known and, in message-window
  mode, indexes only materialized groups. It does not run Codex's independent
  ten-page Turn-stub scan or issue hover-time history reads.
- Gateway RPCs and the HTTP transport own their respective deadlines. History
  hydration has no additional AppServer wall-clock deadline: Desktop's HTTP
  `req.setTimeout(30000)` is an inactivity deadline, not a total transfer budget.
  Continued body progress must not be canceled just because 30 seconds elapsed.

The existing generic replica cache is still paint-only. These changes do not
introduce a second browser-owned execution database. A row limit is not a byte
limit: an individual tool result can still exceed 300 KB.

## Verification

`tests/hermes-history-integration.test.ts` exercises adapter → AppServer →
Workbench preview/readiness, one-request bootstrap, coalesced backfill and
reconnect. `hermes-history-reconstruction.test.ts` checks a 522-row execution
without eager loading, orphan boundaries and nonduplicating regrouping.
`hermes-transcript-window.test.ts` and `hermes-history-cancellation.test.ts`
cover source parameters, shifted offsets, stale generations and cancellation.
