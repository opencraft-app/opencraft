# vela-chat-query/src

React Query adapter layer for `velad` read models.

Rules:

- Put stable query keys in `queryKeys.ts`.
- Put session list and session command hooks in `sessions.ts`.
- Keep command writeback rules inside this package, not inside shell components.
- Do not move streaming conversation state here. `useVelaChatSession` owns live
  conversation runtime, overlays, request docks, and scroll-sensitive state.
- Do not import desktop chrome, Next route APIs, or host-local storage here.

