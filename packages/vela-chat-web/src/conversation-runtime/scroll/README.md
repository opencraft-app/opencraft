# conversation-runtime/scroll

Scroll controllers for the app-side conversation runtime.

Change here when bottom-follow, near-top history loading, or scroll anchoring
behavior changes.

`bottomAnchor.ts` holds pure scroll-follow and route-entry readiness rules.
`historyPaging.ts` holds near-top history pagination and prepend anchoring rules.
`routeResume.ts` holds session-scoped scroll resume storage and restore rules.
`useConversationScrollController.ts` is the React/DOM adapter.

Route bottom anchoring is intentionally gated before DOM writes: the controller
waits for a route/session key, history-start readiness, measurable viewport and
content dimensions, and any pending post-layout verification retry. Keep those
blocked reasons in the pure model so regressions stay easy to test without a
browser.

Route resume is also owned here, not by the page shell. The controller writes a
small `sessionStorage` snapshot per route/session key and restores only detached
positions. If the user was following output, the normal bottom-anchor behavior
wins instead.

Do not:
- Build stream items here.
- Render block contents here.
- Fetch velad data here.

Depends on:
- React

Used by:
- `components/conversation/VelaConversation.tsx`
