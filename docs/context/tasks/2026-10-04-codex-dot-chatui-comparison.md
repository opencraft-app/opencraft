## goal
Compare Dot ChatUI with ordinary Codex task conversations in the supplied 26.930.31428 / build 12913 Renderer, distinguishing client evidence from architectural recommendations.

## non_goals
- No application implementation, restart, deployment, Git operations or reference-package edits.
- No inference about unavailable cloud scheduling internals or feature availability from a static bundle alone.

## requirement_refs
- User: “看一下，我希望你看一下 dot chatui和普通会话有什么差异”.
- Supplied package: `/data/codex-new/codex-26.930.31428-12913`.

## interface_refs / data_structure_refs
- `analysis/dot-interaction/native-room.js`: Room controller, optimistic delivery, history merge, attachment/task cards and reply UI.
- `unpacked/webview/assets/composer-controls-539aa7e58fa6.js`: `ci` merges request/message identities, sorts confirmed messages by `createdAt`, and anchors pending rows; `li` merges/deletes; `ec` presents the messaging surface.
- `analysis/wakaru-standard/app-initial-970035cbb6b0/chunk_J1o.js`: structured room messages and idempotent HTTP send.
- `analysis/wakaru-standard/app-initial-970035cbb6b0/chunk_PJa.js`: separately fenced Room live subscription and linked execution state.
- `analysis/wakaru-standard/app-shared-e760024b6716/chunk_uIn.js`: messaging notifications, reconnect resync and typing reset.
- `analysis/wakaru-standard/app-shared-e760024b6716/chunk_Ean.js`: ordinary thread manager start/steer/follow-up delegation.
- `analysis/wakaru-standard/app-shared-e760024b6716/chunk_ian.js`: ordinary queue coordinator uses current execution state, pending starts and final answer.
- `analysis/wakaru-standard/app-initial-970035cbb6b0/chunk_reo.js`: ordinary Turn render projection retains history position and entity keys.
- `unpacked/webview/assets/app-primary-f4bbd2125a77.js`: ordinary Working / Worked for / You stopped after presentation.

## history_context
- This package is the new reference; older `/data/mono2/ref/codex` snapshots were not used as evidence for this version.
- Wakaru chunks and `native-room.js` are analysis artifacts, not independently runnable source or cloud service implementations. Selected behavior was cross-checked with the corresponding original Renderer bundle.

## acceptance
- Explain UI, message identity/order, send semantics, execution association and recovery differences with precise local references.
- Separate verified client behavior from recommendations for OpenCraft.

## affected_paths
- This analysis Task Pack only.

## required_context
- Root and OpenCraft AGENTS; OpenCraft maintenance skill.
- Context Router returned no matching Pack; searches bounded to the supplied package.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `/data/mono2/AGENTS.md` | Analysis boundaries and evidence | No service modifications |
| `/data/mono2/opencraft/AGENTS.md` | Local reference conventions | Preserve dirty worktree and authority boundaries |
| `/data/mono2/opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Ownership and reference comparison | Distinguish model, interaction and runtime |
| Package `ANALYSIS-ZH.md` | Reference provenance and entry routing | Bound inspection; independently inspect relevant implementation |

## evidence
- Read Room send implementation: complete immutable request is transferred into an optimistic structured message before draft/upload clearing; completion is account/session fenced. Unknown delivery is distinguished from rejection, and safe retries retain the original request.
- Original `ci` merger reconciles request IDs to authoritative message IDs and preserves reply metadata; confirmed chronology uses creation time, not delivery status or last update time. Pending rows have explicit insertion anchors.
- Typing lives in a separate timed service and clears on resync/disconnect; message notifications trigger delta, updated-message or snapshot reconciliation.
- Room live uses room/subscription identity, monotonic revision and a generation/account fence. It watches execution activity; it is not the Room message ordering authority.
- Dot task/subagent references render as buttons opening a task/detail panel. Replies, reactions, media/files, voice history, widgets and message receipts are separate content/interaction capabilities.
- Ordinary rendering projects Thread Turns/Items into history-positioned entries; ordinary follow-up coordination distinguishes start, steer, pending admission and final answer.

## risks
- No macOS desktop execution or live cloud API verification. Client existence does not prove public enablement or cloud-side behavior.
- Do not describe Dot chronology as server-sequence ordering: this inspected implementation sorts confirmed rows by `createdAt`.
- Do not equate stopping a view subscription with stopping backend work.

## validation
- Static inspection only; esbuild parsing/formatting of original chunks without executing the reference code. No source lint/test gate is applicable to this comparison.

## decisions
- Conclusion: Dot is messaging-first with linked executions; ordinary Codex conversations are execution-first. They reuse UI primitives and content renderers but retain different writable models/protocols.
- OpenCraft recommendation (not a claim about Codex cloud internals): share stable message/content/delivery/execution identities and explicit relationships; use distinct message-first and execution-first projections, rather than forcing all Bot messages into Turn-shaped containers.

## scan_scope
- Supplied `analysis/dot-interaction`, relevant Wakaru app-initial/app-shared chunks and named original Renderer assets.

## scan_output
- Targeted read-only excerpts; no generated reference changes.

## handoff
- Comparison complete. No new implementation or deployment performed for this task.

## Follow-up: shared UI, scrolling and iframe
- User asks whether Dot and ordinary conversations share one UI/scrolling implementation and whether the chat is an iframe. Static inspection only.
- Context Router's broad `UI` trigger matched `frontend-product-surface`; its required `docs/context/project/services/frontend.md` was read. This follow-up does not change or investigate the frontend service.
- Actual ordinary path: `local-conversation-thread-444c8dd8a146.js` imports and renders `ThreadScrollLayout` from `thread-scroll-layout-f1b3ae158409.js`, and `VirtualizedTurnList` from `virtualized-turn-list-40304f88641e.js`. The latter uses `thread-virtualizer-e1964ca5c039.js` with measured Turn heights, stable keys, overscan/range calculation and anchor compensation.
- Actual Dot path: the same route module separately renders `lazy-room-view-c0edc956fd33.js` -> `room-view-aa08a6e853b4.js` -> native Room. Its messaging surface in `composer-controls-539aa7e58fa6.js` renders `div.conversation-viewport`, `div.messages-scroll` and `div.message-list`, rather than framing the transcript in an iframe.
- Dot's `Bs` scroll hook owns per-room View geometry: initialized/loaded state, nearBottom, scrollTop/height, anchorId/anchorOffset, firstId/lastId and scrollToLatest. It captures a visible message anchor before history updates, preserves that anchor away from the bottom, follows new content near the bottom, observes viewport/list/footer sizes, handles image load/window resize, and loads older messages near the top. Focused reply chains have a separate local scroll implementation (`Ss`).
- Ordinary scrolling and Dot scrolling are not one shared controller or virtualizer. Both implement reading-position preservation, bottom follow, content-growth handling and Composer geometry, but use different entity keys and layout mechanics.
- Confirmed avatar iframe: `analysis/wakaru-standard/app-initial-970035cbb6b0/chunk_iYa_2.js:543` renders an iframe titled `Character preview`, with sandbox `allow-scripts allow-same-origin`, `tabIndex=-1`, `aria-hidden`. The parent sends `orbit-character` activity/state and pointer/gesture events through `postMessage`, fenced by source window/origin. This isolates animated avatar rendering, not message history, Composer or the main chat scroller.
- Recommendation only: shared scroll invariants and geometry contracts are appropriate, but different message/Turn projections and virtualized/nonvirtualized policies need not become one monolithic UI implementation. No recommendation to put the chat transcript into an iframe.
