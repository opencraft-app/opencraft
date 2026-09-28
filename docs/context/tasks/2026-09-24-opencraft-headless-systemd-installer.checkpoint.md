## stage
Native Linux packaging, authorized installation and port-80 migration complete; handoff.

## verified
- `opencraft/scripts/install-headless-linux.sh` installs one persistent DynamicUser systemd service from a SHA/manifest-verified tar and refuses existing unit/current release or an occupied port.
- Explicit runtime `--host 0.0.0.0 --allow-unauthenticated-public` binds one port (installer default 80) for static WebUI, `/appserver` and `/apphost`; private default remains loopback-only and public WebSocket Origin must match Host. The systemd unit grants only `CAP_NET_BIND_SERVICE` for port 80.
- A non-loopback HTTP browser loaded isolated built WebUI and created a draft through the getRandomValues-backed UUID fallback.
- Installer Bash syntax, 14 focused headless tests, Web typecheck, Web release build, full OpenCraft gate and documentation/change-impact checks passed.
- Linux tar build ID `20260923211700-891f42ec7ba5` passed native archive, DSH and Codex smoke. `opencraft-server.service` is enabled/active on `0.0.0.0:80`; local and external HTTP, both WebSockets, four-account persistence and browser restoration of an existing Codex Thread passed after restart.

## unverified
- A full host reboot was not performed; `enabled` plus targeted service restart is the current persistence evidence.
- A new paid model turn was not sent specifically on port 80; existing Codex history restored and both execution transports initialized.
- Browser secure-context-only features remain unavailable over ordinary HTTP.

## discard
- Initial Nginx reverse-proxy approach was explicitly rejected by the user; no Nginx config remains in the installer.
- The prior tar lacked `--host`; the newly native-built tar replaced it for this deployment.

## restore
- Source: `opencraft/scripts/install-headless-linux.sh`, `headless-server.mjs`, `serve-workbench-web.mjs`, Web UUID fallback and focused tests.
- Design: `opencraft/docs/build-matrix.md`, `opencraft/docs/platform-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- The old 8089 unit and four-account state have root-only backups. The temporary Python port-80 probe was stopped before switching; the old 8089 listener is gone. No unrelated service was changed.

## next_action
Report the port-80 URL, retained artifact and backup boundary. Do not claim full-machine reboot or TLS/access control; wait for user direction before further changes.
