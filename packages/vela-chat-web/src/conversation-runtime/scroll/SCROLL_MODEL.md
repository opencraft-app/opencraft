# Conversation Scroll Model

This document is the debugging map for Vela's conversation scrolling system.
Read this before changing scroll behavior, custom scrollbar behavior, route
resume, partial virtualization, or history loading.

The important idea is that there is no single "scroll feature". There are
several independent concerns that all touch the same DOM scroll element. Bugs
usually happen when a change lets the wrong concern own the truth.

## Source Of Truth

### Geometry Truth

The real scroll geometry is always the browser scroll element:

- `scrollTop`
- `scrollHeight`
- `clientHeight`
- `clientWidth`

These values are read in `useConversationScrollController.ts` and mirrored by
`conversation-runtime/scrollbar`.

The self-drawn scrollbar is not a source of truth. It is a view/controller for
the browser element. It may map pointer input to a desired `scrollTop`, but it
must commit that position through the conversation scroll controller.

### Semantic Truth

Pixel offsets are not enough to restore a conversation after route switches,
hydration, markdown reflow, or virtualized row measurement. The semantic resume
truth is:

```ts
{
  itemId: string;
  offsetTop: number;
}
```

This lives in `scrollAnchor.ts`. It means: "keep this stream item at this visual
offset from the top of the viewport."

`scrollTop` is still stored as a fallback and as the initial coarse target. If a
semantic anchor exists and can be found, the semantic target wins over the old
pixel offset.

### Intent Truth

The bottom-follow intent is owned by `bottomAnchorDriver.ts`.

The mode is either:

- `sticky_bottom`: output growth should keep the user at the bottom.
- `detached`: the user intentionally inspected history, so live output must not
  pull the viewport away.

Only the driver decides whether a scroll is sticky or detached. DOM events,
custom scrollbar drags, touch moves, and route restores are translated into
driver inputs.

### Local Memory

`conversationScroll` in `VelaClientStateStore` is host-local, disposable, and
route-scoped. It is not velad state and not OpenAPI state.

It stores:

- `routeKey`
- `scrollTop`
- `followOutput`
- optional semantic `anchor`

The absence of local state means: use normal route entry behavior. For a
conversation, that usually means bottom anchoring.

## Ownership Layers

### `conversation-runtime/model`

Builds provider-agnostic stream items and splits them into runtime segments.

It owns:

- stream item identity
- live vs stable item boundaries
- partial virtualization policy
- item height estimates

It must not read DOM geometry or host state.

### `conversation-runtime/strategy`

Mounts the stream items for a platform strategy.

`web-plain` mounts the full list.

`web-partial-virtualized` mounts old stable history through
`@tanstack/react-virtual`, plus a mounted recent window and live head. Its
scrollbar range is only as good as the current virtual height estimates and
measurements.

The strategy may estimate and measure item heights. It must not own route
resume, bottom-follow intent, or host persistence.

### `conversation-runtime/scroll`

Owns scroll intent and scroll restoration.

It owns:

- bottom-follow state machine
- route resume
- semantic anchor capture and restore
- history prepend anchoring
- persistence writes to the injected host state store

`useConversationScrollController.ts` is the DOM adapter and write arbiter. New
rules should first be modeled in small pure modules, then wired here.

### `conversation-runtime/scrollbar`

Owns only the cross-platform visual scrollbar overlay.

It owns:

- thumb geometry
- thumb visibility
- pointer drag mapping
- track click mapping

It must not own:

- route resume
- bottom-follow mode
- history paging
- session memory
- virtualized range policy

Pointer writes must be committed with `onScrollCommit`, which reaches
`commitScrollResumeNow` in the scroll controller.

### Host Shell

The host supplies storage and layout, not scroll semantics.

Host-owned examples:

- browser local storage vs Electron storage
- shell layout preferences
- sidebar state
- composer draft storage

The host should not directly mutate the conversation scroll element. If it
needs a scroll action, it should use `ConversationViewportHandle`.

