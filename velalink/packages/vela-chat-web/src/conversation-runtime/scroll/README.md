# conversation-runtime/scroll

Scroll controllers for the app-side conversation runtime.

Start with `SCROLL_MODEL.md` before changing behavior. It defines the ownership
model, write arbitration order, route lifecycle, and debugging taxonomy for
bottom-follow, route resume, history prepend anchoring, partial virtualization,
and the self-drawn scrollbar.

Change here when bottom-follow, near-top history loading, or scroll anchoring
behavior changes.

`bottomAnchorDriver.ts` holds the pure bottom-anchor state machine for route
entry, local send/jump requests, sticky/detached mode, measurement verification,
and user scroll-away detaching.
`historyPaging.ts` holds near-top history pagination and prepend anchoring rules.
`routeResume.ts` holds session-scoped scroll resume restore rules.
`scrollAnchor.ts` holds item-level semantic anchors used to keep the same
visible stream item stable when route hydration or markdown layout changes
content height above the viewport.
`scrollWrite.ts` is the only DOM scroll-write gate. Bottom-follow, route
resume, history prepend anchoring, virtualizer measurements, and the
self-drawn scrollbar must pass through it so route resume cannot be overwritten
by passive writes.
`scrollResumePersistence.ts` holds the coalesced host-state writer and its
route/unmount flush semantics.
`useConversationScrollController.ts` is the React/DOM adapter.
`viewportHandle.ts` is the imperative contract exposed to the workbench and
composer shell.

Route bottom anchoring is intentionally gated before DOM writes: the controller
waits for a route/session key, history-start readiness, measurable viewport and
content dimensions, and any pending post-layout verification retry. Keep those
blocked reasons in the pure model so regressions stay easy to test without a
browser.

The DOM hook must not grow a second scroll state machine. New behavior belongs in
`bottomAnchorDriver.ts` first, with driver-level tests, then the hook should
translate DOM events and measurements into driver requests.

Route resume is also owned here, not by the page shell. The controller writes a
small `conversationScroll` record through the injected `VelaClientStateStore`
and restores only detached positions. If the user was following output, the
normal bottom-anchor behavior wins instead. Browser storage choice is a host
concern; this package should only consume the store interface.

Do not:
- Build stream items here.
- Render block contents here.
- Fetch velad data here.

Depends on:
- React

Used by:
- `components/conversation/VelaConversation.tsx`
