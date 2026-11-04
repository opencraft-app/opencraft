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
OPENCRAFT_HANDS_CPUS=4.0
OPENCRAFT_HANDS_MEMORY_BYTES=8589934592
EOF
node ../scripts/container-deployment/compose-release.mjs doctor
docker compose build
docker compose up -d --wait
docker compose ps
```

The default Hands execution budget is 4 CPUs and 8 GiB. The deployment doctor
requires another 2 GiB of host RAM for Brain, Gateway and the operating system,
and at least 5 GiB free on the data filesystem. An intentionally
oversubscribed experiment can pass `--allow-oversubscription`; that flag records
an operator decision, not a production sizing recommendation. If the Hands
budget is changed, Compose, Brain admission and the kernel verification all
consume the same two values and reject disagreement.

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
are mode `0600`. Use a dedicated non-root identity: UID or GID 0 is rejected so
the Chromium sandbox is never replaced with a root/no-sandbox deployment.
Compose refuses to create missing bind sources. Brain and
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

Build a content-addressed or versioned image reference, then use the transaction
tool. It checks paths, ownership, capacity, disk and rendered Compose config;
uses a deployment lock; applies and waits for each owner in strict dependency
order (`hands`, `brain`, `gateway`); and writes `.env` only after all three are
healthy:

```sh
node ../scripts/container-deployment/compose-release.mjs doctor
node ../scripts/container-deployment/compose-release.mjs upgrade \
  ghcr.io/opencraft-app/opencraft@sha256:REPLACE_WITH_VERIFIED_DIGEST
```

If a stage fails, the tool reapplies the previous image in the same owner order.
After a successful change, this explicit command reuses the recorded previous
image:

```sh
node ../scripts/container-deployment/compose-release.mjs rollback
```

Mutable `latest`, untagged and local development images are refused unless the
operator explicitly passes `--allow-mutable-image`. Keep the previous digest in
the registry. A code rollback does not undo a database migration and must never
be represented as data rollback; take a cold data backup before a migration.
An unchanged owner is not recreated. A reviewed Gateway-only change may still
use `docker compose up -d --no-deps --wait gateway` when its image digest is
already persisted in `.env`.

Before intentionally replacing Brain, let active tasks finish. Before replacing
Hands, close or checkpoint important live tabs; a compatible Gateway-only change
does not replace them. `docker compose down` stops all three owners and retains
the bind-mounted state. For a cold backup, stop all three and copy the complete
data and workspace directories with ownership and modes preserved.

## Local scheduled builds from GitHub

The optional systemd timer builds on the Docker host, not on a GitHub runner. It
fetches `origin/main`, checks out the exact remote commit in an isolated detached
worktree and builds `opencraft:git-<full-sha>`. Only a successful build advances
the convenience tag `opencraft:main-local`; a failed build leaves the prior image
intact. A lock prevents timer and manual invocations from overlapping.

Install the tracked script, configuration and units as root:

```sh
install -D -o root -g root -m 0755 \
  scripts/container-deployment/build-from-github.sh \
  /usr/local/libexec/opencraft-build-from-github
install -D -o root -g root -m 0600 \
  packaging/container-build/opencraft-github-build.env.example \
  /etc/opencraft-github-build.env
install -D -o root -g root -m 0644 \
  packaging/container-build/opencraft-github-build.service \
  /etc/systemd/system/opencraft-github-build.service
install -D -o root -g root -m 0644 \
  packaging/container-build/opencraft-github-build.timer \
  /etc/systemd/system/opencraft-github-build.timer
systemctl daemon-reload
systemctl enable --now opencraft-github-build.timer
systemctl start opencraft-github-build.service  # optional immediate build
```

The timer checks one minute after activation and one minute after each completed
check or build. An unchanged Git revision exits without building, while a long
build cannot overlap its successor. `systemctl list-timers
opencraft-github-build.timer` shows the next run; build logs are available through
`journalctl -u opencraft-github-build.service`.

## Validation

```sh
node --test ../tests/server/container-deployment.test.mjs
OPENCRAFT_IMAGE=opencraft:local node ../scripts/smoke/server/smoke-container.mjs
```

Acceptance must prove more than HTTP readiness: recreate only Gateway and check
that Brain PIDs and the Hands worker PID are unchanged, that an existing browser
tab retains its live document, and that no input is replayed after reattachment.
