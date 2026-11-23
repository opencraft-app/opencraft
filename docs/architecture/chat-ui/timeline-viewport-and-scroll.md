# Timeline viewport and scroll architecture

## Direction

OpenCraft treats conversation scrolling as a cross-platform domain, not as a DOM
component detail. Web, Electron and Expo provide replaceable host adapters.

```text
AppServer timeline data
        │
        ▼
chat-core projection
        │ stable Turn identities
        ▼
timeline-virtualizer
  ├─ distance-from-bottom coordinate
  ├─ restore/follow state machines
  ├─ measurement transactions
  ├─ viewport policy
  └─ surface capability model
        │ ports
        ├───────────────┐
        ▼               ▼
timeline-host-web     Expo/RN adapter
  DOM/VisualViewport    ScrollView/onLayout
  ResizeObserver        SafeArea/Keyboard
  elastic containment   native bounce
```

## Authority boundaries

`@opencraft/timeline-virtualizer` is authoritative for semantics:

- The canonical coordinate is `distanceFromBottomPx`; zero means the newest
  Turn. DOM `scrollTop` and RN `contentOffset.y` are adapter details.
- It owns follow, route restoration, response spacer behavior, bounded Turn
  virtualization and measurement transactions.
- It defines `TimelineViewportPort`, `TimelineViewportSnapshot`,
  `TimelineViewportPolicy` and `TimelineSurfaceCapabilities` without importing
  a renderer or referencing browser globals.

`@opencraft/timeline-host-web` is authoritative only for Web mechanics:

- `VisualViewport` is translated into a layout/visual viewport snapshot and a
  software-keyboard inset. Pinch zoom is never classified as a keyboard.
- `ResizeObserverEntry.borderBoxSize` supplies footer measurements.
- Animated disclosure reflow pins the interacted element through animation
  completion and layout settlement; legacy expanders retain their bounded 250ms
  policy. While its lease is active, row measurements synchronize that anchor
  before selecting the new render window and do not compensate the growth again.
- The document root is locked while the nested timeline receives a
  host-specific `auto | contain | none` overscroll policy.
- Composer is always viewport-stable. Electron implements that semantic with
  the in-scroll sticky footer; rubber-band browsers use a sibling
  overlay plus a measured in-flow spacer because Safari drags sticky descendants
  with the elastic scroll surface.

The Expo adapter consumes the same core policy and state machines, but maps
them to `ScrollView`, `onLayout`, `contentOffset`, iOS bounce and automatic
keyboard insets. It does not import the Web host package.

## Surface capabilities

`TimelineSurfaceCapabilities` deliberately stays separate from conversation
and AppServer data:

- `hasLiveEmbeddedSurface` disables `content-visibility:auto` for a live MCP
  or extension frame.
- `embeddedPortalTarget` installs the thread-local portal boundary.
- `pipAnchorHostId` and the footer obstacle coordinate voice/PIP placement.
- `wideContentOffsetPx` carries side-panel shift motion and publishes
  `--thread-wide-block-inline-shift` to wide code/diff blocks.

The application composition root supplies these values. A renderer must not
guess them from protocol items.

## Non-negotiable layout invariants

- The application root never becomes a page scroller.
- The timeline is the only vertical scroll owner and uses
  `flex-direction: column-reverse` plus `overflow-anchor: none`.
- Top inset and the `thread-content` container-query scope belong to that
  scroll owner, not to the message column.
- Transcript and footer use the same max-width and inline-padding primitive.
- Transcript and Composer occupy separate vertical motion planes: elastic
  displacement may affect the transcript, never the Composer. Horizontal panel
  shift remains shared by both planes. The viewport owner's existing geometry
  observation projects native scrollbar edge insets onto the sibling dock, so
  both bounded columns center within the same client rectangle. Overlay
  scrollbars project zero; left-side and two-edge gutters retain their geometry.
- The Conversation reading scrollport and dock are siblings. The scrollport
  owns the reading viewport. The dock owns the Composer, progress and navigation
  actions. Desktop ends the rectangular scrollport and its native scrollbar at
  the editor's lower corner arc. The existing footer observer measures the
  cutoff from the editor and publishes it alongside surface occlusion and full
  footer height. Touch keeps the full reading plane around the floating dock.
- Only the editor shell and visible attached rail publish painted occlusion
  surfaces, never the outer Composer stack or floating-content slot. Empty
  rails have no box and contribute no occlusion. The same footer ResizeObserver
  also observes those surfaces: child resize invalidates paint geometry without
  replacing the complete footer height with a child's height.
