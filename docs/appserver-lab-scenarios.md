# AppServer Lab scenario matrix

`apps/appserver-lab` is the executable smoke consumer for the renderer-neutral
AppServer SDK. It is intentionally a TypeScript NDJSON harness, not a terminal
product. A scenario passes only when the public SDK produces observable domain
content and leaves its connection bookkeeping valid.

## Implemented scenarios

| Scenario | Failure or invariant exercised | Pass condition |
| --- | --- | --- |
| `initialize` | handshake and capability projection | initialization result and generation 1 are observable |
| `smoke` | minimum real-server read path | initialize plus a valid `thread/list` page |
| `pagination` | opaque cursor continuation | second page is valid and has no repeated thread IDs |
| `resume` | AppServer tail-hydration resume | selected thread, workspace roots, turn/item cursors and initial page are projected |
| `resume-contract` | repeated and post-reconnect resume identity | every response preserves the requested ID; reconnect advances generation; a missing ID fails with RPC `-32000` |
| `desktop-resume` | complete Desktop-style View hydration | Cordis strategies load the selected history mode, commit ownership/execution/security View state, and release buffered traffic after commit |
| `replica-resume` | AppServer V3 compatibility into the V4 client model | Resume hydrates a View, adjacent revisions stream into Replica, persisted cache paints non-authoritatively, then exact sync promotes it to live |
| `history` | post-resume history continuation | `turnsBackwardsCursor` is followed when present; absent cursor is a valid terminal state |
| `concurrency` | multiple in-flight requests and out-of-order replies | unique JSON-RPC IDs, all replies correlated, pending count returns to zero |
| `timeout` | a response is blackholed | request fails with `TIMEOUT`, transport stays open, the next request succeeds |
| `abort` | caller cancels before a delayed response arrives | request fails with `ABORTED`, late response is isolated, next request succeeds |
| `canonical-session` | one real persistent session identity | `thread/start` runs at most once; active list and resume use that ID before terminal archive; later runs verify the same archived ID without fork/replacement |
| `reconnect` | connection drops with a request in flight | pending request fails with `TRANSPORT_ERROR`, pending state drains, initialize repeats under a new generation |
| `reconnect-loop` | repeated clean disconnect/reinitialize cycles | generation advances exactly once per cycle and no pending state leaks |
| `suite` | one-process interaction between safe non-creating cases | nine cases complete in order, including Resume identity and post-fault recovery |

The deterministic in-memory tests also cover explicit and automatic thread
selection, empty thread lists, missing history cursors, overlapping-page
rejection, cursor-cycle rejection, reporter serialization (including shared and
circular graphs), bounded notification/request journals, argument validation,
inbound blackholes and delayed-frame cancellation. Transport tests additionally
cover stale WebSocket generation events, connect/close failures, abort error
classification, binary frame ordering, and domain-ID-sensitive replay matching.

## Scenario ownership

- A request timeout must not destroy a healthy transport; connection loss rejects in-flight work.
- Reconnect lifecycle and grace windows are explicit protocol cases.
- Stale generations cannot commit after a Host switch or refresh.
- Resume, gaps, epoch changes, rewinds and buffered updates are separate state-machine cases.
- Cursors are opaque continuation tokens rather than client-owned offsets.

The Lab owns transport/Resume scenarios and a real Replica compatibility scenario.

## Exact Resume boundary

The Lab now proves the AppServer RPC boundary, not the complete Desktop View
hydration state machine. Against the live 9988 server it has verified that an
active Thread can be resumed repeatedly and after a physical reconnect without
changing its ID, a missing ID fails with `-32000`, and the canonical archived
Thread fails with `-32071` instead of being silently forked or replaced.

The `desktop-resume` scenario exercises the separate
`@opencraft/appserver-session` layer: notification/request buffering, all four
history strategies, Turn/Item pagination, permissions/workspace/model
projection, and owner/follower state. `replica-resume` then consumes that View
through the explicit AppServer V3 adapter. It proves cached paint versus authority,
revision streaming and snapshot fallback without claiming the provider has V4 wire
methods.

The canonical-session identity file is acquired before `thread/start`, including
an inter-process lock. Corrupt, missing-on-server, or unresumable persisted IDs
fail closed: the Lab never hides state loss by silently creating another ID.

## Deferred until the corresponding layer exists

| Future scenario | Required implementation first |
| --- | --- |
| heartbeat: one missed pong survives, repeated misses close | heartbeat/liveness policy in `Connection` |
| stale generation cannot commit | host runtime or Replica commit boundary |
| reconnect resubscribes exactly once | typed subscription registry |
| relay reuse within grace and expiry cleanup | server-side relay/session ownership |

These become real scenarios when their public contracts land. Until then they
remain explicit acceptance requirements rather than mocks that can pass without
the production behavior.
