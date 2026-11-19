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

The default image follows upstream and packages the pinned stock Electron runtime.
Node, Codex and DSH are pinned by this checkout and lockfile; no account or model
credential is included. Native Linux amd64 and arm64 build hosts are supported.
Docker Desktop runs these Linux containers inside its VM.

Internal builds can opt into a verified custom browser by setting
`OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION` and using
`docker compose -f compose.yaml -f compose.owned-electron.yaml build`.
That path uses `Dockerfile.owned-electron` and requires Docker Compose 2.17+.
Custom artifacts retain their provenance and native probe checks.

```sh
cd docker
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /srv/opencraft
cat > .env <<EOF
OPENCRAFT_HOST_DATA_DIR=/srv/opencraft/state
OPENCRAFT_DATA_DIR=/var/lib/opencraft
OPENCRAFT_HOST_WORKSPACE_DIR=/srv/opencraft/workspaces
OPENCRAFT_WORKSPACE_DIR=/workspace
OPENCRAFT_HOST_LOG_DIR=/srv/opencraft/logs
OPENCRAFT_LOG_DIR=/var/log/opencraft
OPENCRAFT_UID=$(id -u)
OPENCRAFT_GID=$(id -g)
OPENCRAFT_PORT=10000
OPENCRAFT_IMAGE=opencraft:local
OPENCRAFT_PLATFORM=linux/amd64
OPENCRAFT_HANDS_CPUS=4.0
OPENCRAFT_HANDS_MEMORY_BYTES=8589934592
EOF
node ../scripts/container-deployment/layout.mjs prepare
node ../scripts/container-deployment/compose-release.mjs doctor
docker compose build
docker compose up -d --wait
docker compose ps
```

Direct builds use the same Dockerfile and contract:

```sh
docker buildx build --load -f docker/Dockerfile \
  --target runtime -t opencraft:local .
```

The optional owned-browser Dockerfile rejects missing or invalid artifacts
before dependency installation. The standard Dockerfile does not need that input.

CI restores native artifacts from the successful `Electron fork native artifacts`
run selected by repository variable `OPENCRAFT_ELECTRON_ARTIFACT_RUN_ID`.
That run must contain the requested target with its archive and current fork
probe markers. The consumer verifies all bytes before building; an absent or
stale artifact is an error. CI does not silently replace it with stock Electron.

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

Container paths have one convention, independent of the deployment user's home:

| Purpose | Container path | Host path in the example |
| --- | --- | --- |
| Versioned runtime | `/opt/opencraft` | Image; replaceable and never used for user files |
| Private application state | `/var/lib/opencraft` | `/srv/opencraft/state` |
| Browser profile | `/var/lib/opencraft/execution/browser` | `/srv/opencraft/state/execution/browser` |
| Execution home and sockets | `/var/lib/opencraft/execution` | `/srv/opencraft/state/execution` |
| Execution-bound CLI launchers | `/var/lib/opencraft/execution/cli` | `/srv/opencraft/state/execution/cli` |
| Terminal owner state | `/var/lib/opencraft/execution/terminal` | `/srv/opencraft/state/execution/terminal` |
| Projects and source checkouts | `/workspace/projects/<name>` | `/srv/opencraft/workspaces/projects/<name>` |
| Conversations without a project | `/workspace/sessions/codex/<id>`, `/workspace/sessions/dsh/<id>` | Under `/srv/opencraft/workspaces/sessions` |
| Service logs | `/var/log/opencraft/<service>/service.log` | `/srv/opencraft/logs/<service>/service.log` |

Keep an OpenCraft source checkout at `/workspace/projects/opencraft` when the
agent needs to maintain it. A checkout under `/tmp` is temporary, not a deployment
source authority. The runtime image remains at `/opt/opencraft`; do not copy a
checkout or dependencies into the installed runtime. Do not create a `.opencraft`
symlink inside the workspace to select state: use the explicit mount paths.
The Gateway creates execution-bound CLI launchers in the shared execution mount,
so the paths returned to Hands exist there. Signing keys and account state remain
in private application state; they are not exposed with the CLI directory.