## Write Arbitration

All programmatic writes to `scrollTop` should be explainable by one of these
writers:

1. Route resume confirmation
2. User scroll or custom scrollbar drag
3. History prepend anchor
4. Bottom-follow request
5. Virtualizer/browser measurement correction

When they conflict, the priority is:

1. **Route resume confirmation**
   Keeps the saved route/session position stable across hydration and layout
   reflow. It can run for several animation frames and may correct by semantic
   anchor.
2. **User scroll / overlay drag**
   User input detaches from bottom-follow and must be persisted synchronously
   enough to survive a route switch.
3. **History prepend anchor**
   When older history is prepended above the viewport, preserve the same visual
   content by adding the height delta to `scrollTop`.
4. **Bottom-follow maintenance**
   While sticky, content growth and viewport changes keep the viewport at the
   bottom. While detached, this must not steal the viewport.
5. **Virtualizer measurement correction**
   Virtual row measurement can adjust offsets, but should not override an active
   route resume or explicit user intent.

If a bug cannot be explained by this priority list, the model is missing a
writer and should be updated before patching behavior.

## Route Lifecycle

### Entering A Route

1. Read `conversationScroll` for the route key.
2. If no state exists, request `route_initial_entry` bottom anchor.
3. If `followOutput` is true, ignore the stored pixel position and let bottom
   anchoring win.
4. If `followOutput` is false, enter detached route-restore mode.
5. Apply coarse `scrollTop`.
6. Apply semantic anchor if available.
7. Confirm for stable animation frames before marking route resume restored.

Route entry must wait for:

- route/session key
- history readiness
- measurable viewport
- measurable content
- post-layout verification for partial virtualization

### Leaving A Route

1. Flush any pending scroll state writes.
2. Capture the latest route measurement.
3. If detached, capture the first visible stream item as the semantic anchor.
4. Persist `conversationScroll`.

Do not capture a route-leave anchor after the DOM has already switched to the
next route.

## History Paging

History paging and route resume are different problems.

History prepend anchor:

- captures `previousScrollHeight` and `previousScrollTop`
- waits for the prepend to increase `scrollHeight`
- restores by height delta

Route resume anchor:

- captures `itemId` and viewport offset
- restores the same visible stream item after route switch or reflow

Do not reuse one mechanism to solve the other.

## Full Preload vs Partial Virtualization

The conversation strategy must declare whether the scrollbar range is exact or
estimated.

`web-plain`:

- mounts all items
- scrollbar range is exact after layout
- memory and DOM cost grows with conversation length

`web-partial-virtualized`:

- virtualizes old stable history
- keeps recent history and live head mounted
- scrollbar range is estimated until rows are measured
- requires post-layout route confirmation

The custom scrollbar should mirror the actual scroll element. It should not
invent a second range model. If a host wants an exact range for very long
conversations, it must choose a full-preload strategy or provide exact measured
heights.

## Debugging Taxonomy

### The thumb size is wrong

Start with geometry:

- Does the scroll element report the expected `scrollHeight`?
- Is the list in `web-plain` or `web-partial-virtualized`?
- Is the virtualized total size still estimated?
- Is the overlay reading from the correct element?

Relevant files:

- `scrollbar/geometry.ts`
- `scrollbar/useConversationScrollbarOverlay.tsx`
- `strategy/webVirtualizedStrategy.tsx`

Relevant tests:

- `tests/scrollbar-overlay.test.ts`
- `tests/conversation-virtualized-dom.test.ts`

### Track click does not jump directly

Start with overlay mapping:

- Track click should compute an absolute thumb offset.
- It should set DOM `scrollTop` with `scrollBehavior = auto`.
- It must call `onScrollCommit`.

Relevant files:

- `scrollbar/useConversationScrollbarOverlay.tsx`
- `scrollbar/geometry.ts`

Relevant tests:

- `tests/scrollbar-overlay.test.ts`

### Returning to a tab/session changes visible content

Start with route resume:

