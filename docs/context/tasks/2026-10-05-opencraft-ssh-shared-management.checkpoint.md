## stage
Source implemented and relevant verification passed. Complete gate stopped at the extension artifact assertion. User now authorized commit, push, master integration and preview restart.

## verified
- Own checkout `/data/mono2-ssh-native-integration-vYgvJx`, branch `fix/opencraft-ssh-shared-management-20261005`, baseline `b2a4d7ae0`.
- Own dependency installation, full workspace typecheck, boundaries/i18n and documentation checks passed.
- Final SSH suite 75 passed / one platform skip; management API 21, controller 20 and headless suite 29 passed.
- Actual built Workbench smoke passed shared light/public and shared dark/loopback plus protected light/public and protected dark/loopback. Every run covers desktop and touch, database CRUD, trust confirmation, menus, catalog discovery/recovery and no remote writes.
- Shared smoke also revokes the browser cookie, rejects bootstrap, verifies no key challenge, then retries successfully.
- Sessions are still origin-bound and enforced at HTTP/WS boundaries. Both shared and key policies pass two-origin HTTP/WS isolation tests.
- Existing access.key stays unchanged; explicit access-file enables key protection.

## unverified
- Full gate failed at unchanged `extension-artifacts.test.ts:38` (additional persisted `artifactRef`); isolated Node run passes, tsx run reproduces failure. Not repaired outside this task scope.
- Real deployed preview remains old mandatory-key build; this candidate has not been switched onto port 80.

## discard
- Earlier UI-only bypass and removal of backend session checks were rejected.
- Prior SSH delivery restart authorization does not apply automatically to this new feature.

## restore
- Task Pack `2026-10-05-opencraft-ssh-shared-management.md` and current source are authoritative.
- External logs `/data/opencraft-ssh-native-release-ZQr7oa/shared-*.log` and `protected-ui-*.log`.
- Current preview `opencraft-ssh-native-20261005-preview.service`, build `20261005-ssh-native-844b7ce8e`; do not stop it before a new switch authorization.

## next_action
- Publish scoped source to master, then build/package a fresh headless candidate and switch through the self-hosted preview Skill. Actual old owner is `opencraft-native-desktop-control-20261005-preview.service`, cwd `/data/opencraft-desktop-control-preview-glGz6n/opencraft-server`; confirm again before switching. Do not use the stale earlier SSH unit for rollback.
