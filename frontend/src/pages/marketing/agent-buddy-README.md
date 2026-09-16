# Persona module

`BuddyPanel` remains the only owner of catalog loading, saved card state, active Bot/profile identity, SOUL reads/writes, draw slots, injection results, and stale-response guards. Cards keep their existing IDs, images, localization and canonical-slug mapping.

## Display interfaces

- `SoulSlotCardView`: typed soul, selected/applied/canReroll flags, labels and select/reroll/delete/preview actions. The selection button and preview/action buttons are separate native controls. Optional `onFocusedRemoval` runs before a focused card is removed; it does not move focus when the user is elsewhere.
- `EmptySoulSlotView`: label, tooltip and draw action.
- `PersonaDialogView`: title/description, close label, controlled open/close, pending close guard and content. It provides a visible initial focus target, Radix focus containment and return to the original connected trigger. Its Portal opts into `agents-ui`.
- `PersonaDrawStageView`: fixed-coordinate animation children scaled to the available width. It only owns a ResizeObserver and local scale; draw timers and selection stay in `DrawSoulModal`.
- `PersonaInfoView`: caller-provided confirmation text and dismissal action.
- `PersonaOverwriteConfirmView`: controlled AlertDialog with separate back-to-editor, close and confirm actions. It deliberately distinguishes returning to the draft from dismissing the upload flow.

The views use shared Radix primitives and Agents Tooltip/Confirm components. They do not import repositories, contexts or request services.

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
