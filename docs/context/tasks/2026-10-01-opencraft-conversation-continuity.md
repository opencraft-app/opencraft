## goal

Make OpenCraft conversation continuity a shared Web/Desktop/Expo model: preserve unsent drafts by account/Host/conversation identity, display previous messages without claiming stale history is authoritative, and refresh visible conversations after mobile foreground/network recovery.

## non_goals

- Copy Paseo product features, runtime, UI library or Unistyles.
- Treat Codex V3 ThreadView revisions as durable Replica cursors.
- Persist payment, verification, Bot deletion or other mutations as an offline outbox.
- Commit, publish, or add a mandatory screenshot/CI gate.

## requirement_ids / requirement_refs / requirement_excerpt

- Current conversation: user approved model-level learning from `/data/mono2/ref/paseo` and requested desktop/mobile/pad to evolve together.
- Prior iOS screenshots and feedback establish interruption, loading continuity and keyboard as observed problems.

## interface_refs / data_structure_refs

- `@opencraft/workbench-runtime` Conversation Scope and View registries own semantic targets and Composer lifetimes.
- `@opencraft/composer-core` owns draft document, attachments, selections and submit lifecycle.
- `@opencraft/chat-core` `TimelineSnapshot` has `phase` and `authoritative`; V3 Replica remains volatile by design.
- Native account credential scope is the region plus a one-way token digest; persist no raw token.

## history_context

- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `opencraft/docs/mobile-data-architecture.md`, `opencraft/docs/mobile-shell.md`.
- `relevant_evolution`: V3 ThreadView has connection-local revisions, so its Replica storage intentionally remains volatile; a display-only tail needs its own contract.
- `reference`: read-only Paseo at `/data/mono2/ref/paseo` commit `3cc4ae2`, specifically timeline, draft, panel and mobile testing models.

## acceptance

- Cold re-entry can show an account/Host/conversation-scoped prior display without marking it synced or enabling actions from cache.
- Unsent text survives View recreation and is cleared only after accepted send; stale hydration cannot overwrite a newer edit.
- Foreground/network recovery revalidates the current conversation without resetting an already readable timeline.
- Shared state model is consumed by Web/Desktop and Expo; phone/pad adapt layout from their container.
- Focused model tests, affected package typechecks, and iOS bundle pass.

## affected_paths

- `opencraft/packages/workbench-runtime/`, `opencraft/packages/composer-core/`, `opencraft/apps/workbench-web/`, `opencraft/apps/workbench-expo/`, `opencraft/tests/`, `opencraft/docs/`.

## required_context

- Context Router found no Pack for the exact query; bounded search was performed in the above paths and the Paseo reference.

## context_receipt

| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md`, `opencraft/apps/workbench-expo/AGENTS.md` | Agent and platform boundaries | Scope and checks |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Model ownership workflow | Identity, continuity and verification |
| `opencraft/docs/chat-ui-architecture.md`, `opencraft/docs/mobile-data-architecture.md`, `opencraft/docs/mobile-shell.md` | Design contracts | Avoid false Replica authority and duplicated platform logic |
| `/data/mono2/ref/paseo/docs/timeline-sync.md`, `docs/mobile-panels.md`, `docs/mobile-testing.md`, `packages/app/src/composer/draft/input-draft.ts` | Reference contracts | Borrow state boundaries, not implementation |

## evidence

- Shared `ConversationDraftContinuity`, `ConversationDisplayContinuity` and `ConversationReturnProbe` implemented in `workbench-runtime`.
- Expo iOS uses a stable initial Bot draft identity, SQLite document/display storage, account and Bot scope revocation on sign-out/401, and AppState/Expo Network return probes.
- Web/Electron renderer uses the same return probe on visibility/network recovery and persists document/display snapshots under the account service's rotating credential scope. On scope rotation it revokes old storage and resets active and cached Composer targets.
- Focused tests cover View restart, namespace isolation, late hydration, accepted promotion, display-only cache authority and probe cooldown.

## risks

- Restoring an unvalidated V3 cursor would duplicate or hide messages; cached content must be display-only.
- Drafts and cached transcripts are private user data; every storage key must include the correct account and Host scope and clear on sign-out.
- Async storage reads can arrive after edits or a target switch; generation checks must reject them.

## validation

- Focused continuity and View registry tests passed (20 cases in the combined run); Web, Expo and shared runtime typechecks passed; `check:boundaries` passed.
- `npm run build:web` and `npm run build:expo:ios` passed. Lightweight external iOS manifest check passed for the existing Expo Go tunnel; no full bundle download was used.
- A physical iPhone/iPad interaction pass remains user-visible preview evidence, not an automated test result.

## decisions

- Shared package owns identities, state transitions and validation. Web/Electron currently adapts with browser local storage; Expo adapts with SQLite. Presentation geometry remains platform-owned.

## scan_scope

- Exact OpenCraft View/Composer/Replica paths and bounded Paseo model files.

## scan_output

- No generated scan artifact.

## handoff

- Current V3 Replica deliberately stays volatile. Cached display excerpts omit tools, attachments and interactive history; that is an intentional safety bound, not full offline conversation support. Text drafts persist locally and restore by account/Bot/Thread scope; physical-device behavior should be checked through the live Expo preview.
