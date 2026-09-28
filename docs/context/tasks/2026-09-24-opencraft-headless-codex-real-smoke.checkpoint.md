## stage
Real Web Codex turn and full OpenCraft gate passed; handoff.

## verified
- Four accounts were imported from the local OpenCraft pool under explicit user authorization; WebUI displayed all four and a real GPT-5.6-Luna turn returned `OPENCRAFT_CODEX_OK`.
- The synthetic `/v1/responses` path was incorrectly forwarded as `/backend-api/codex/v1/responses`; source, focused tests, typecheck, and fixture smoke now use `/backend-api/codex/responses`.
- The remote Codex runtime has its own installation ID. No Mac installation ID was copied.
- Temporary credential snapshots were deleted locally and remotely; the private server remains active with four owned accounts.
- `npm run gate`, documentation validation, and focused account-pool checks passed.

## unverified
- The older Linux tar has not been rebuilt; the active preview uses a new server bundle with the prior Web/native assets.
- Refresh-token behavior across two independent installations over longer periods has not been validated.

## discard
- Initial `429` turns ran against the incorrect upstream path; they do not prove machine binding or account quota exhaustion.
- A stale browser tab reported `AppServer transport is not open` after service restart; a fresh/reloaded tab connected successfully.

## restore
- Changed source: `opencraft/packages/account-pool-host/src/codex-proxy.ts`; matching tests and docs.
- Active private preview: separate route-fix install, same loopback port and existing state directory; old install retained for rollback.
- Real turn result and four-account state are visible in the independent WebUI test tab.

## next_action
Report source/preview/artifact states separately and do not claim a new distributable tar.
