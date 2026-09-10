# DSH / AppServer protocol boundaries

## Ownership

- DSH owns sessions, durable events, running turns, queued messages, pending
  questions and approval decisions. The bridge must not infer an answer from
  a tool label or terminate a wait merely because a renderer disconnected.
- `DshClient` owns HTTP envelopes and multiplexed event envelopes. It preserves
  the native `rpcId`; `/api/respond` uses `client-response`, not `client-request`.
- `DshInteractions` owns only pending wire correlations and response translation.
  It replays pending requests to subscribers, suppresses simultaneous duplicate
  responses, and withdraws requests on DSH resolution or an accepted receipt.
- Each downstream WebSocket tracks which threads it opened and which requests
  it was offered. Initializing a client or probing a connection is not permission
  to answer every pending question on the host.
- `DshToolProjection` joins calls/results for both history and live projection.
  The result identity is `message.source.callId`, and output is nested inside
  `message.content[].content`. Never invent a shared `unknown` item ID.

## Mapping

| Native input | AppServer output |
| --- | --- |
| question/requested + envelope rpcId | item/tool/requestUserInput server request |
| question/resolved | serverRequest/resolved |
| approval/requested | item/commandExecution/requestApproval, allow once or reject only |
| approval/resolved | serverRequest/resolved |
| JSON-RPC answer | POST /api/respond using the original DSH rpcId |
| tool/call | item/started with stable call identity |
| tool/result | item/completed for the same item, preserving name and arguments |
| turn/end with unfinished tool | unsuccessful tool completion before turn completion |
| foreground bash | commandExecution with commandActions, outputDelta, exitCode and duration |
| todo/write | turn/plan/updated and a stable plan item for history |
| goal/change | thread/goal/updated or thread/goal/cleared, independent of TODO |
| thread/goal/get | authoritative session.history goal projection |
| assistant/message | deferred phase: commentary before further work, final_answer on successful turn end |

`DshTurnProjection` is the shared ordered fold for history and live events.
An unfinished message keeps a null phase until its execution boundary is known.
Command classification is display-only and conservative: compound shells,
expansions and unsupported flags remain unknown. Background bash stays a generic
tool result rather than pretending its process has exited. Foreground result
markers distinguish nonzero exits, timeout and signals from success.

Goal reads and notifications do not implement goal mutation or budget accounting.
DSH exposes no goal token/time counters: protocol-required counters are zero
(no recorded usage), tokenBudget is null; they are not measured consumption.
Goal mutations must not be advertised as supported until explicitly translated.

Generic tool approvals have no fabricated shell command: command remains null
and reason names the tool. Persistent grants are rejected, not silently widened.
DynamicToolCallStatus has no interrupted variant; the tool becomes failed while
its owning Turn carries the interrupted status.

## Verification and remaining limits

`npm run test:dsh-bridge` covers native envelope round trips through real HTTP/
WebSocket transports with a fake DSH server, downstream reconnect, preflight
isolation, response races, cancellation during context lookup, and tool identity.
It does not replace a live model/macOS acceptance test.

This is not a claim of complete DSH feature parity. In particular, native question
multiSelect/intent presentation, recovery of missed upstream timeline events,
history pages beginning after a tool's call, and model-modality catalog propagation
still need explicit protocol work. Do not add renderer heuristics or mark these
capabilities supported merely because a generic tool card can be displayed.
