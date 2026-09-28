## stage
Implementation and Linux/browser validation complete; handoff.

## verified
- Web Codex Host uses the existing Server-owned stdio adapter through AppHost lease/generation protocol; malformed and cross-origin `/apphost` frames are rejected.
- Browser reconnect creates a fresh AppHost channel after transport close; full OpenCraft gate and focused tests pass.
- Linux amd64 tar build ID `20260923174956-460956f5efc4` passed manifest integrity, DSH initialize, Codex initialize and empty account-list smoke; local artifact SHA-256 matches remote source.
- Final remote transient unit runs on `127.0.0.1:10000`; real browser shows Codex Connected, model selector and Codex Accounts page. The current data directory was preserved during the final version switch.

## unverified
- No real ChatGPT account login, usage entitlement or paid inference. Device-code login depends on user/workspace policy as documented by OpenAI.
- No public ingress auth, multi-user Hub, production rollout or portability to older Linux glibc than the test host. CI's native Ubuntu artifact has not run because no commit/push was authorized.

## discard
- The first Codex browser preview failed due an AppHost ready-state check against missing static WebSocket constants. That path was corrected and covered by a wrapper regression test.
- The failed first Codex install and remote temporary build tree were removed after exact inactive/target checks; previous successful installs remain as rollback.

## restore
- Source: `opencraft/scripts/headless-server.mjs`, `serve-workbench-web.mjs`, `package-headless-linux.mjs`, Web AppHost client, built-in Codex Web extension, exact-version Codex runtime lock, docs/tests.
- Artifact: `opencraft/release/OpenCraft-server-0.1.0-linux-amd64-20260923174956.tar.gz` (ignored local build output).
- Runtime: `/opt/opencraft-preview-20260923174956/opencraft-server` under the transient final Codex preview unit, loopback port 10000; local SSH tunnel is temporary.
- Working tree was dirty before this task. Do not revert or stage unrelated edits.

## next_action
Hand off the artifact and private preview; user may initiate device-code login from WebUI. Commit/push/publish only on separate explicit authorization.
