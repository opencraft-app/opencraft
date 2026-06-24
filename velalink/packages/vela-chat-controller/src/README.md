# src

Reusable controller code for embedding Vela chat in different hosts.

- `useVelaChatSession.ts` is the main React hook for an active session.
- `renderModel.ts` adapts OpenAPI read models into the shared render model.
- `historyPolicy.ts` controls full preload vs tail-only host behavior.
- `setupModel.ts` derives backend/model/reasoning/permission setup state.
- `streamHandler.ts` maps SSE events to read-model refreshes.
- `attachments.ts` converts selected image files into wire input parts.

