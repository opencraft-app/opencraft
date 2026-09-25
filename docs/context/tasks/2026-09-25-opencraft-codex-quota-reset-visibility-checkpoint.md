## stage
Implementation, typecheck, focused test, packaging, package smoke and staging complete. Next gate is local preview switch and live version/health check.

## verified
- OpenCraft Host already exposes nullable `resetAt`; the page previously used it only in hover `title`.
- New UI shows local reset time in each quota row and full time in expanded details. Missing time is explicit.
- Build `20260925103419-23c1aeeb42e7` passed package smoke and is staged in an independent release directory.
- Current preview before switch is `20260925094935-96fce7adcca3`.

## unverified
- Actual live page after restart; current account's upstream reset timestamp may independently be null.

## discard
- Generic router matches to subscription billing and LightVela frontend do not own Codex account-pool quota.
- Direct `/opt` writes from the current command environment fail read-only; systemd transient units can stage to the host mount.

## restore
- Switch script: `/data/opencraft-quota-npm-shim-20260925/switch-release.sh`.
- New release: `/opt/opencraft-server/releases/20260925103419-23c1aeeb42e7`.
- Old release: `/opt/opencraft-server/releases/20260925094935-96fce7adcca3`.

## next_action
Schedule switch in systemd after the current turn can safely finish, then verify service health, buildId and UI on reconnection.
