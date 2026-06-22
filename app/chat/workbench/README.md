# Chat Workbench Demo Shell

This folder keeps the `/chat` example page small and navigable. The page is a demo client for local velad, not the reusable renderer.

- `session-launcher/` renders the debug-only no-session launcher and recent session picker.
- `setupModel.ts` derives backend/model/thinking/permission defaults from the backend catalog.
- `attachments.ts` converts selected files into pending composer attachments.
- `renderModel.ts` builds the demo render model from active read models and OpenAPI-safe fallbacks.
- `streamHandler.ts` applies velad SSE events to local read models and schedules scoped refreshes.
- `constants.ts` and `helpers.ts` hold small shared values for the demo shell.
