---
id: opencraft-hermes-history-repair-20261008
type: task
scope: Repair Hermes loaded history windows and Bot history continuity.
triggers: ["opencraft Hermes history repair"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/HISTORY.md
  - opencraft/docs/chat-ui-architecture.md
status: candidate
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## goal
Restore monotonic loaded history and recoverable empty-but-more Bot pages without
changing Hermes or turning presentation groups into pagination authority.

## non_goals
- No Hermes source edits, remote credentials, inference, deployment or restart.
  Existing auto-connect edits are preserved and remain separate.
- No new transcript database, UI redesign or eager all-history drain.

## requirement_ids / requirement_refs / requirement_excerpt
Requirement ID: unknown (direct user request in this conversation).
User approved the bridge + Bot history repair after the read-only investigation:
“搞起来。” The specific affected remote session is still unknown; fixture proof
is not evidence of data loss or live recovery in that session.
Follow-up authorization: “提交，推送，盒入master”. Deliver this repair through
the normal Git/MR workflow; no preview restart or unrelated auto-connect delivery.

## interface_refs / data_structure_refs
- Hermes REST messages: chronological source rows, latest-relative offset,
  limit 120, include_compacted=true, scoped stored session.
- Thread message-window history returns the accumulated loaded projection;
  AppServer Turn limit cannot slice or redefine that source row window.
- Bot read/list source, event cursor and viewport demand remain separate owners.
- Refresh and backfill cannot replace newer live observations, resurrect deleted
  conversations, cross Host/profile identities, or accept a stale read generation.

## history_context
- current_design_refs: HISTORY.md, chat-ui-architecture.md, design/invariants.md
  and docs/engineering/journeys/agent-request-streaming.md.
- relevant_evolution: HEAD 3202fc02c has a source-row window contract but the
  adapter still slices Turns; this change removes that conflicting projection.
- superseded_refs: the old Turn-slicing behavior is not a fallback authority.
- Prior investigation: 2026-10-08-opencraft-hermes-history-investigation.md.
- Current HISTORY.md already requires full loaded-window replacement.
- Exact reference Hermes Agent desktop pin: 3c3ab69abb9b08683b5eb15b4e2b8be1198c875f;
  api/sessions.ts, transcript-tail.ts, transcript-backfill.ts, hydration.ts and
  session-actions implement row cursors, scoped reads, prefix anchors and live overlays.
- Reference is read-only and not a claim of a perfect empty-page implementation.

## affected_paths
- opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/
- opencraft/packages/bot-conversation-appserver/src/source.ts
- opencraft/plugins/bot-chat/src/
- Focused Hermes/Bot history tests and the corresponding formal docs.

## context_receipt
- Root and OpenCraft AGENTS; maintenance SKILL.md and verification.md.
- Context Router query returned no matching pack; bounded exact searches located
  HISTORY.md, adapter.fetchTurnsPage, source.hydrate/loadOlder and Bot viewport.
- Frontend runtime adjacency card read; Hermes integration/reconstruction tests
  inspected as the actual protocol/runtime neighbors (no frontend edits).
- platform-architecture: application/package ownership and embedded/Bot boundaries.
- chat-ui-architecture: history positions/concurrent observations and recovery.
- change-impact mapping and agent-request-streaming formal journey read.

## acceptance / validation
- Reproduce the old long-tool execution and Turn-limit failures, then restore
  complete source-window projection with one REST request per explicit demand.
- Cursor advances in source rows; tail refresh preserves loaded prefix/progress.
- Empty Bot projections can make bounded progress without physical scrolling;
  failures and non-progressing cursors remain recoverable, not infinite requests.
- Resync retains anchored older history and independent local/live messages;
  late backfill after resync/delete/dispose is rejected.
- Focused tests, affected workspace typechecks, Bot management tests, boundary
  checks and isolated real component/browser proof, with external calls simulated.

## risks / decisions
- Anchorless refresh must not silently authorize stale history; cache is display
  continuity, never execution authority. Keep original scope and generation checks.
- Bot message projection may intentionally omit tool activity; empty display does
  not imply empty source history. Repair demand rather than inventing tool text.
- Source checkout differs from the combined running preview. Do not claim these
  edits are live until a separately authorized build/switch is verified.
- Durable confirmation retires a local overlay on refresh or backfill. Old send
  results settle from that receipt instead of reverting it to a failed draft or
  regressing execution. Concurrent same-client sends do not issue another RPC.
- Empty-history demand survives effect-owner rehearsal. The pre-existing geometry
  owner's full StrictMode cleanup limitation is not fixed or claimed tested by
  that demand test; production entry currently does not use StrictMode.

## evidence / handoff
- Source implementation complete, disjoint bridge/Bot owners plus independent
  cross-contract review. Before-fix targeted bridge tests and empty-demand/live
  continuity tests reproduced failures; the changed paths now pass.
- Bridge history/window/cancellation/plugin: 105/105 passed. Combined history,
  Bot source/demand, profile tests: 136/136 before the final four send-adoption
  regressions; final source/demand/integration/existing AppServer suite: 32/32.
  Bot management: 32/32. Affected workspaces typecheck, boundaries and diff check
  passed. Final Web build and the browser rerun after all source edits passed;
  Vite retains its existing unresolved asset/dynamic-import/chunk-size warnings.
- Real Chromium proof used this checkout's built product CSS and actual Hermes
  Adapter/Handler → AppServer memory transport/Cordis → Bot Source/View.
  Only native Hermes RPC/REST simulated. Desktop 1100 and narrow 390 viewport:
  empty projection advances, three-page cap/explicit continuation, error retry,
  mounted message survives completed resync, no overflow, light/dark captures.
  Shared quiet-control replaced the initially unstyled recovery button.
  Latest browser evidence: /tmp/opencraft-hermes-history-evidence-aSQgQe.
  Actual recovery-button appearance is none and border is zero; no UA frame.
  Independent review replayed the original late-send failure fixture and confirmed
  the adopted message remains sent and returns a successful confirmed receipt.
- Documentation validation and explicit changed-path impact validation passed.
  Whole-repository context validation fails on pre-existing older task metadata,
  instruction-size/secret-scan findings; no claim of a clean repository-wide gate.
- Implementation-stage evidence above predates commit/push/merge authorization.
  No Hermes source edits, real remote session/inference or service switch.
  Existing auto-connect edits are intact and remain unrelated.

## delivery
- Scoped repair files independently reviewed; six auto-connect paths are excluded.
- Reuse the existing host-owned Git and Gongfeng configuration without copying
  credentials into command arguments, the repository or output.
- Fetch current master and integrate in an isolated checkout before pushing;
  merge only through the normal server policy, never bypass required reviews.
- Source commit `ea2834606` was cherry-picked onto fetched master `541705b15`
  in an isolated checkout as `f62d25026`; automatic merges preserve the newer
  Bot draft-storage injection. Independent review found no draft-owner change.
- The isolated checkout installed its own lockfile dependencies. Focused
  history/profile/Bot/draft regressions passed 156/156; Bot management 32/32;
  three affected workspace typechecks, boundaries, Web build and diff check pass.
  History browser proof passed desktop/narrow and light/dark with built CSS
  at `/tmp/opencraft-hermes-history-evidence-1Eun2H`; browser draft smoke passed
  1280 and 390 widths. All native Hermes calls remain synthetic.
- Feature branch `fix/hermes-history-20261008` was pushed normally; remote
  `ls-remote` confirmed `f62d25026`. Master still reports `541705b15` at this
  point. No claim of merge or preview replacement.
- Git authentication is available, but the existing MCP configuration requires
  a missing `GONGFENG_TOKEN`; the configured Git credential cannot authenticate
  the MR API (`Unauthorized`). Browser inspection is unavailable for this page
  (`PREVIEW_BRIDGE_UNAVAILABLE`). Requested a current API credential; do not
  bypass review policy or publish any credential values.

## scan_scope / scan_output
Exact bridge, source and viewport paths plus selected reference Desktop files;
no new repository-wide product scan. Protocol fixtures contain synthetic data.
