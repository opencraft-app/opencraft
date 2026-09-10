# Timeline viewport and scroll architecture

## Direction

OpenCraft treats conversation scrolling as a cross-platform domain, not as a DOM
component detail. Codex Desktop remains the behavioral reference, while Web,
Electron and Expo provide replaceable host adapters.

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
- Animated disclosure reflow pins the interacted element for the recovered
  250ms Codex transaction.
- The document root is locked while the nested timeline receives a
  host-specific `auto | contain | none` overscroll policy.
- Composer is always viewport-stable. Electron implements that semantic with
  the recovered in-scroll sticky footer; rubber-band browsers use a sibling
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
  shift remains shared by both planes.
- Scrollbar chrome is a fourth plane owned by the scrollport. A browser footer
  overlay measures classic gutters and reserves a symmetric visual rail for
  zero-width macOS/iOS overlay indicators; neither its occlusion gradient nor
  Composer may paint over that rail. Scrollbar visibility remains an operating-
  system preference, matching Codex instead of a global CSS skin.
- Footer occlusion covers the complete transcript content band, including the
  space exposed by Composer's rounded corners. The browser overlay uses a
  stronger opaque stop because, unlike the Electron sticky footer, it does not
  participate in the scroll surface's paint order.
- Footer height plus the recovered 16px gap is reflected in scroll padding;
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
