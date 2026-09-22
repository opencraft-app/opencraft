# Persona module

`BuddyPanel` remains the only owner of catalog loading, saved card state, active Bot/profile identity, SOUL reads/writes, draw slots, injection results, and stale-response guards. Cards keep their existing IDs, images, localization and canonical-slug mapping. The current implementation keeps the shared Radix dialog primitives in the panel and restores the responsive fixed-coordinate draw stage in `agent-buddy-views.tsx`.

## Display interfaces

- `FilledSlot` and `EmptySlot`: typed soul, selected/applied flags, labels and select/reroll/delete/preview actions. Selection and preview are separate native controls; the card never nests an interactive preview inside the selection button.
- `PersonaDrawStageView`: fixed-coordinate animation children scaled to the available width. It only owns a `ResizeObserver` and local scale; draw timers and selection stay in `DrawSoulModal`.
- The panel preview, information, deletion confirmation, and Soul test surfaces use the shared Radix `Dialog`/`AlertDialog` primitives. Escape handling, focus containment, scroll locking, accessible titles/descriptions, and return focus are delegated to those primitives.

The views use shared Radix primitives and Agents Tooltip/Confirm components. They do not import repositories, contexts or request services.

## Original visual treatment (2026-09-20)

At the user's request, persona-specific surfaces restore the visual treatment from the merged master baseline `f2a1ec32f`: gradient heading and applied badge, soft panel/card shadows, pill actions, circular card tools, and rounded persona dialogs. This is local to persona views; shared Agents/UI styles are unchanged.

- `PersonaDeleteConfirmView` uses the existing Radix AlertDialog with the original centered warning/action layout. Escape, cancellation, and removal focus fallback remain available.
- `SoulFaceCard.selectionControl` places the native selection button alongside the preview control so the original inline preview can be restored without nested buttons. Information remains click-through; the preview is independently focusable/clickable.
- Dialogs retain Portal, focus containment, return focus, pending close guards where an operation can still be running, and a scrollable inner body for short viewports.
- The existing `AgentPageLoadingState` condition and all request, persistence and loading branches are unchanged. The separate multi-stage loading diagnosis is outside this visual restoration.

## Preserved operation order

- Draws retain the eight-slot cap, slug deduplication and reroll position. Direct injection occupies a slot only after a successful write; download fallback or failure leaves the draw result open.
- Deleting a card closes its confirmation first. An applied card is removed only after clearing SOUL succeeds; failure retains the card.
- Explicitly reviewed derived-state correction: the local applied summary is cleared only when a previously present card is removed from the same Bot's collection. An initially empty collection or copied SOUL identity does not clear a successful SOUL read. Radix-triggered intermediate commits exposed the former membership-only cleanup; the command, request and persistence paths are unchanged.
- Delete dismissal restores the original control while it remains connected. If deletion removes that focused control, focus returns to the stable card area; an async operation never overrides focus the user moved elsewhere. Success information dialogs return to the current persona's edit action.
- Custom editing and upload retain UTF-8 and normalized 20 KB validation, request invalidation, drafts on errors and pending close protection.
- Upload overwrite confirmation returns to the same draft with its Back action. Escape dismisses the upload flow unless injection is pending. The injection controller alone closes on success or returns to editing on failure.
- Soul test question order, scoring, answer state and auto-advance timer remain in the existing controller.

## Verification

Adjacent rendering tests exercise native card actions, named Portal dialogs, initial focus, Escape/return focus, pending close protection, overwrite drafts and injection outcomes. Existing command, localization, stale Bot response, unmount and upload parsing tests remain the business checks.
