# Docker Compose deployment

This Linux deployment uses one immutable image in four independently restarted
containers:

| Service | Owns | Does not own |
| --- | --- | --- |
| `proxy` | the account Core: ChatGPT account pool, configured model providers, model credentials (`models/credentials.json`, account secrets) and usage | engines, tasks or ingress |
| `gateway` | HTTP/WebSocket admission, authentication, protocol translation and routing | model execution, task lifetime or native browser pages |
| `brain` | Codex AppServer, DSH/Pi execution and task/session lifetime | public ingress, browser tabs, model credentials or Codex native filesystem/shell execution |
| `hands` | remote-browser resources and the pinned Codex `exec-server` | account admission, AppServer state or conversation orchestration |

Recreating `gateway` leaves Brain tasks and Hands tabs alive. The Gateway
reattaches to both through private descriptors/sockets and never receives a
Docker socket. All four services use the same reviewed image, so Docker stores
the large runtime layers once.

Brain keeps Codex AppServer and its writable native session state. Its managed
environment forwards only the pinned `codex exec-server --listen stdio` process
to Hands over a private mode-0600 Unix socket. Each environment has a connection
lease; owner loss terminates the process group and never replays input. This is
not a general remote shell: other executables and argument vectors are rejected.

## First installation

The default image follows upstream and packages the pinned stock Electron runtime.
Node and Codex are pinned by this checkout and lockfile; no account or model
credential is included. The image does not ship DeepSeek Harness (DSH): Brain
starts without it, and a DSH installed in the image can be bridged by setting
`OPENCRAFT_DSH_EXECUTABLE` to its `lib/bin.js`. Native Linux amd64 and arm64 build hosts are supported.
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
docker buildx build --load -f deploy/docker/Dockerfile \
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

## Deploy prebuilt role images

Use the base Compose file supplied with your runtime release. If your distributor
provides separate Gateway, Brain and Hands images, add their three full references
to the deployment `.env` alongside the storage and user settings above. Set
`OPENCRAFT_GATEWAY_IMAGE`, `OPENCRAFT_BRAIN_IMAGE` and `OPENCRAFT_HANDS_IMAGE` to
compatible images from the same release. Digest references pin the exact bytes.
From the `deploy/docker/` directory run:

```sh
docker compose -f compose.yaml -f compose.role-images.yaml config --images
docker compose -f compose.yaml -f compose.role-images.yaml pull
docker compose -f compose.yaml -f compose.role-images.yaml up -d --no-build --wait
```

The overlay selects prebuilt images and inherits service commands, health checks
and mounts from the base file. To roll back this configuration, restore the
previous three image references and repeat the commands. The single-image
transaction command below manages deployments using `OPENCRAFT_IMAGE`.

