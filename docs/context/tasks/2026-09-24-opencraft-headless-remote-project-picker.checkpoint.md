## stage
Implemented, deployed and verified on the authorized Linux test server; handoff pending.

## verified
- The Mac Web project menu enables Add project for both headless Codex and DSH nodes and browses their Linux filesystem, including `/data` on Codex.
- The root-mounted service is UID/GID 0; its mount namespace keeps `/` read-only and `/data` read-write. A Codex AppHost file-write probe succeeded and was removed.
- Existing Codex history resumes through a narrow `/var/lib/private/<state-name>` compatibility symlink after DynamicUser-to-root StateDirectory relocation.
- Isolated package smoke covered real DSH and Codex `fs/readDirectory` plus `project/create`; build `20260924075922-075bd8b7df75` is deployed.

## unverified
- A real private `git clone` was not run; repository credentials are separate from filesystem access.
- No long-duration service uptime/idle soak after this deployment.

## discard
- The old explanation that OpenCraft ran inside a container. It is a systemd mount namespace.
- The initial broad-root-write interpretation; the user explicitly kept `/` read-only and chose `/data` as the writable exception.

## restore
- Current release: `/opt/opencraft-server/releases/c82755fe3abc9853`; previous release: `/opt/opencraft-server/releases/6ee49d0996855fda`.
- Current unit: `/etc/systemd/system/opencraft-server.service`; previous unit backup: `/var/backups/opencraft/opencraft-server-before-root-data-20260924.service`.
- State backup: `/var/backups/opencraft/opencraft-state-before-root-data-20260924.tar.gz` (0600).
- Old absolute Codex session references require the existing `/var/lib/private/opencraft-preview-codex-20260923173651` symlink.

## next_action
- On any follow-up failure, inspect the live unit, mount namespace, current build ID, Host RPC and browser state before changing the service or clearing client storage.
