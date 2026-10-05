## stage
Delivered. Scoped source committed, pushed and merged into master; user-authorized combined temporary preview switched successfully and verified after reconnection. Complete gate retains the unrelated extension artifact assertion failure.

## verified
- Own checkout `/data/mono2-ssh-native-integration-vYgvJx`, branch `fix/opencraft-ssh-shared-management-20261005`, baseline `b2a4d7ae0`.
- Own dependency installation, full workspace typecheck, boundaries/i18n and documentation checks passed.
- Final SSH suite 75 passed / one platform skip; management API 21, controller 20 and headless suite 29 passed.
- Actual built Workbench smoke passed shared light/public and shared dark/loopback plus protected light/public and protected dark/loopback. Every run covers desktop and touch, database CRUD, trust confirmation, menus, catalog discovery/recovery and no remote writes.
- Shared smoke also revokes the browser cookie, rejects bootstrap, verifies no key challenge, then retries successfully.
- Sessions are still origin-bound and enforced at HTTP/WS boundaries. Both shared and key policies pass two-origin HTTP/WS isolation tests.
- Existing access.key stays unchanged; explicit access-file enables key protection.
- Feature commit `3056e63bf`, master merge `cd9be26fe`; remote master confirmed after push.
- Combined candidate retains uncommitted desktop-control changes only in its isolated preview checkout. SSH 75 passed / one platform skip, headless 30, desktop 100, workspace typecheck, boundaries/i18n and official packaged desktop/touch smoke passed.
- Independent cutover receipt: `2026-10-05T12:05:03.318Z`, outcome switched. Actual port-80 owner checked after reconnection: `opencraft-ssh-shared-desktop-20261005-preview.service`, PID `3327884`, build `20261005-ssh-shared-desktop-cd9be26fe`, runtime SHA-256 `dc1859312676a6bba83efe964176f085b8d5fd87ff851795a02fed94a0e650f8`.
- Live health, shared SSH admission, saved SSH native conversation recovery and preserved native desktop viewer/control grant-release checks passed; no inference or user-application input. Existing data/key and old package retained.

## unverified
- Full gate failed at unchanged `extension-artifacts.test.ts:38` (additional persisted `artifactRef`); isolated Node run passes, tsx run reproduces failure. Not repaired outside this task scope.
- Rollback is implemented and the old package retained, but rollback was not deliberately triggered. External production/GitOps deployment is outside this delivery.

## discard
- Earlier UI-only bypass and removal of backend session checks were rejected.
- Prior SSH delivery restart authorization does not apply automatically to this new feature.

## restore
- Task Pack `2026-10-05-opencraft-ssh-shared-management.md` and current source are authoritative.
- External logs `/data/opencraft-ssh-native-release-ZQr7oa/shared-*.log` and `protected-ui-*.log`.
- Current preview `opencraft-ssh-shared-desktop-20261005-preview.service`; prior package/unit `opencraft-native-desktop-control-20261005-preview.service` retained for rollback. Combined source, artifacts, logs and independent cutover receipt are outside Git.

## next_action
- Hand off verified delivery. No further restart or source mutation required; any subsequent switch must re-resolve the actual process/unit owner.
