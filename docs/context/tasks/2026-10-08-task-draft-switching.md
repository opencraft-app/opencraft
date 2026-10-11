---
id: task-draft-switching-20261008
type: task
scope: Task input retention and attachment ownership across conversation switching.
triggers: ["Task conversation draft switching"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/workbench-runtime/src/conversation-draft-owner-registry.ts
  - opencraft/apps/workbench-web/src/runtime/workbench-navigation-transaction.ts
status: retired
reviewed_at: 2026-10-08
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: false
---

# Task conversation draft continuity

## goal
Keep unsent text, images and ordinary files when switching Task conversations, with a 50-content-draft LRU budget independent of presentation caching.

## non_goals
- Attachment persistence after a full browser refresh, server synchronization, or remote message delivery changes.
- Replace the Dot/Bot chat design, deploy or restart the user's preview.

## requirement_ids / requirement_refs / requirement_excerpt
- Current user conversation: switching conversations is the required attachment lifetime; empty inputs do not count; automatically delete the least-recently-used draft above 50.
- Follow-up authorization: commit this change, merge it into master and push master; no preview replacement requested.

## interface_refs / data_structure_refs
- `opencraft/packages/workbench-runtime/src/conversation-view-registry.ts`: View/Scope borrowing and physical retainers.
- `opencraft/packages/workbench-runtime/src/conversation-draft-owner-registry.ts`: one editor-slot owner per View identity; no Thread/Host lease.
- `opencraft/packages/workbench-runtime/src/conversation-draft-continuity.ts`: the sole Task document storage writer.
- `opencraft/apps/workbench-web/src/runtime/workbench-navigation-transaction.ts`: successful sidebar selection restores a prior View; explicit navigation remains independent.
- `opencraft/packages/codex-composer/src/attachment-preview-session.ts`: File/blob/job lifecycle follows Controller and original Draft ID.

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`, `opencraft/docs/platform-architecture.md`, `opencraft/design/invariants.md`, `opencraft/design/application-navigation/task_plan.md`.
- relevant_evolution: master `e93779c259` added browser-local drafts; current base `a7f604f2a3` retains View-owned Composer with a 20-inactive-View cache. A completed A→B→A sidebar cycle creates another View instead of using the retained original.
- superseded_refs: none.

## acceptance
- Complete A→B→A restores the identical Controller, image preview and exact File bytes; no autonomous sends.
- A late attachment result updates A only while B is visible.
- Evicting a presentation after 20 inactive Views does not discard its nonempty draft.
- Adding content to draft 51 deletes the least-recently-used eligible draft and releases File/blob/processing resources; empty editors consume no content slots.
- Explicit same-conversation Views remain independent; POP restores its entry; failed/stale navigation cannot publish preferred View.
- Clear, successful send, failed send and account revocation preserve their existing ownership semantics.
- Real CodexComposer browser verification at desktop and narrow widths; only remote activation/upload boundaries are synthetic.

## affected_paths
- `opencraft/packages/workbench-runtime/src/`, Task navigation transaction and Web runtime composition.
- Focused tests, a real-component smoke fixture, package script, and mapped architecture/design documents.

## required_context / context_receipt
| File | Reason | Decision |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Authorization and shared-domain ownership | Isolated source work; commit/merge/push authorized by follow-up, no restart |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md` | Draft/resource lifetime and evidence discipline | Controller identity plus exact file/preview checks in real components |
| `opencraft/docs/platform-architecture.md` | Runtime and Router lifetime | Draft owner holds no physical execution leases |
| `opencraft/docs/chat-ui-architecture.md` | Existing document persistence and attachment lifetime | Keep the original Controller, not another writable snapshot |
| `opencraft/design/invariants.md`, `opencraft/design/application-navigation/task_plan.md` | Independent View and navigation semantics | Preferred selection differs from explicit new View |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Neighbor check | Inspected the existing navigation and attachment tests; completed switching was missing |
| `docs/context/project/services/frontend.md` | Context-router must_read result for navigation wording | Task implementation stays in OpenCraft, not frontend |
| `docs/engineering/journeys/agent-request-streaming.md` | Mapped change-impact contract | Unsent input and File ownership remain separate from Agent execution |
| `.agents/skills/gongfeng/SKILL.md`, `DEPENDENCIES.md` | Authorized repository delivery | Reuse existing local authentication without exposing secrets |

## evidence
- Pre-change integrated navigation/attachment probe: original A has both ready attachments; returned A is a new Controller with zero attachments.
- Existing relevant tests pass but cover returning while B is pending, not after B completes.
- Final focused run: 128/128 tests passed, covering Controller truth, owner quota, navigation, promotion, Scope retention, continuity and attachment resource rollback.
- Full workspace TypeScript, boundaries, latest Web build and diff whitespace check passed.
- Fresh-build real CodexComposer browser smoke passed at 1280px and 390px: original Controller/Draft identity, exact image/Markdown bytes, late-result isolation, View eviction, settlement and account revocation. Synthetic remote boundaries; zero real messages sent.
- Documentation validation has no errors or broken links. Full repository Context catalog validation retains unrelated baseline schema/secret-reference findings; no general green-catalog claim.
- Staged change-impact validation passed with the mapped request-streaming owner contract synchronized; staged diff whitespace check passed.
- Full product gate passed TypeScript and its preceding AppServer/extension/desktop stages, then stopped in `tests/ssh-native-surface.test.ts:71`: thread capabilities contain `pin: false`, missing from the test's expected object. This task changes neither that assertion nor its capability implementation; no unrelated repairs were made. SSH group: 75 passed, 1 failed, 1 skipped.
- Independent delivery review found no blocking source risk or new credential/machine-path material. The SSH assertion, capability implementation and relevant bridge/fixture are unchanged from the base. Fetching the latest master succeeded; its six additional commits do not overlap the staged implementation.

## risks
- Promotion aliases, account changes and expired route entries must not attach a second persistence writer or resurrect evicted content.
- Protect active/submitting content; capacity exhaustion must not destroy an active owner.
- Owner LRU must not be refreshed by a late upload result alone.

## validation
- Focused owner/navigation/View/continuity/attachment/switch tests, package type checks, boundaries and Web build.
- Real-component browser smoke; documentation and staged change-impact validation before handoff.

## decisions
- Application owns unsent input through a stable editor-slot registry; cached Views borrow it.
- Task document continuity remains the only persistence writer. File/blob resources remain process-local.
- Router owns bounded preferred-View memory; draft owners own content lifetime and eviction.
- LRU quota counts content, not empty pages. User selected automatic oldest-unused deletion.
- New-chat Scope metadata excludes retained input from its separate 20-empty-record budget; otherwise a semantic record could expire before its still-owned attachments. No execution lease is added.

## scan_scope / scan_output
- Bounded exact searches of Task navigation, View/Scope/Composer and attachment session call sites; no production scans.

## handoff
- Source implementation and focused verification complete in an isolated worktree. Full product gate stopped at the unrelated SSH capability assertion described above. The user subsequently authorized commit, merge and push to master; delivery is now in progress. Current running preview remains unchanged.

## stage
Source and focused verification complete; authorized master delivery in progress, with the full-gate baseline SSH assertion recorded.

## verified
- 50 nonempty Task input slots are independently retained; empty inputs do not consume quota. Oldest unused content eviction releases attachments and saved documents.
- Complete switching, promotion after View eviction, 50 New-chat inputs and late settlement are covered by executable tests and current browser components.

## unverified
- No change has been deployed to the user's current preview. Native device attachment interaction and production upload/remote inference were not exercised.

## discard
- View-cache lifetime as input lifetime, copying attachment metadata into a new Controller, and silent quota overflow are superseded.

## restore
- Use the draft owner registry, View borrowing, Controller retained-content probes, and the new task-switching test/script entrypoints. Formal contract is in ChatUI/platform architecture and design invariants.

## next_action
- Commit the reviewed change, integrate the latest remote master, verify the merged source and push/merge with observable remote evidence. Keep the running preview unchanged; resolve the SSH capability test separately if a fully green product gate is required.
