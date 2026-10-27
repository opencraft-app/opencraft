# OpenCraft Shell layout invariants

The Shell retains content and state while panels animate, resize, disappear or
change route.

## The authoritative state path

The right panel has one write path:

1. Shell state stores semantic visibility.
2. The route-scoped animation owner stores progress.
3. `setRightPanelVisibility` changes visibility, stops the current animation, and
   retargets the shared progress.
4. AppShell, HeaderSlot, floating bounds, and AppShellRightPanel only read the
   shared progress.


The panel component does not create its own visibility MotionValue and does not
publish its measured width back to its parent. This prevents a child remount,
route change, or effect cleanup from freezing only one consumer mid-animation.

## One lossless geometry transaction

For each frame, define:

- `W`: shell width
- `L`: animated left-panel width
- `C = W - L`: main-content capacity before the right panel
- `R`: right-panel target width
- `P`: shared right-panel progress, clamped to `[0, 1]`
- `A = P * R`: physical animated right-panel width
- `V = C - A`: physical main viewport width

The non-negotiable conservation rule is:

```text
L + V + A = W
```

No ResizeObserver snapshot or React state from a previous frame may take part
in this equation. The right panel's header reservation is `A` in regular mode
and `0` in full-width mode.

The semantic target width is distinct from the physical viewport:

```text
targetMain = open ? C - R : C
```

It is intentionally not the same value as the physical viewport during the
transition. Stable content placement can reason about the destination while
the DOM still renders the current animated frame.


## Mount lifetime follows progress

The panel remains mounted while either semantic visibility is true or progress
is greater than zero:

```text
isMounted = isVisible || animation.get() > 0
```

An `animationComplete` subscription causes the final render that unmounts the
panel at zero. Mount lifetime is not controlled by a component-local Promise.
The non-animated reduced-motion path forces the equivalent terminal update.


## The moving aperture and the stable surface are different elements

The outer `aside` owns animated width and opacity. Inside it, an absolute clip
element hides a surface whose width and minimum width remain equal to `R`.
Panel content therefore does not continuously reflow as the aperture opens or
closes.

`width` and `min-width` are one atomic constraint, not merely two properties
that usually receive the same number. The web adapter publishes `R` once as
`--app-shell-right-panel-target-width`, and both CSS declarations consume that
signal. This prevents a Motion runtime from advancing `width` while leaving
`min-width` at its initial frame, which would make tab-bar actions follow the
moving aperture during a resize.

The regular panel divider and shadow belong to the panel plane. The resize
handle is a sibling of the clipped content and uses the same target-width
model. Visible minimum and magnetic close shelf are separate configured
constraints. Between them, normalized width remains clamped while the pointer
travels; crossing the close shelf starts the close transaction. Numeric limits
belong to the current Shell geometry contract.


## Header ownership is measured independently

Header actions have two widths:

- `fitWidth`: the intrinsic max-content width of the actions, measured from an
  invisible out-of-flow duplicate;
- `slotWidth`: the animated layout width supplied by AppShell.

The visible animated slot is never used to measure its own minimum. This keeps
the reopen control alive when panel width reaches zero and prevents a
measurement feedback loop.


## Full width, responsive closure, and resize are explicit modes

Full-width mode gives the physical right panel all of `C`, collapses the main
viewport to zero, and gives the header reservation zero. It is not implemented
as an oversized regular panel.

Responsive closure carries a `window-resize` reason and records restoration
intent separately. Manual closure clears that intent. Resizing, visibility,
full-width state, and the active tab are separate state fields; none is inferred
from a transient DOM width.


## Timeline and rich-block overflow stay local

The main viewport, thread rows, and rich blocks all carry `min-width: 0`.
Code blocks use an inline-size containment boundary; their inner scroller owns
horizontal overflow and the `pre` element may use `width: max-content` only
inside that scroller. A long code line may scroll within the code block, but it
must never widen the thread, main viewport, or AppShell.


## Mobile contact ownership

