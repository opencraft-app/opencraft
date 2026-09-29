# AppHost connection diagnostics checkpoint

## stage

Source implementation and local validation complete; awaiting explicit authorization before any running-service replacement.

## verified

- Existing live AppHost allows two simultaneous local WebSocket hello/Host-connect claims; the browser screenshot's generic `error` does not establish a one-client restriction.
- Browser and headless server now correlate payload-free connection stages by per-attempt ID. Headless tests 19/19 and AppServer tests 232/232 pass; Web typecheck, boundaries and build pass.
- Current production-like `opencraft-server.service` was not replaced by this task.

## unverified

- The exact second-phone failure layer and root cause require a new reproduction against an updated service, then matching `client-failure` and WebSocket stage events by attempt ID.
- No real mobile browser or external reverse-proxy path was exercised in this turn.

## discard

- Do not use the old generic “App Host connection failed” text as evidence of Host claim rejection.

## restore

- Relevant paths: `opencraft/apps/workbench-web/src/runtime/websocket-app-host.ts`, `opencraft/scripts/serve-workbench-web.mjs`, adjacent tests and `opencraft/docs/platform-architecture.md`.
- Preserve the dirty worktree; it contains many unrelated in-progress user changes. Do not stage, commit, push or release without renewed scope confirmation.

## next_action

- If the user authorizes replacement, prepare a health-checked build/cutover and reproduce with two real clients; classify the correlated attempt before proposing a fix.