To preserve absolute project paths, set both `OPENCRAFT_HOST_WORKSPACE_DIR` and
`OPENCRAFT_WORKSPACE_DIR` to the project parent (for example `/srv/projects`).
All three containers then see the same project paths. Writes in that workspace
reach the host under the configured deployment UID and GID. Hands uses its own
container root filesystem and bind-mounted execution state. Keep private
application state outside the shared project tree.

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
part of the Hands health check. See [terminal semantics](../../docs/architecture/platform/presentation-and-input.md#conversation-terminal-semantics).

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

`adopt-legacy` makes a private `deploy/docker/.env.before-layout` backup and explicitly
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

## Model proxy

The `proxy` service is the split Codex account Core with its own lifecycle and a
fixed loopback `OPENCRAFT_PROXY_PORT` (default 45071). Brain runs with
`OPENCRAFT_PROXY_MODE=external`: it waits for `proxy`, never starts or stops it,
and reaches every model through it. A Brain release does not restart the proxy;
a proxy release does not restart engines (they reconnect to the fixed port with
their stable caller token from `$OPENCRAFT_DATA_DIR/run/proxy-callers/`).

In this mode the Brain engines never open `models/credentials.json` or account
secrets. Codex reaches the Core through `chatgpt_base_url`; Pi and DSH receive
only their proxy caller token. Saving an API key in model settings goes from the
Brain to the proxy, which stores it and answers only "configured / not
configured". Image generation, speech transcription, IM channels and the
personal assistant run in the Gateway, which remains the owner of those keys.

| Provider configuration | In this deployment |
| --- | --- |
| Anthropic Messages, OpenAI Responses or OpenAI-compatible Chat Completions with an explicit HTTPS (or loopback) endpoint, including native DeepSeek | through the proxy |
| No-auth OpenAI-compatible endpoint; human contribution/subscription; speech | no engine credential (direct without a key, or owned by the Core/Gateway) |
| Catalog provider without an endpoint, Google Generative AI and other protocols, plain-HTTP LAN endpoints | refused when saved; an existing one stays saved but is not executable until it is edited to a supported connection |

### Switching an existing installation

Installations created before this release run the account Core inside Brain.
Data directory, databases and schema are unchanged by the switch; only the owner
process moves. The account writer lock means Brain must stop before `proxy`
starts. The transaction tool does this automatically when it finds a Brain
without `OPENCRAFT_PROXY_MODE=external`. By hand, from `deploy/docker/`:

```sh
node ../scripts/container-deployment/layout.mjs prepare   # creates logs/proxy (idempotent)
docker compose stop brain
docker compose up -d --no-deps --wait proxy
docker compose up -d --no-deps --wait brain
docker compose up -d --no-deps --wait gateway
```

`compose.proxy.yaml` is now an empty overlay kept only so existing
`-f compose.proxy.yaml` commands still work; remove it from your commands.

Rollback to the embedded Core uses the previous release's Compose files and image:
`docker compose stop gateway brain proxy`, check out the previous `deploy/docker/`
files, then start `hands`, `brain` and `gateway` with the previous image. Keys
saved while the proxy owned them are in the same `models/credentials.json`.

### Manual acceptance (operator)

Run on a staging host with a fake model endpoint (no paid inference, no real
keys). Replace `$DATA` with the host data directory.

1. Configure one OpenAI-compatible (Chat Completions) and one Anthropic Messages
   provider whose HTTPS or loopback endpoint is your fake server, with a dummy key,
   and select a Codex configured model on an OpenAI Responses provider the same way.
2. Prove Brain cannot read the credentials:
   `docker compose exec brain sh -c 'cat "$OPENCRAFT_DATA_DIR/models/credentials.json"'`
   must fail once you make the file unreadable for Brain, e.g. by bind-mounting an
   empty unreadable file over it for the `brain` service only (a Compose override
   with a read-only `type: bind` of a mode-0000 root-owned file at that path).
   `proxy` and `gateway` keep the real file.
3. Start a Pi thread, a DSH thread and a Codex thread on those models. Each must
   answer; the fake server must see the dummy key, and `proxy` logs must show
   `proxy-provider-forward` events with `caller:pi` / `caller:dsh` (Codex appears
   as configured Responses traffic).
4. Save a new API key in model settings: `proxy` logs `proxy-model-credential-set`,
   and Brain logs show no credential file access errors.
5. Try to add a Google Generative AI provider: saving is refused with the
   explanation that the protocol cannot be forwarded through the model proxy.
6. Note Brain's `docker inspect -f '{{.State.StartedAt}}' <brain>`; run
   `docker compose restart proxy`; while it restarts, model calls fail and then
   recover without action; Brain's `StartedAt` is unchanged and its threads keep
   answering after the proxy is healthy.

## Upgrade and rollback

Build a content-addressed or versioned image reference, then use the transaction
tool. It checks paths, ownership, capacity, disk and rendered Compose config;
uses a deployment lock; applies and waits for each owner in strict dependency
order (`hands`, `proxy`, `brain`, `gateway`); and writes `.env` only after all four are
healthy. A Brain that still embeds the account Core is stopped before `proxy`
starts (see [Switching an existing installation](#switching-an-existing-installation)):

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

`rollback` keeps the current Compose files, so the previous image must already
contain the `proxy` service entry. To return to a release older than that, follow
the embedded-Core rollback in [Model proxy](#switching-an-existing-installation).

Mutable `latest`, untagged and local development images are refused unless the
operator explicitly passes `--allow-mutable-image`. Keep the previous digest in
the registry. A code rollback does not undo a database migration and must never
be represented as data rollback; take a cold data backup before a migration.
An unchanged owner is not recreated. A reviewed Gateway-only change may still
use `docker compose up -d --no-deps --wait gateway` when its image digest is
already persisted in `.env`.

Before intentionally replacing Brain, let active tasks finish. Before replacing
Hands, close or checkpoint important live tabs; a compatible Gateway-only change
does not replace them. `docker compose down` stops all four owners and retains
the bind-mounted state. For a cold backup, stop all four and copy the complete
data and workspace directories with ownership and modes preserved.

### Supervised runtime environment smoke

After an authorized upgrade, an operator may separately inspect the existing
supervised runtime and service counters without changing them:

```sh
npm run smoke:upgrade:environment -- /private/environment.json /private/new-report.json
```

The private input names an already configured `sshAlias`, loopback `port`,
absolute `coreProgram`, systemd `units`, journal `since`, optional Docker
`containers`, and optional `expectedIdentity` fields (`buildId`, `coreSha256`,
`webSourceRevision`, `webBuildId`, `version`). The selected health endpoint must
expose the supervised `core.pid`; this is not a fallback for unrelated health
schemas. The target requires Python 3.11+, systemd and Docker when container
checks are requested. Do not put SSH keys or passwords in the input.

The probe checks actual process identity before hashing its executable, records
bounded service counters rather than full command lines/journal contents, and
writes a new owner-only report without overwriting an earlier one. All three
probe categories must return valid results; missing or malformed results cannot
pass acceptance. Service restart/error counters are observations, not a promise
that their values are zero. This read-only probe neither deploys nor restarts
services and cannot by itself verify model execution or full task continuity.

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
  deploy/container-build/opencraft-github-build.env.example \
  /etc/opencraft-github-build.env
# Set OPENCRAFT_BUILD_REPOSITORY to this host's absolute OpenCraft checkout.
${EDITOR:-vi} /etc/opencraft-github-build.env
install -D -o root -g root -m 0644 \
  deploy/container-build/opencraft-github-build.service \
  /etc/systemd/system/opencraft-github-build.service
install -D -o root -g root -m 0644 \
  deploy/container-build/opencraft-github-build.timer \
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

## GHCR distribution (edge builds)

The container workflow builds and smoke-tests Linux amd64 and arm64 on native
runners. PRs only validate; the canonical repository's main branch can publish.
Distribution transfers the tested image as a short-lived Actions artifact; it
never rebuilds the image after testing. Each architecture is uploaded under a
run-scoped candidate tag, pulled with an empty Docker credential configuration,
and smoke-tested again by registry digest. Only after both succeed does a
serialized job assemble a two-platform index and publish:

- `ghcr.io/opencraft-app/opencraft:sha-<full-source-commit>`: first successful
  image for that source; a later build with different bytes is rejected.
- `ghcr.io/opencraft-app/opencraft:edge`: a passing main build, updated only if
  the source is still the current main tip. This is not a stable release.
- No `latest` or semantic-version tags are published by this workflow.

The Actions summary records the pinned `ghcr.io/opencraft-app/opencraft@sha256:…`
reference. For deployment, use that full digest, not `edge`. Obtain this Compose
file from the source commit recorded in the summary. Follow the directory and
UID/GID setup in First installation, replace `OPENCRAFT_IMAGE` in `.env` with the
pinned reference, select `linux/amd64` or `linux/arm64`, then run:

```sh
node ../scripts/container-deployment/compose-release.mjs doctor
docker compose pull
docker compose up -d --no-build --wait
docker compose ps
```

Publication never updates a running deployment. Keep the previous image digest,
matching Compose file and data backups. Existing installations should use the
transactional deployment/rollback commands documented above; image rollback
alone cannot undo a data migration.

### First publication and recovery

An organization administrator must permit Actions to create packages. The
workflow uses its short-lived `GITHUB_TOKEN`, with `packages: write` only in
main-only distribution/promotion jobs; no personal registry token is required.
The Dockerfile's source label associates the package with this repository.
After the first candidate upload, check the package settings and explicitly
make the package public if needed. A public repository does not guarantee a
public package. Anonymous pull failures intentionally block promotion.

After correcting permissions or visibility, rerun **all jobs** of the same run
(artifacts expire after one day). Run-scoped tags include the run attempt;
rerunning only failed jobs cannot safely reuse candidates from another attempt.
If a SHA was already published and a rebuild produces different bytes, use a
new source commit rather than overwrite the SHA tag. Successful partial
candidates may remain in GHCR; they are not approved deployment references.
Do not delete digests referenced by deployed SHA tags when cleaning candidates.

The first real Actions run and anonymous pull must pass before claiming GHCR
is available. The workflow does not change organization visibility policy,
create GitHub Releases, publish npm packages, or deploy servers.
