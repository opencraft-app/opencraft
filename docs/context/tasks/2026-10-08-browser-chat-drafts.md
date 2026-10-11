---
id: task-browser-chat-drafts-20261008
type: task
scope: Browser-local Composer content persistence for task and Bot chats
triggers: ["chat draft", "浏览器草稿"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/packages/composer-core/src/store.ts", "opencraft/apps/workbench-web/src/runtime/browser-composer-drafts.ts"]
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## goal
Keep unsent task/Bot chat input across browser refresh without synchronization; commit,
push and merge the isolated change onto current master as explicitly requested.

## non_goals
Preview replacement, automatic submission replay, outbox durability, execution
locks, durable original browser File bytes, ephemeral Side Chat restoration,
and delivery of unrelated prototype/Dot/desktop changes.

## requirement_ids / requirement_refs / requirement_excerpt
DRAFT-LOCAL-01: user requests browser-local chat drafts, no synchronization.
User subsequently authorized commit, push and merge into master.

## interface_refs / data_structure_refs
ComposerDraftStorage stores versioned document/attachment metadata/context.
Task Views retain existing ConversationDraftContinuity without a second writer.
Bot keys use product/account and Host/conversation. Models/preferences retain
their existing authority. Old-account adapters are revoked on scope changes;
a fresh application binds the next account's adapter.

## history_context
Previous draft retention was application-memory only. Browser File bytes and
Object URLs were never durable. See Chat UI Browser-local input drafts and
design/invariants Application navigation restoration.

## current_design_refs
opencraft/docs/chat-ui-architecture.md; opencraft/design/invariants.md.

## relevant_evolution
Master already has task View continuity; reuse that owner rather than installing
the earlier prototype's parallel task storage port.

## superseded_refs
Earlier Task bootstrap rejected all non-promoted process-local Draft IDs; saved
input placement now allows validated client identity restoration, not execution.

## checkpoint
Task new-Draft refresh now passes actual browser checks. Root cause: account
service disposal rotated the durable credential scope even without an identity
change. Disposal now only revokes asynchronous authority; real sign-out still
rotates scope. Saved placement restores client identity, not execution state.
Original dirty implementation is preserved; no preview switch is authorized here.

## acceptance
Structured text survives reload and target navigation. Failure retains input;
clear removes storage. Lifecycle/dispose cannot overwrite newer content. Corrupt or
blocked storage does not prevent editing. Missing attachment bytes cannot send.

## affected_paths
Composer core; Web storage/bootstrap; Bot View/extension; focused tests/docs.

## required_context / context_receipt
Root/local AGENTS, maintenance Skill and verification checklist, delivery flow
and previous desktop delivery Task Pack were read. Context router had no match.
Bounded Composer/View searches and package exports/test neighbors were inspected.
Chat architecture and navigation invariants supplied the design authority.

## risks
File bytes and ephemeral Side Chat restoration remain incomplete. Missing
attachment bytes restore as failed removable cards. No cross-tab live sync.
Storage failures preserve memory input and emit content-free diagnostics.

## validation / handoff
Original implementation passed core/local-storage tests, types, boundaries,
Web build and browser reload/isolation/clear at desktop/mobile widths. Delivery
is isolated from the dirty implementation checkout, rebased onto current master
and adapted to its existing Bot View rather than including the Dot prototype.
Master already contains View-owned task continuity. Browser verification exposed
new-Draft identity loss on refresh; its existing document envelope now also saves
placement. Bootstrap restores the exact client identity for a configured enabled
Host, respecting canonical promotion aliases first. Browser writes have no
debounce gap. The originally proposed parallel task Composer port is not installed.
Final isolated-master state: 96 focused core/draft/navigation/account tests and
32 Bot-management tests passed; five affected package typechecks, platform and
typography boundary checks and Web build passed. Browser smoke passed at 1280px
and 390px with actual Bot Source/View/Composer (remote service simulated), plus
the complete built task application: refresh restores, clear stays clear,
Bot room inputs isolate, and reload makes zero Bot sends. Documentation/link
validation and staged documentation-impact passed. Repository context catalog
validation still reports unrelated historical schema/scan findings; it is not
reported as green. No preview switch is part of this Git-only delivery.
