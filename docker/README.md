# Docker Compose deployment

This Linux deployment uses one immutable image in three independently restarted
containers:

| Service | Owns | Does not own |
| --- | --- | --- |
| `gateway` | HTTP/WebSocket admission, authentication, protocol translation and routing | model execution, task lifetime or native browser pages |
| `brain` | Codex Core/AppServer, DSH/Pi execution and task/session lifetime | public ingress, browser tabs or Codex native filesystem/shell execution |
| `hands` | remote-browser resources and the pinned Codex `exec-server` | account admission, AppServer state or conversation orchestration |

Recreating `gateway` leaves Brain tasks and Hands tabs alive. The Gateway
reattaches to both through private descriptors/sockets and never receives a
Docker socket. All three services use the same reviewed image, so Docker stores
the large runtime layers once.

Brain keeps Codex AppServer and its writable native session state. Its managed
environment forwards only the pinned `codex exec-server --listen stdio` process
to Hands over a private mode-0600 Unix socket. Each environment has a connection
lease; owner loss terminates the process group and never replays input. This is
not a general remote shell: other executables and argument vectors are rejected.

## First installation

The image is built from this checkout and its lockfile; it contains the pinned
Node, Codex, DSH and Electron runtimes. It contains no account or model
credential. On a Linux amd64 machine use `linux/amd64`; ARM64 is also supported.

```sh
cd docker
install -d -m 700 "$HOME/.opencraft" "$HOME/.opencraft/hands" "$HOME/opencraft-workspaces"
cat > .env <<EOF
OPENCRAFT_HOST_DATA_DIR=$HOME/.opencraft
OPENCRAFT_DATA_DIR=/data/.opencraft
OPENCRAFT_HOST_WORKSPACE_DIR=$HOME/opencraft-workspaces
OPENCRAFT_WORKSPACE_DIR=/data
OPENCRAFT_UID=$(id -u)
OPENCRAFT_GID=$(id -g)
OPENCRAFT_PORT=10000
OPENCRAFT_IMAGE=opencraft:local
OPENCRAFT_PLATFORM=linux/amd64
EOF
docker compose build
docker compose up -d --wait
docker compose ps
```

Open `http://127.0.0.1:10000`. The default listener is loopback-only. An
Internet-facing installation still needs the existing HTTPS and admission
configuration; do not expose a shared instance merely by changing the listener
to `0.0.0.0`.

## Storage and permissions

`OPENCRAFT_HOST_DATA_DIR` is mounted as `OPENCRAFT_DATA_DIR` in Brain and
Gateway. Hands receives only the `hands/` subdirectory and keeps browser and
exec-server sockets plus their private token there; it cannot read the account,
conversation or engine state beside that directory. `OPENCRAFT_HOST_WORKSPACE_DIR` is mounted
as `OPENCRAFT_WORKSPACE_DIR` in all three containers: Brain uses it for DSH/Pi,
Gateway projects it to clients, and Codex native tools execute against it only
inside Hands. Every container uses the same
container-side identity; descriptors and process leases fail closed if the
containers disagree about it.

The portable convention above stores state at `$HOME/.opencraft` on the host and
presents it as `/data/.opencraft` in every container. Workspaces are similarly
presented below `/data`. Do not put persistent state in the image layer.

All services run as `OPENCRAFT_UID:OPENCRAFT_GID`. The data directory must be
owned by that identity with mode `0700`; private tokens, descriptors and sockets
are mode `0600`. Compose refuses to create missing bind sources. Brain and
Gateway use host PID visibility because execution-lease recovery verifies real
process birth through `/proc`. They use host networking because the existing
private descriptors advertise loopback endpoints. Hands uses host networking so
remote pages see the server's network, but does not need host PID visibility.

The runtime includes open-source Noto CJK and Noto Color Emoji fonts for remote
browser rendering. Chromium sandboxing remains enabled; production does not set
`OPENCRAFT_BROWSER_ALLOW_NO_SANDBOX`. The Hands service drops Docker's default
capability set and adds only `SYS_ADMIN`, `SETUID`, `SETGID` and `SYS_CHROOT`,
which Chromium's setuid helper needs to create its nested sandbox namespaces on
common Docker hosts. This is not a privileged container. A runtime that supports
Chromium's unprivileged user namespace sandbox may remove those capabilities
after verifying browser startup.

## Upgrade and rollback

Build a content-addressed or versioned image tag, update `OPENCRAFT_IMAGE`, then
apply services in owner-first order:

```sh
docker compose up -d --no-deps brain hands
docker compose up -d --no-deps gateway
docker compose ps
```

An unchanged Brain or Hands container is not recreated. A Gateway-only release
can use `docker compose up -d --no-deps gateway`. Keep the previous image tag for
code rollback. A code rollback does not undo a database migration.

Before intentionally replacing Brain, let active tasks finish. Before replacing
Hands, close or checkpoint important live tabs; a compatible Gateway-only change
does not replace them. `docker compose down` stops all three owners and retains
the bind-mounted state. For a cold backup, stop all three and copy the complete
data and workspace directories with ownership and modes preserved.

## Validation

```sh
node --test ../tests/server/container-deployment.test.mjs
OPENCRAFT_IMAGE=opencraft:local node ../scripts/smoke/server/smoke-container.mjs
```

Acceptance must prove more than HTTP readiness: recreate only Gateway and check
that Brain PIDs and the Hands worker PID are unchanged, that an existing browser
tab retains its live document, and that no input is replayed after reattachment.