Hands also supervises the unified Workbench terminal owner. Gateway routes
authenticated local Host `process/*` requests through `execution/terminal.sock`
using the private `execution/terminal.token`. The shell runs in Hands, within
its declared cgroup limits, and uses the conversation's explicit cwd. This does
not enable Codex's local execution environment. Closing a frontend/Host
connection preserves the PTY; restarting Hands ends it. Terminal readiness is
part of the Hands health check. See [terminal semantics](../docs/architecture/platform/presentation-and-input.md#conversation-terminal-semantics).

`OPENCRAFT_HOST_DATA_DIR` is mounted as `OPENCRAFT_DATA_DIR` in Brain and
Gateway. Hands receives only the `execution/` subdirectory and keeps browser and
exec-server sockets plus their private token there; it cannot read the account,
conversation or engine state beside that directory. `OPENCRAFT_HOST_WORKSPACE_DIR` is mounted
as `OPENCRAFT_WORKSPACE_DIR` in all three containers: Brain uses it for DSH/Pi,
Gateway projects it to clients, and Codex native tools execute against it only
inside Hands. Every container uses the same
container-side identity; descriptors and process leases fail closed if the
containers disagree about it.

`layout.mjs prepare` creates the execution and log directories with private
permissions. `doctor` checks the existing directories without changing them.
Host and container roots can be configured independently; persist the selected
paths in `.env` rather than deriving them from HOME or the source checkout.
Do not put persistent state in the image layer.

### Logs available to the agent

All three services see `/var/log/opencraft` read-only and have a separate writable
mount for their own service subdirectory. Hands can read Brain and Gateway logs
without Docker access or access to private account databases. There is no public
HTTP log endpoint and no Docker socket mount.

The service supervisor tees existing stdout and stderr to Docker and to JSONL
files containing `time`, `stream` and `message`. It does not capture stdin,
RPC payloads or environment variables. Each service retains a current file and
three archives (`service.log.1` through `.3`), each at most 10 MiB for output
written by the supervisor. Records are flushed before normal shutdown finishes;
SIGTERM/SIGINT are forwarded to the existing owner. The supervisor uses async
file IO and backpressure. If file logging fails after startup, it reports the
failure to stderr and continues Docker output without stopping active work.
The separate log mount also means logs can use their own host filesystem.
Docker's local log driver is also bounded to three 10 MiB files per service;
`docker compose logs` remains available independently of the shared files.

For example, from a conversation's shell:

```sh
tail -n 100 /var/log/opencraft/brain/service.log
tail -n 100 /var/log/opencraft/gateway/service.log
```

### Existing deployments

Do not replace an existing `.env` with the example or rename live state
directories. Engine session records contain absolute cwd and native history
paths. Changing only a mount name does not migrate those records.

Before upgrading a deployment that uses `hands/`, run these commands in its
existing checkout as the deployment user:

```sh
node scripts/container-deployment/layout.mjs adopt-legacy
node scripts/container-deployment/layout.mjs prepare
node scripts/container-deployment/compose-release.mjs doctor
```

`adopt-legacy` makes a private `docker/.env.before-layout` backup and explicitly
pins the existing browser, execution, projectless cwd and Gateway home paths.
It changes no data, starts no service and rejects conflicting overrides.
It also explicitly permits an existing administrator-owned shared workspace
root when it is readable/searchable and not group/other writable; it never
changes ownership or permissions of that host directory. New workspaces still
require the deployment user's private directory.
`prepare` refuses to silently create an empty execution directory alongside
detected old Hands state. The same release then adds the shared logs while
preserving existing sessions. Fresh installations use the canonical table above.
Normalizing an existing install's persisted identities is a separate cold data
migration with a backup and validation of all resumed engines, not a rename.

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

Codex chats without a selected project get a private directory per thread under
`$OPENCRAFT_WORKSPACE_DIR/sessions/codex`. Brain and Hands see the same shared
workspace mount. DSH uses `sessions/dsh`. Later turns reuse the working directory
persisted by the selected engine; an explicit Project cwd stays authoritative.

## Optional separate model proxy

`compose.proxy.yaml` runs the split Codex account Core (account pool, configured
model providers, credentials and usage) as its own `proxy` owner with a fixed
`OPENCRAFT_PROXY_PORT` (default 45071). Brain then waits for it instead of
starting it, so a Brain release no longer restarts the proxy and a proxy release
does not restart engines:

```sh
docker compose -f compose.yaml -f compose.proxy.yaml up -d --wait
```

Switching an existing deployment is a maintenance step: stop Brain first (it
holds the account writer lock), start `proxy`, then start Brain. The data
directory and schema are unchanged; rollback stops both and starts Brain without
the overlay. The release transaction tool still manages `hands`, `brain` and
`gateway` only; replace `proxy` explicitly.

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
# Set OPENCRAFT_BUILD_REPOSITORY to this host's absolute OpenCraft checkout.
${EDITOR:-vi} /etc/opencraft-github-build.env
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
node --test ../tests/server/container-deployment.test.mjs ../tests/server/container-service.test.mjs
OPENCRAFT_IMAGE=opencraft:local node ../scripts/smoke/server/smoke-container.mjs
```

Acceptance must prove more than HTTP readiness: recreate only Gateway and check
that Brain PIDs and the Hands worker PID are unchanged, that an existing browser
tab retains its live document, and that no input is replayed after reattachment.
