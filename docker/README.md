# Docker Compose deployment

This first delivery targets **Linux ARM64**, Docker Engine and Docker Compose v2. The native Host payload requires a
glibc-based Linux system compatible with Debian 12 (for example Ubuntu 24.04).
Docker runs the complete Headless Web/HTTP/WebSocket gateway. The existing DSH Host (including model configuration), Pi
Engine Host, Codex Core and its independent AppServer run as ordinary processes on the Linux host. Their
tools operate with that host user's permissions. Each owner retains its own
storage and locks; recreating the gateway does not stop the execution owners.

The image is built from this checkout and its lockfiles. No npm publication or
pre-published OpenCraft image is required. The native Host is exported from the
same build, including its pinned Node and Codex CLI; the host does not need a
source checkout or npm dependencies to execute it. First-build downloads include
the Web dependencies, execution runtimes and bundled browser runtime.

## First installation

Use a regular Linux user that can run Docker. Start with new, private data and
workspace directories. Existing deployments must first drain and stop their old
writers before adopting these paths; do not copy live SQLite files or launch a
second Host against existing data.

From the repository root, enter `docker/` and create the local configuration (it is Git-ignored):

```sh
cd docker
cat > .env <<EOF
OPENCRAFT_DATA_DIR=$HOME/.local/share/opencraft
OPENCRAFT_WORKSPACE_DIR=$HOME/opencraft-workspaces
OPENCRAFT_UID=$(id -u)
OPENCRAFT_GID=$(id -g)
OPENCRAFT_PORT=10000
OPENCRAFT_IMAGE=opencraft:local
OPENCRAFT_PLATFORM=linux/arm64
EOF
docker compose build
docker buildx build --platform linux/arm64 --target host-artifact -f Dockerfile \
  --output type=local,dest=../.local/docker-host ..
../.local/docker-host/bin/opencraft-host
```

The last command reads `.env` and stays in the foreground. It initializes private
state, a Core token and the independent DSH/Codex/Pi owners. Keep it running. For a
persistent installation, run that exact exported launcher with a service manager
under the same user, environment and working directory. The Host service must
have an independent lifecycle from Docker and the gateway. Keep the exported
payload at a fixed path until its own drained maintenance; do not overwrite it
while tasks are active. Host/CLI upgrades are separate from gateway upgrades.

In another terminal, from the same `docker/` directory:

```sh
docker compose up -d --wait
docker compose ps
docker compose logs --tail=50
```

Open `http://127.0.0.1:10000`. For a remote server, use an SSH tunnel such as
`ssh -L 10000:127.0.0.1:10000 user@server` and open that local URL.
Configure a model in Settings or explicitly sign in to Codex Accounts before
running a task. No real account or model credential is included in either
artifact, and startup does not perform a paid inference or automatic login.

The listener is loopback-only. An Internet-facing deployment still needs HTTPS
and admission configuration; use the existing [server account configuration](../docs/server-authentication.md)
and [Headless deployment contracts](../docs/managed-headless.md). Do not expose this
shared local installation by merely changing its listener to `0.0.0.0`.

## Data, networking and permissions

`OPENCRAFT_DATA_DIR` is an independent **bind-mounted data volume**, outside the
image and container writable layer. It contains the machine identity, model
configuration, credentials, accounts, conversations, databases and private Host
connection descriptors. `OPENCRAFT_WORKSPACE_DIR` is a separate bind-mounted
workspace. Both paths are absolute and mounted at the **same path** in the
container and host. The independent Host descriptor checks this data identity;
mapping `/host/state` to `/data` would break that contract.

There are three persistence owners even though this single-machine entry shares
one data root:

| Owner | Persistent state |
| --- | --- |
| Headless service | Accounts, authorization, service configuration, conversations and attachments, in the data root and its owner-specific subdirectories |
| Execution Host | Machine identity, model configuration, engine credentials, execution sessions and recovery state; the launcher explicitly places DSH under `agent/`, Pi under `pi/`, Codex Core under `codex/` and native Codex under `native-codex/` |
| Workspace | User projects and generated files, in the separate workspace mount or explicitly configured project roots |

