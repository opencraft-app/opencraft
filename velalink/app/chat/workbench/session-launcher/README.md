# session-launcher

Debug-only launcher for the `/chat` demo shell.

This folder owns local velad connection setup, recent session picking, manual session id entry, and session creation. It must not be imported by `packages/vela-chat-web`; the reusable ChatUI starts only after `ChatWorkbench` has an active session and a read model.

- `DebugSessionLauncher.tsx`: empty-state UI for opening or creating a session.
- `model.ts`: small presentation helpers for recent session rows.
