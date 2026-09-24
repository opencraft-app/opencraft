## stage
Implemented and deployed on the authorized test server; handoff pending.

## verified
- Existing browser Workbench transport renews its AppHost lease after a WebSocket close; regression test passes.
- Public-mode Origin admission was removed for HTTP and both WebSocket paths, while loopback-only enforcement remains; 14 headless tests pass.
- Linux archive smoke passes for build `20260924071840-bd4608375a9f`; the systemd service on port 80 is active with zero recorded restarts.
- The HTTPS proxy serves the current JS asset and opens the Codex AppHost WebSocket; an existing Codex Thread restored in a Mac browser.

## unverified
- No long-running idle/reconnect soak was performed through the HTTPS proxy after the final Origin-gate change.
- No new paid model turn was submitted after the final deployment.

## discard
- The older hashed asset URL from the prior build: it is not a current release asset.
- The prior public-mode `sameOriginOnly` assertion and its 403 result.

## restore
- Source truth: `opencraft/apps/workbench-web/src/runtime/websocket-app-host.ts`, `opencraft/scripts/serve-workbench-web.mjs`, `opencraft/scripts/headless-server.mjs`.
- Deployment target: `9.135.92.56`, systemd `opencraft-server.service`, release `/opt/opencraft-server/releases/6ee49d0996855fda`.
- Previous release remains at `/opt/opencraft-server/releases/936c4e14a1796d31` for rollback.

## next_action
- If the user reports another failure, capture the precise proxied WebSocket close code/handshake and current browser build ID before changing source or restarting the service.
