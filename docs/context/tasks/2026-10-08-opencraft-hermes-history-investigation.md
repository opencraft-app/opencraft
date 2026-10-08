---
id: opencraft-hermes-history-investigation-20261008
type: task
scope: Read-only investigation of missing Hermes history in OpenCraft.
triggers: ["opencraft Hermes history investigation"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/HISTORY.md]
status: candidate
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## goal
Identify concrete OpenCraft bridge/client causes of Hermes history not appearing.

## non_goals
No product code edits, Hermes edits, commit/push, restart or preview replacement.
No account credentials copied or paid inference. The user's specific remote session
is not yet identified; source/fixture evidence must not be presented as that live response.

## requirement_refs / requirement_excerpt
User: inspect OpenCraft's Hermes bridge; history seems unavailable.

## interface_refs / data_structure_refs
HermesDashboardHistoryClient GET /api/sessions/{storedId}/messages;
HermesTranscriptWindow; adapter.readTurnsPage; message-window history strategy;
reconcileHistoryWindow; Bot conversation/read, messages/list and viewport demand.

## history_context
- HISTORY.md specifies 120 source rows per REST demand and returns the accumulated
  loaded window. Client replaces prior history groups because their membership
  can change at partial boundaries; independently owned execution is preserved.
- git blame identifies af7e7d04b2 as introducing adapter Turn slicing/cursor math
  contrary to this contract. No inference about author intent.

## affected_paths
Read-only inspection of lightvela-hermes bridge/transport, appserver-session,
bot-conversation-appserver and Bot chat viewport. Product files not modified.

## context_receipt
Root/OpenCraft AGENTS, maintenance skill and verification; Context Router matched
identity-access due generic session trigger (read it, not a runtime authority).
Frontend adjacency inspected earlier in this turn, with actual Hermes history
integration/reconstruction tests as relevant runtime neighbors.
Bounded failed guesses: nonexistent plugin AGENTS and session-source filename;
resolved real files using rg --files. Transcript layout task superseded by user.

## acceptance / validation
- Same 12 focused history tests run in primary and current-preview source:
  10 pass, 2 fail in both, integration :86 and reconstruction :52.
- Synthetic 524-row adapter trace: initial tail yields 1 group/61 items;
  next 3 backfills yield 0 groups/0 items despite HTTP reads; last page yields
  only older 2 items, dropping the long execution. Script retained at
  /data/opencraft-hermes-history-inspect-1uNYL2/trace.mts.
- Delegated read-only Bot fixture runs real adapter -> Bot handler -> source ->
  timeline: 261 tool-heavy rows produce zero messages/executions/units with
  hasOlder=true and cursor=120. Viewport requires units.length>0 for initial
  auto-backfill and actual scroll for manual backfill, leaving this state stuck.

## evidence / handoff
- Concrete mismatch: adapter.ts 1310-1323 filters/slices Turn groups using source
  row offsets; merge-turns.ts 244-255 replaces prior history with returned groups.
- Separate Bot demand gap: conversation-viewport.ts 172 excludes empty visible
  windows; bot-protocol-handler.ts only projects user/agent messages and retains
  running/failed executions, so completed tool-only source windows can be empty.
- Correct repair direction: preserve source row cursor, project the whole loaded
  window for generic Thread, and represent empty-but-more Bot pages as incomplete
  history with bounded demand/progress rather than an empty conversation.
- Possible Bot reconnect freshness gap identified but not part of confirmed live
  incident; source load ready-short-circuit lacks verified connection resync here.

## stage
Read-only findings ready for user; no fix or deployment made.
## verified
- Deterministic failures reproduced in primary and preview source without remote
  login or inference. Hermes durable HTTP history port is wired in transport.
## unverified
- User's concrete Host/Bot/session, page type and actual remote response unknown.
## discard
- Do not equate no visible messages with no stored history or server data loss.
## restore
- Primary /data/opencraft-disclosure-refactor-20261006; preview source
  /data/opencraft-drafts-chat-preview-frwkr6/repo; trace path above.
## next_action
- Obtain affected session/view details or user repair authorization; do not restart.