Recreating the gateway retains both service and Host state. The `run/` directory
contains local sockets and connection descriptors, not portable execution
processes. A backup does not preserve a running process or resume every engine
automatically. For a separately deployed remote Host, preserve its data and
workspaces on that machine as well; backing up the service alone cannot include
remote files. Project roots outside the workspace mount need separate backups.

Bind mounts are intentional: the native host processes must access the same
files. Docker-managed named volumes are not the default for this topology. See
[Docker's guidance on host access to volume data](https://docs.docker.com/engine/storage/volumes/).
The native launcher creates its data directory with mode `0700`; its token and
descriptor files are private. `OPENCRAFT_UID/GID` must match that user's numeric
IDs. Compose refuses to create missing bind sources, so a typo cannot silently
create a root-owned empty deployment. The container never changes ownership of
an existing installation.

The native AppServer owns a real socket relay in the shared data directory;
the native CLI may keep its internal socket alias in host-private temporary
storage. The gateway attaches the relay and does not mount host `/tmp`.

The existing Host descriptors advertise authenticated host-loopback endpoints.
Compose therefore uses Linux `network_mode: host`, with no port publishing.
The existing execution-lease recovery verifies process ownership and birth
through `/proc`, so Compose also uses `pid: host`. The gateway can therefore see
the host PIDs and their real process identity. Its filesystem remains contained,
with explicit data/workspace mounts; tools execute in the native Host processes.
The gateway mounts no Docker socket and does not require privileged mode. The Host uses the
explicit workspace directory as runtime cwd; individual Project/Thread cwd
continues to follow the existing execution contracts. Additional host project
roots may need identical-path bind mounts for gateway-side file features.

The shipped launcher selects the existing DSH and Pi engines (Pi is the default) plus native
Codex. Model Services uses the existing DSH Host to write the shared model
configuration consumed by both engines. All execution owners run outside
the gateway. ACP and existing multi-generation Core deployments retain their separate
[managed configuration](../docs/managed-headless.md); this first Compose entry does not
automatically migrate those owners. The default image and native payload target ARM64. For an amd64 server, set
`OPENCRAFT_PLATFORM=linux/amd64` and use that same platform for the Host export.
A Linux execution payload cannot run natively on macOS or Windows.

## Upgrade, restart and backup

```sh
# Gateway only; the native Host remains running.
docker compose build
docker compose up -d --wait

# Stops the gateway and retains data and workspaces.
docker compose down
```

Use a new image tag for each reviewed version, set `OPENCRAFT_IMAGE` accordingly,
and keep the previous image for a code rollback. Reuse the same `.env`, paths
and UID/GID. A code rollback does not reverse a database migration; apply the
existing [SQLite lifecycle](../docs/sqlite-lifecycle.md) compatibility rules.

Back up the data directory and workspaces outside Docker. For a cold backup,
first let tasks finish, stop the gateway, then stop the native Host through its
service manager, and copy the complete private data directory and project files
with their modes and ownership. Restart the Host before bringing up Compose.
Never delete the configured data path to repair a startup failure. A container
restart cannot recover a Host that is not running or has mismatched permissions.

The Compose healthcheck observes the real Core, DSH and Engine Host. An unavailable
owner makes `/health` return 503; the gateway does not substitute an embedded
execution engine. Model-provider reachability, paid inference, actual OAuth and
native desktop/browser capabilities require their own validation.

## Validation

From `docker/`:

```sh
node --test ../tests/server/container-deployment.test.mjs
OPENCRAFT_IMAGE=opencraft:local node ../scripts/smoke/server/smoke-container.mjs
```

On Linux with the same architecture as the image, the smoke exports and runs the native Host directly on the host,
then exercises the Compose gateway, persistent data, gateway recreation and
external-owner availability. On other development hosts it uses a second Linux
container solely as the external-owner fixture; this validates separation from
the gateway and shared state, and is not native macOS/Windows deployment proof.
The test uses isolated directories/volumes and no real account or paid model.
