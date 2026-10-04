## goal
Prevent live assistant updates and history hydration from moving established conversation rows or erasing concurrently observed content.

## non_goals
- Do not combine Codex Dot and task chat renderers/scrollers, change engine binaries, restart previews, or commit/publish unrelated work.

## requirement_ids / requirement_refs / requirement_excerpt
- User confirmed the defect: streamed replies appear above the latest user message while older messages remain below; use the supplied Codex 26.930.31428 Renderer for modeling.

## interface_refs / data_structure_refs
- `appserver-session/src/merge-turns.ts`: incremental updates versus ordered history windows and single-Turn hydration.
- `appserver-session/src/resume-coordinator.ts`: generation-scoped history commit.
- `appserver-session/src/conversation-navigation.ts`: lightweight locator index and hydration.
- `workbench-runtime/src/appserver-runtime.ts`: commits Session reconciliation into the compatibility View feeding Replica/Chat Runtime.
- `timeline-virtualizer/src/virtualizer.ts`: intermediate mounted-window handoff, separate from persisted restoration and transcript order.
- Invariants: content updates retain position; a partial index cannot globally reorder unseen rows; observations after a history request starts cannot be revoked by its response; IDs are not timestamps.

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- relevant_evolution: September 26 ordered Resume reconciliation addressed cached final-first history; background and navigation hydration still have separate merge policies.
- superseded_refs: none. The new Codex task history planner uses entity/position keys; Dot's createdAt comparator is not a task-history contract.

## acceptance
- Deterministic interleaving reproduces defects before the fix and retains order/content after it.
- Real Conversation DOM consumes the same reconciled source without remounting; streaming/completion, history fills and foreign Thread events covered.
- Relevant Session/Runtime tests, typechecks, boundary and documentation checks pass.

## affected_paths
- `opencraft/packages/appserver-session/src`, `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`, `opencraft/packages/timeline-virtualizer/src/virtualizer.ts`, focused tests/browser fixture, package test entries and formal design.

## required_context
- Router: `agent-gateway-runtime`.

## context_receipt
| File | Reason | Decision |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Scope and validation | Preserve dirty work and do not deploy |
| `docs/context/domains/agent-gateway-runtime.md` | Router must-read | Fix conversation authority, not model gateway |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | Maintenance skill | Ownership, interleavings and real component verification |
| `opencraft/docs/chat-ui-architecture.md`, `opencraft/docs/platform-architecture.md` | Shared read-model contract | Session owns V3 compatibility, views do not sort |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`, `frontend/vitest.config.ts` | Required adjacency check | Frontend test boundary; no source synchronization needed |
| `docs/context/tasks/2026-09-26-opencraft-resume-order.md` and checkpoint | Prior evolution | Preserve ordered-history repair |
| `docs/context/tasks/TASK-TEMPLATE.md`, `.agents/context/change-impact.json` | Task and impact rules | Update mapped formal domain |
| New Codex `chunk_reo.js`, `chunk_deo.js`, original `local-conversation-thread` | Read-only latest reference | Stable history position distinct from live payload and activity |

## evidence
- Navigation commit globally sorts the entire loaded View by an incomplete locator Map and sends all unknown rows to the end. This can put old loaded rows after a newer stream.
- Background drain and older-page reads reconcile full Item snapshots against the current View without capturing their pre-request observation boundary.
- Before repair the new deterministic history tests failed on four distinct order/content assertions. After repair they passed.
- Real Conversation smoke exposed another regression: inserting history inside the mounted window evicts the old last row because intermediate reconciliation preserves only start anchor plus count. A new virtualizer test failed with endIndex 4 instead of 5; retaining surviving mounted identities fixed the intermediate handoff and the real DOM identity assertion.
- This is source/replay evidence, not definitive attribution of every historical production incident. Latest Codex recovered Renderer informed identity/position separation; its backend is not part of this task's reference.

## risks
- Codex V3 has no per-Item comparable revision. Protect observations since request start, while accepting history topology for its declared window; do not claim server-side causality beyond that contract.
- Existing source edits belong to prior tasks. Layer this change without reverting them.

## validation
- Session/Navigation/Chat Runtime/Workbench regression suite: 90/90 passed; virtualizer suite: 58/58 passed. Includes deterministic held history responses, cached navigation previews and foreign Thread notification fencing.
- Session, Workbench Runtime, Web and virtualizer typechecks passed; typography generation and platform boundary checks passed.
- Real Conversation/projectTimeline smoke passed desktop and touch-sized Chromium: eight stream/history/hydration cycles each, unchanged order and same live DOM instance, then completion without losing text; no page errors. Isolated synthetic data, no accounts/inference. This is not iPhone or Electron acceptance.
- Existing Chromium first lacked portable libraries. Reused libgbm/libasound and signature-verified a mirror package for libwayland into a temporary directory only; no system dependency installation or preview change.
- Documentation validator, explicit-path mapped impact check and scoped diff whitespace check passed. Required staged impact check passed with no staged files; explicit paths provide the meaningful task evidence.

## decisions
- Repair history ingestion in Session; remove Workbench's independent whole-list sorting. Rendering and scrolling remain consumers.
- Fix the verified virtualizer handoff without merging Dot/task renderers, changing response placement or forcing bottom scroll. Persisted anchor/count restoration remains unchanged.

## scan_scope
- Session, Chat Core/Runtime, Workbench conversation/runtime, bounded latest Codex entrypoints.

## scan_output
- Bounded exact searches; no private message payload exported.

## handoff
- Source implementation and focused verification complete; current preview is unchanged. No commit, push, deployment or restart.
