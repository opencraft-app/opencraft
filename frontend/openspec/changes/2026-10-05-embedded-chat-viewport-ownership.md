# Mobile embedded chat viewport ownership

## Evidence and scope

Native iPhone Safari diagnostic R3 retained the real fixed Shell, sticky footer,
paint containment and backdrop filter. Fixed document roots removed the user's
gray composer symptom, but page scroll could still precede VisualViewport pageTop
by about 400ms. R4 compensated that ordering and passed five keyboard cycles:
the sampled composer screen position stayed constant while the pageTop caught up.
This is diagnostic evidence, not a claim that all browsers or production passed.

## Contract

- The LightVela mobile embedded-chat page owns the document's fixed, non-scrolling
  root allocation. The existing page marker and 1023px breakpoint scope this
  contract; removing the marker or entering desktop layout releases it.
  This constrains ordinary document scrolling; it does not prevent Safari's
  native focused-editor page pan, which the height projection must still handle.
- OpenCraft owns its inner conversation scrollports, Composer and draft. Do not
  recreate the Application/editor, reset message scroll, remove sticky, or delete
  backdrop/paint containment to compensate for document viewport changes.
- Height projects the current visible page bottom, including page scroll that
  precedes VisualViewport pageTop and visual-only pan. The result cannot exceed
  the fixed root allocation, even if an old offset outlives keyboard close.
- Measure the current allocation on viewport/window resize; do not retain a
  pre-rotation height. Existing header and toolbar layout consume their own space.
- Pinch zoom clips the existing browser layout, not a keyboard-driven reflow;
  release the inline height to the CSS fallback while scale differs from one.
- Root constraints are declarative CSS and do not overwrite Radix inline locks.
  Leaving chat must not clear a still-active modal's independent scroll lock.

## Verification

Cover resize-before-scroll and scroll-before-resize keyboard opens; closing with
late pageTop, late scrollY, or both; visual-only pan; current root bounds on window
resize; zoom and return to scale one; listener cleanup; route/breakpoint release;
modal coexistence; same editor/draft/focus and history reading position. Use the
real Conversation/Composer for browser checks, explicitly label replayed native
sequences, and require a new iPhone check of the final source-derived artifact.

Standalone OpenCraft and desktop layout remain unchanged. R5 source-derived
native acceptance covered three keyboard cycles; the user confirmed normal
appearance and motion. Other devices, rotation/zoom and native typing are not
covered by that export. Publication follows normal MR and production gates.