- Was `conversationScroll` written before leaving?
- Was `followOutput` false?
- Was a semantic anchor captured?
- Is the saved item still in the stream item list?
- Did route resume finish stable confirmation?

Relevant files:

- `scroll/useConversationScrollController.ts`
- `scroll/routeResume.ts`
- `scroll/scrollAnchor.ts`
- `scroll/scrollResumePersistence.ts`

Relevant tests:

- `tests/conversation-scroll-state-dom.test.ts`
- `tests/conversation-engine.test.ts`

### Sending a message does not follow the bottom

Start with bottom-follow intent:

- Is the driver in `sticky_bottom` or `detached`?
- Did the user scroll away first?
- Did the composer call `requestBottomAnchor("message_sent")`?
- Is route resume still pending and blocking bottom anchoring?

Relevant files:

- `scroll/bottomAnchorDriver.ts`
- `scroll/useConversationScrollController.ts`
- `components/conversation/VelaConversation.tsx`

Relevant tests:

- `tests/conversation-engine.test.ts`
- `tests/conversation-scroll-state-dom.test.ts`

### Scrolling near the top jumps after older history loads

Start with history prepend anchoring:

- Was the older-history request triggered by upward user intent?
- Was `previousScrollHeight` captured before loading?
- Did `scrollHeight` increase?
- Was the height delta applied once?

Relevant files:

- `scroll/historyPaging.ts`
- `scroll/useConversationScrollController.ts`

Relevant tests:

- `tests/conversation-engine.test.ts`
- `tests/conversation-scroll-state-dom.test.ts`

### Scroll behavior differs after reload vs later switches

Start with hydration and measurement timing:

- First page load may have stale virtual row estimates.
- Route resume should remain pending until post-layout confirmation.
- Semantic anchor should correct the old pixel offset after measurement drift.
- If content is not yet mounted, the route should not claim restored.

Relevant files:

- `scroll/useConversationScrollController.ts`
- `strategy/webVirtualizedStrategy.tsx`
- `model/estimateStreamItemHeight.ts`

Relevant tests:

- `tests/conversation-scroll-state-dom.test.ts`
- `tests/conversation-virtualized-dom.test.ts`

## Red-Test Map

Use pure tests when the bug is about math or state transitions:

- `bottomAnchorDriver.ts`
- `historyPaging.ts`
- `routeResume.ts`
- `scrollAnchor.ts`
- `scrollbar/geometry.ts`

Use happy-dom tests when the bug needs DOM measurements:

- route/tab switch preservation
- anchor restore after layout drift
- partial virtualized first mount
- custom scrollbar commit behavior

Use agent-browser only for real layout behavior that happy-dom cannot model:

- actual browser scroll inertia
- CSS overflow clipping
- native pointer behavior
- first-load visual blanking

When adding a regression test, name it after the invariant, not the current bug.
Good: "route resume preserves visible item after height drift".
Bad: "fix tab switch bug".

## Invariants

- The browser scroll element owns geometry.
- The self-drawn scrollbar never owns scroll memory.
- All overlay pointer writes go through `commitScrollResumeNow`.
- `scrollTop` is a coarse fallback for route resume; semantic anchor wins when
  available.
- Route resume must not be marked restored until post-layout confirmation.
- Bottom-follow must not run while detached route restore is pending.
- History prepend anchoring and route resume anchoring are separate mechanisms.
- Partial virtualization means scrollbar range may be estimated until
  measurement settles.
- Full preload means scrollbar range should be exact after layout.
- The page shell must not directly mutate conversation scroll state.

## Change Checklist

Before changing scroll behavior:

1. Identify the owning layer.
2. Decide which truth is involved: geometry, semantic anchor, intent, local
   memory, or visual mirror.
3. Check whether the change adds a new scroll writer.
4. If it does, update the write arbitration section first.
5. Add the smallest pure test possible.
6. Add a DOM test if geometry or route switching is involved.
7. Use agent-browser only after the model-level test is green.