The existing Shell touch controller owns one arbitration transaction. Actual
scroll capabilities come from the composed contact path, not a renderer opt-in.
Ordinary readers participate by default, including future and dynamically mounted
content. Nested reading selects the first scrollable viewport with capacity in the
requested direction before committing, then locks that owner. Editors, sliders,
scrollbar/draggable controls, foreground dialogs, media, interactive terminals and
explicit exclusive regions retain input priority. Pending contacts resolve to
sidebar, content or native input; only the committed owner writes movement.
The [mobile gesture contract](../../design/invariants/navigation-and-sidebar.md#mobile-sidebar-gestures)
owns thresholds and lifecycle details. The Shell adds no ancestor touch-action restrictions or DOM registration cache; native vertical input, pinch zoom,
keyboard/wheel and non-mobile/standalone presentation remain available. Pending horizontal recognition reserves the cancelable stream before its movement owner commits; the decision clock starts at meaningful motion, excluding stationary contact time. Unknown speed waits for a timed segment. The first delayed/coalesced movement cannot prematurely assign content merely by crossing the travel threshold: pending retains its bounded observation window. Admission speed uses motion samples without diluting subsequent segments with touchstart latency; release sampling remains independent. Native
scroll acquisition, multi-touch, detached content and foreground layers revoke
pending input rather than creating two movement writers.

## OpenCraft acceptance rules

Every AppShell change must demonstrate all of the following:

1. At every sampled animation frame, `left + viewport + right == shell` within
   subpixel tolerance.
2. Closing reaches an exact zero-width right panel and then unmounts it.
3. Reversing a close animation preserves one shared progress and never exposes
   an unowned gutter.
4. Resizing the window during either direction recomputes `R` from the current
   `C` without using a stale child measurement.
5. The header reopen action remains visible at zero panel width.
6. Full-width mode produces `viewport == 0` and `headerReservation == 0`.
7. Long code, math, Mermaid, tool output, and streamed content cannot alter the
   AppShell conservation equation.

## Mobile keyboard coordinate frames

The browser owns native coordinate movement; the application owns layout capacity.
The shared snapshot retains raw visual offsets, sizes and focus observations.
`projectTimelineViewportLayout` derives an available extent, independently of
pageTop, document scroll and focus. Pinch magnification does not reflow layout.
The Web adapter measures a zero-inset fixed reference outside the Shell. The
reference never consumes application viewport CSS or participates in input. Its
client rectangle supplies the native fixed coordinate basis, separately from the
reported visual offset. The visible client origin is visual page position minus
window scroll; CSS placement is that origin minus the fixed reference origin.
This is a coordinate conversion, not an additive page-scroll correction or
feedback from the already-positioned Shell. Native reference changes invalidate
the shared projection even when raw VisualViewport values remain unchanged.

The Web port commits available capacity before measuring the independent fixed
reference: resizing a focused containing block can itself change the browser's
native coordinate plane. Origin projection and subscriber publication belong to
that same layout commit. Mobile native viewport events reconcile synchronously
before returning to browser paint, with the existing bounded rAF reconciliation
reserved for later native updates; they must not defer a known invalid origin to
the next animation frame. Unchanged CSS and data attributes are not rewritten.

Layout capacity comes from document client size and visual size; innerHeight may
already be visually reduced in WKWebView. Layout containment keeps internal
fixed descendants in the same frame without reapplying the conversion.
No Shell-rectangle feedback, per-feature compensation, forced scrolling or
focus/selection reset. Height-first/pan-later and reverse ordering must preserve
screen placement, not a constant CSS top. Bounded late reconciliation
belongs to this same owner; it does not infer keyboard completion from blur.
Browser-frame trajectories and physical iOS/WeChat keyboard acceptance are
separate evidence: endpoint reachability is insufficient to verify transitions.

Mobile new-thread input uses a bottom anchor shared with existing threads, while
the welcome region yields spare space. Its title uses a stable block-start inset
below navigation, independent of keyboard height and Composer focus expansion;
clipping the optional region never adds a minimum to the input budget. Desktop
retains the centered content group.
No height breakpoint or focus mode exchanges the input DOM or re-centers it.
Existing and new conversation routes share this viewport owner.

Composer capacity is local to its route's size container, minus that route's own
block insets. The shared stack intersects this capacity with its platform budget;
header/route chrome cannot be counted as input space. This is the only viewport
height cap. Queue, attachments and the editor consume intrinsic content caps and
shrink within it, without independent percentages of the browser viewport. Header,
error actions and the footer remain outside content shrinkage; the native editor
and previews retain their own scrolling, while the input wrappers only clip. Heading gaps shrink as
space, not structural padding with an irreducible minimum. Long draft/attachment
content yields to the action footer without changing editor or draft identity.

Terminal keyboard checks use this same available-frame contract: native pan shifts
layout-coordinate bounds once but not their screen-coordinate projection, pinch magnification does not reflow its layout, and
terminal grid/Composer non-overlap and local overlay ownership remain asserted.

The bounded geometry diagnostic records raw viewport sizes, origin, Shell and
input/control rectangles plus the client source revision. It carries no input
content, route, account or user-agent values and never feeds positioning. It is
rate limited with a 64-observation burst and eight credits restored per second,
with duplicate suppression and an 80ms minimum interval. A long-lived page must
not permanently lose later keyboard cycles after its first burst. It also records
CSS top/height, document client height and root/body rectangles separately from
raw viewport offsets and the independent fixed reference. Diagnostic records
never feed positioning; the shared adapter owns its own live reference read.
The existing diagnostic transport accepts old geometry reports as well as the
strictly numeric optional fields. Controlled browser viewports still do not prove
native iOS acceptance, including whether client rectangles match a synthetic
visual-offset subtraction during a native transition.

Primary and body-portalled floating Shell hosts share the same origin/extent
projection. Fixed descendants inside either host use local coordinates; the
viewport origin is never applied again within those hosts.


Keyboard acceptance must not manufacture a visible window by cropping at the
raw visual offset. Physical WKWebView capture has displayed Shell.clientTop=294
at screen y=294 while pageTop=scrollY=offsetTop=294 and visualHeight=394.
For that observed client frame, the Shell begins at zero and the send action
must fit within [0, 394]. An extra offset subtraction conceals double native-pan
compensation. Controlled browser geometry remains distinct from physical UIKit
painting; synthetic passing results do not establish device acceptance.


Keyboard diagnostics observe focused-Composer geometry, its local scrollport and
actual send hit target, rather than the first potentially parked submit button.
The Web viewport port owns the event listeners and the single bounded animation
frame window. Its optional read-only observation callback runs after every mobile
geometry commit, including frames without snapshot publication. Diagnostics own
neither listeners nor a frame loop; subscribing evidence never renews the window.
Captured contact events survive a resize before the next observation. Nested
scroll invalidates this same owner. Hiding or disposing it cancels all sampling.
The one-second grace is an explicit late-native compatibility bound, not inferred
keyboard state: early unchanged frames cannot prove that native motion ended.
Retire or shorten it only with host evidence covering late basis changes after
stable frames, opening/closing, restoration and absent final events.
Brief editor/Shell position extrema survive the eight-per-second traffic budget;
touch screen/client and page/client differences remain separate numeric
observations. Reports contain no content or route, never drive layout, and all
listeners/frames are released with the host. These measurements do not establish
physical compositor painting or device acceptance.
