# Browser annotation interaction refinement

## Intent and ownership

Refine the normal select → request/preview → add-to-chat path without copying a
reference application's theme or treating a DOM preview as a source-file edit.
The existing controller owns draft transactions, the page overlay owns live
geometry, and the existing theme/control primitives own presentation.

## Implemented

- One mode toolbar with a low-emphasis, accessible exit icon. Removed the prominent
  Done button and the double-toolbar composition after mobile visual review.
- Current, additional, hovered and saved targets have distinct treatments. Element
  corners follow computed radii; text uses bounded captured line rectangles.
- Host-owned marker IDs hit-test the page overlay's current painted geometry.
  Accessible iframe/guest and remote worker transports share the same optional
  annotator contract. Overlapping labels open a chooser; labels cannot revive
  detached nodes or replace a dirty transaction silently.
- Desktop cards use measured target/toolbar/card geometry to choose a fitting,
  minimally overlapping position. Page geometry does not ease behind input.
- Target identity and commit actions remain visible while the body scrolls.
  Mobile selection no longer autofocuses a textarea or auto-scrolls the page.
  An explicit collapse button replaces the nonfunctional grab handle, preserving
  draft state and exposing the page without dismissing the annotation.
- Grouped appearance, typography, padding/gap and size controls; unit-preserving
  steps, keyboard arrows, mouse scrubbing committed at release, cancel/blur recovery,
  per-property reset, opposite-padding linking and compatible-unit dimension ratio.
  Linked writes are validated and committed atomically.
- Reviewed style/text requests can be added without a redundant prose comment;
  unchanged requests cannot enable submission. Intent remains separately serialized.
- Hold-to-compare has queued release handling, plus the accessible toggle alternative.
  Color/geometry preview is still explicitly requested, not silently applied to
  external pages. Source files are never modified by this interaction.
- Theme-owned entry motion and native disclosure size transitions where supported;
  unsupported engines retain native disclosures. System and application reduced-
  motion preferences disable these transitions.
- Four locale catalogs cover the new controls. Technical selector details and
  screenshot evidence are progressively disclosed rather than competing with input.

## Verification and boundaries

Focused tests cover bounded geometry, unit parsing/ratio linking, live overlay
hit testing across scroll, collisions and detached/replaced targets. The minified
component smoke exercises the real iframe agent, controller, Composer and rendered
controls, not a static mockup: pointer and touch contexts, style-only submission,
preview/original/quick release, marker reopen, linked reset, ratio, draft preservation,
short viewports and reduced motion. Chinese light/dark 390px screenshots were
inspected; the top Done control was removed and the sheet header/footer were made
stable following that review. A 320px toolbar fit is checked too.

This is component integration in an isolated HTML-preview fixture, not a claim of
logged-in Shell route, physical iOS/Android or WAN latency acceptance. Previous
cross-origin/transformed-frame restrictions remain. Text line rectangles are captured
snapshots, not a persistent live Range. The editor is not a complete CSS inspector:
Flex layout controls, font-family selection and margin editing remain out of scope.
Desktop cards are automatically placed, not manually draggable. Preview is explicit,
not continuous while scrubbing. Never describe this as full reference-app parity.