- The viewport owner's existing footer observation publishes its measured height
  to a normal-flow reservation in the transcript. The desktop viewport inset is
  deducted from the reservation and scroll padding to preserve the reading
  position. There is no second observer,
  React height state, or independent restoration policy. Hidden viewports defer
  measurements and detach/dispose removes both geometry projections.
- One inline offset is published to transcript and dock; the scrollport and its
  scrollbar do not translate. Both consumers share the same max-width and gutter
  primitive. The host continues to own scrollbar visibility.
- Main and tool reading panes consume the same reading material. A chat's
  scrollport and dock do not paint a second pane background. The Shell owns the
  continuous canvas; native browser/terminal content may own its content surface.
- Footer height plus the 16px gap is reflected in scroll padding;
  footer focus temporarily makes that padding zero.
- A footer resize compensates only while away from the bottom, and never during
  scroll animation or an explicit latest-Turn placement transaction.
- Web browsers may show local elastic feedback, but the gesture cannot chain
  into document scrolling or browser navigation.

## Extension rule

New platforms implement ports. They do not fork follow/restoration logic.
New embedded products add surface capabilities. They do not add protocol flags
to the virtualizer. New dynamic blocks request reflow preservation through the
host adapter. They do not mutate `scrollTop` from product components.

## Local scroll diagnostics

The existing device-local diagnostic preference gates the Web viewport's
read-only frame sampler. Disabled means no diagnostic activity listeners, rAF
loop, caret lookup or text-geometry reads. Its module is loaded lazily only on
opt-in; disabling or retiring the viewport also revokes a pending import.
Disabling, detaching and disposal
cancel queued work and release text ranges; generation fences reject callbacks
from earlier recording sessions. Idle and unmeasurable/hidden viewports stop
sampling. This adds no restoration or compensation owner.

While enabled and scrolling, rAF samples physical scroll position and a retained
visible text range, without changing selection or reading/exporting message
content. In bottom-origin flow, `layoutDelta = textDelta + scrollDelta` separates
physical movement from text reflow. Missing/replaced anchors and viewport size
changes have no comparable delta. A point is measured once after leaving the
viewport before replacement. Exports include frame timing, the maximum interval
since the last retained sample, scroll-event lag/count and geometry read cost.
These are main-thread observations, not proof of compositor paint or a visual
jump. Frame gaps/large steps/text shifts are diagnostic candidates, not verdicts.

Row registration diagnostics contain identities only. In particular, a React
ref-detachment callback must not read `offsetHeight`, bounds or scroll geometry:
the outgoing window may already be partly removed while its replacement padding
has not committed. A forced layout at that point can clamp the native inverted
scroll position to the temporary range, and subsequent content growth does not
restore it. Measuring geometry only after the DOM commit avoids the diagnostic
itself changing the observed behavior; heights still come from the existing
committed measurement batch. Do not compensate this instrumentation failure by
rewinding every physical delta: unreported user momentum remains user-owned.

`scripts/smoke/conversation/smoke-history-commit.ts` runs the real virtualized
list and viewport owner with stable row identities and recorded dimensions. It
checks diagnostic on/off parity while replacing an old mounted window with
taller history, including physical movement before its native scroll receipt.
The old ref-height diagnostic reproduces a roughly2028px clamp; the fixed
registration path must preserve both the same paragraph and physical position
without a restoration write. This is controlled browser evidence, not physical
iPhone/WeChat acceptance. Idle sampling deliberately starts a fresh frame
baseline, so event/anchor evidence is also needed across those sampling gaps.

Ordinary samples are retained at approximately20Hz; long frames (>50ms), text
residuals (>2px), and large steps are retained immediately. Frame records have
their own FIFO partition (`diagnostics.frames`), at most240 records or128KiB,
so they cannot evict the600 measurement/write events. That event partition now
uses the remaining256KiB of the unchanged384KiB combined encoded-payload cap.
Both evict oldest first. This bounds recorded payload, not exact JS heap usage.
Disable freezes downloadable evidence; re-enable clears both partitions. No
server upload or additional persistent data is introduced.

`tests/chat/chat-scroll-frame-diagnostics.test.ts` covers gating and lifetime;
`scripts/smoke/conversation/smoke-scroll-frame-diagnostics.ts` checks the actual
Conversation in touch/pointer browser contexts, including zero text reads while
off, text-only displacement, delayed frames, selection and scroll continuity.
