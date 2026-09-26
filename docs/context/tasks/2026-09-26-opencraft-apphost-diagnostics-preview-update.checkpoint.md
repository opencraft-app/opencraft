# AppHost diagnostics preview update checkpoint

## stage

Health-checked cutover completed; live service verified. Awaiting real two-client conversation reproduction.

## verified

- New archive build `20260926081211-2224a6698459` passed isolated headless package smoke.
- New release is staged at `/opt/opencraft-server/releases/20260926081211-2224a6698459`; old `/opt/opencraft-server/releases/20260926061700-4ff168f72dc8` remains active.
- Timer `opencraft-apphost-cutover-2224a6698459.timer` will run at 2026-09-26 16:17:16 CST; script syntax passed.
- Cutover service exited successfully. Current release symlink and served `/version.json` both show `20260926081211-2224a6698459`; health is `ok:true`, service active.
- Runtime logs show two concurrent `/apphost` sockets and both `host-connect` outcomes successful.

## unverified

- Actual reproduction of the original second-phone same-conversation restore failure.

## discard

- Do not treat two successful concurrent Host connects as proof that same-Thread restore or the external network path is fixed.

## restore

- Inspect new `[opencraft apphost connection]` events by `attemptId` around the next failed two-client reproduction; compare `client-failure` to `upgrade-*`, `hello-*`, `host-connect`, heartbeat and close.
- Rollback is embedded in `/data/opencraft-apphost-update-Zd0ef1WR/switch-preview.sh`; it preserves both release directories and the existing state directory.

## next_action

- Reproduce the same conversation from two clients at the same time, then correlate the failing attempt ID and determine the responsible layer.
