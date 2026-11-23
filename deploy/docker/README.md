# Docker Compose deployment

This Linux deployment uses one immutable image in four independently restarted
containers:

| Service | Owns | Does not own |
| --- | --- | --- |
| `proxy` | the account Core: ChatGPT account pool, configured model providers, model credentials (`models/credentials.json`, account secrets) and usage | engines, tasks or ingress |
| `gateway` | HTTP/WebSocket admission, authentication, protocol translation and routing | model execution, task lifetime or native browser pages |
| `brain` | Codex AppServer, DSH/Pi execution and task/session lifetime | public ingress, browser tabs, model credentials or Codex native filesystem/shell execution |
| `hands` | remote-browser resources and the pinned Codex `exec-server` | account admission, AppServer state or conversation orchestration |

Recreating `gateway` leaves Brain tasks and Hands tabs alive. The Gateway never
receives a Docker socket and reads no Brain/Hands descriptor or socket from the
shared data directory: it reaches them as workspace endpoints
(`workspace://default/endpoints/<name>`) through the `static-docker` provider.
Each workspace container's agent serves the sandbox process broker on a **link**:
a tmpfs volume mounted only into that container (`/run/opencraft-link`) and the
Gateway (`/run/opencraft-links/brain`, `/run/opencraft-links/hands`), behind a
one-time ticket. Where the default workspace runs is one setting on the Gateway,
`OPENCRAFT_WORKSPACE_ENVIRONMENTS=static-docker://brain static-docker://hands`.
The Gateway keeps its local endpoint sockets in its own private tmpfs
(`/run/opencraft-gateway`) and its placement record (each environment's receipt and
agent incarnation) in `$OPENCRAFT_DATA_DIR/workspaces/default/host/placement.json`;
after a Gateway restart it re-attaches to the same incarnations without restarting
either container, and a changed incarnation is logged as a `workspace-placement`
event. The link only admits the fixed relay to the agent's allow-listed endpoints
(`OPENCRAFT_AGENT_LINK_POLICY=relay-only`, the default).

Brain and Hands each run one **workspace agent** as their main process
(`workspace-agent.mjs --role brain`; Hands uses the same agent with the `hands`
and `browser` roles). It starts and supervises that container's owners, reports
a fresh incarnation on every start, and keeps its control socket, named
endpoints, engine launch configuration and the native Codex listener in a
container-private tmpfs at `/run/opencraft-agent` that no other service mounts.
If any critical child (AppServer/native Codex, Pi, DSH, exec, terminal, files,
browser) exits, the agent stops the others and exits; Docker restarts the
container as a new incarnation and the Gateway's interrupted-turn recovery
continues tracked turns. The agent never restarts a single child in place.
`docker compose exec brain opencraft-health agent` prints its state, roles,
components and incarnation. All four services use the same reviewed image, so Docker stores
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
`OPENCRAFT_DSH_EXECUTABLE` to its `lib/bin.js`. Model settings do not depend on
DSH: adding providers, choosing models and saving keys work without it, because
Pi and Codex configured providers read the same `models/models.json`. Native
Linux amd64 and arm64 build hosts are supported.
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

Open `http://127.0.0.1:10000`. A first conversation starts on the built-in
Codex (Host `local-codex`); the other server Host (`opencraft-server`) runs Pi by
default (`--default-engine pi`) and DSH when installed, and stays selectable in
the composer. A route or a previously selected Host takes precedence. The default
listener is loopback-only. An
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
| Workspace agent run directory (Brain, Hands) | `/run/opencraft-agent` | None: a private tmpfs per container, fresh on each start |
| static-docker link (Brain, Hands; also mounted into Gateway) | `/run/opencraft-link` (Gateway: `/run/opencraft-links/<service>`) | None: Compose tmpfs volumes `<project>_brain-link`, `<project>_hands-link` |
| Gateway endpoint sockets and credential copies | `/run/opencraft-gateway` | None: a private tmpfs in the Gateway container |
| Default workspace placement record | `/var/lib/opencraft/workspaces/default/host` | `/srv/opencraft/state/workspaces/default/host` |

Brain now has a declared budget like Hands (`OPENCRAFT_BRAIN_CPUS`, default `4.0`;
`OPENCRAFT_BRAIN_MEMORY_BYTES`, default 8 GiB): the Gateway requests exactly the
declared budgets and refuses an environment whose enforced cgroup limits differ.
Raise both values in `.env` (they are read by `brain` and `gateway`) if Brain needs
more memory.

Keep an OpenCraft source checkout at `/workspace/projects/opencraft` when the
agent needs to maintain it. A checkout under `/tmp` is temporary, not a deployment
source authority. The runtime image remains at `/opt/opencraft`; do not copy a
checkout or dependencies into the installed runtime. Do not create a `.opencraft`
symlink inside the workspace to select state: use the explicit mount paths.
The Gateway creates execution-bound CLI launchers in the shared execution mount,
so the paths returned to Hands exist there. Signing keys and account state remain
in private application state; they are not exposed with the CLI directory.

The Hands workspace agent also supervises the unified Workbench terminal owner. Gateway routes
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

### Optional per-owner privilege drop

By default every Hands owner (`browser`, `execution`, `terminal`, `files`) runs
with the Hands container identity, and nothing below changes that. A Hands entry
whose workspace agent must run as UID 0 (selected at image build time with
`OPENCRAFT_CONTAINER_HANDS_ENTRY`) can keep selected owners unprivileged by
passing a declarative policy to the core startup:

```js
import { startContainerHands } from "./hands-application.mjs";

await startContainerHands({
  ownerPrivileges: { browser: { uid: 1000, gid: 1000, home: "/var/lib/opencraft/browser-home" } },
});
```

Keys are owner roles from `HANDS_OWNER_PROCESSES`; each entry accepts only
numeric `uid` and `gid` and an optional `home`. The policy is validated once,
before any service or owner starts, and any problem stops startup instead of
leaving the owner as root:

- unknown roles or settings, UID/GID 0 and non-integer identities are rejected;
- the workspace agent must itself run as UID 0;
- `home` must be a normalized absolute path. The browser's state directory stays
  `OPENCRAFT_BROWSER_DATA_DIR` (also the default `home`), so the health check and
  Gateway socket path are unchanged; other roles must name `home` explicitly;
- each directory must already exist as a real directory owned by the dropped
  UID:GID with no group/other access, and every ancestor must be a non-link
  directory owned by root or that UID and not writable by others (root-owned
  sticky directories such as `/tmp` are allowed). Startup never creates, chmods or
  re-owns these directories; provision them before switching modes.

A dropped owner is spawned by the workspace agent with that UID and GID
(supplementary groups are cleared), `HOME` set to its home, and the agent's `XDG_*`
user directories removed; it stays a critical agent child like any other owner.
A custom `spawnOwner` hook receives these options already applied and must pass
them through. The dropped owner still needs read/execute access to the
runtime directory (its working directory) and to `OPENCRAFT_WORKSPACE_DIR`; if
spawning fails, the agent stops.

The privilege drop does not change who can connect to owner sockets. A dropped
browser creates `owner.sock` in its own directory; the agent publishes it as the
`browser` endpoint, and the Gateway's relay must be able to connect to it.
Owners left as root create root-owned sockets; giving non-root clients access to
them is a deployment decision outside this option.

## Optional account ENV delivery

With `OPENCRAFT_ENVIRONMENT_DELIVERY=vault-owner` (Assets context only), DSH,
Pi and Codex receive account ENV as opaque capsules from the Gateway's vault owner instead
of running without it. Set it for Brain and Gateway alike (Compose passes it to
both). The vault owner keeps its issuer key sealed in the vault,
so the key survives Gateway restarts and updates, and publishes the public key
to `$OPENCRAFT_DATA_DIR/run/environment-issuer.json` (owner-only file, rewritten
only when the key changes). Brain's workspace agent starts before the Gateway, so
it pins that stable key into the DSH and Pi host configurations and into
`codex-app-server-environment.json`, which it passes to the split Codex AppServer
as `--environment-launch-config` (with the attachment `server:<machine-id>:codex`,
the `runtime/execution-admission-worker.mjs` shipped in the image and the data
directory). All three launch files live in the agent's container-private run
directory (`OPENCRAFT_AGENT_RUN_DIR`, a tmpfs), never in the shared `run/`. The
agent then watches the publication:

- No published key yet (first enablement): Brain pins a key nobody can issue
  for, so personal ENV deliveries fail closed. When the Gateway publishes its
  key, the agent retires Pi, DSH and the Codex AppServer (with its native process
  group), rewrites their configurations and starts the AppServer, DSH and Pi
  again as ordinary critical children. Running DSH, Pi and Codex turns end with
  that relaunch. A successor that does not become ready ends the agent (a new
  Brain incarnation), like any other critical child failure. The Gateway
  picks up the new DSH and Pi descriptors at its next health observation.
- Rotation is explicit: change `OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION` and
  recreate the Gateway. It seals a new key and publishes it; Brain relaunches DSH,
  Pi and the Codex AppServer. Until then they hold the previous key and
  deliveries fail closed. A Gateway restart or update keeps the key and
  relaunches nothing. AppServer replacements (this one and a Hands rebinding)
  run one at a time.
- A publication that is not an owner-only regular file with exactly one valid
  key is ignored; the key never comes from a Gateway reply, a Host descriptor
  or a request.

Without the variable nothing changes: no issuer, no publication, the host
configurations are written exactly as before and the AppServer starts without
`--environment-launch-config`.

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

### Personal execution ENV for Codex

The `proxy` service runs `--accounts-only`: it owns accounts and models but no
Codex runtime, so it is not the receiver that opens Codex ENV launch capsules.
Codex Threads run on Brain's own AppServer, and that AppServer is the receiver:

- With `OPENCRAFT_ENVIRONMENT_DELIVERY=vault-owner` (see
  [Optional account ENV delivery](#optional-account-env-delivery)) Brain starts it
  with `--environment-launch-config`. Its health, which the Gateway reads through
  the `codex-control` workspace endpoint, then reports the receiver; human Codex
  Thread creations and Turns get their personal ENV. The receiver's admission
  Worker reads the Gateway's durable admission (the Codex input lease and the
  creation reservation the Gateway's Server owner wrote) read-only from the
  shared data directory, the same Worker DSH and Pi use; the AppServer's event
  loop never opens those databases and Brain never writes them.
- A product composition that brings its own vault owner
  (`identity.environmentLaunch`) without `OPENCRAFT_ENVIRONMENT_DELIVERY`
  publishes no issuer Brain could pin, so Brain starts the AppServer without a
  receiver. The Gateway keeps Headless's startup rule (Codex ENV and personal
  Git must both be wired) and every human Codex Thread creation or Turn is
  refused with `environment-delivery-refused`; a human Codex Turn never runs
  without its personal ENV. DSH, Pi and terminal delivery are unaffected.
- Without a vault owner, Codex behaves as before.

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
tool. It checks paths, ownership, capacity, disk and rendered Compose config,
and that the deployment UID can write `deploy/docker/` (for `.env`) and
`$OPENCRAFT_HOST_DATA_DIR/deployment/` (for `compose-state.json`), so a release
never fails after replacing every owner; that the rendered `brain` and `hands`
services keep `/run/opencraft-agent` on a private tmpfs (Compose files older than
the workspace agent lack it; update `deploy/docker/` first) and that each has its
static-docker link volume shared with the Gateway only;
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
If the failed release was the first switch from a Brain that embedded the account
Core, the tool restores that topology rather than only the image: it stops Brain,
removes the `proxy` container, starts the previous image's Brain with the
embedded Core on a free loopback port (`OPENCRAFT_BRAIN_PROXY_MODE=embedded` and an
empty `OPENCRAFT_BRAIN_PROXY_PORT`, set only for that restore), then recreates
Gateway. Data stays in place. Fix the cause and run `upgrade` again; it performs
the switch. Until then do not run a plain `docker compose up`, which would start
`proxy` beside the embedded Core. The two `OPENCRAFT_BRAIN_PROXY_*` variables are
not deployment settings; `doctor` refuses them in `.env`.
Rolling back from a workspace-agent image to an older one needs no extra step:
the older image ignores the tmpfs and `OPENCRAFT_AGENT_RUN_DIR` and writes its
launch configuration, engine descriptors and AppServer sockets to
`$OPENCRAFT_DATA_DIR/run` again, which the newer Brain removes on its next start.
During an upgrade the old Gateway loses Brain between the `brain` and `gateway`
steps (the new Brain no longer publishes those descriptors); the transaction replaces
the Gateway next. The link volumes hold no data; `docker compose down --volumes`
removes them.
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
node --import tsx --test ../tests/server/container-deployment.test.mjs ../tests/server/container-service.test.mjs ../tests/server/workspace-agent.test.mjs ../tests/server/gateway-workspace.test.mjs
OPENCRAFT_IMAGE=opencraft:local node ../scripts/smoke/server/smoke-container.mjs
```

Acceptance must prove more than HTTP readiness: recreate only Gateway and check
that Brain PIDs and the Hands worker PID are unchanged, that an existing browser
tab retains its live document, and that no input is replayed after reattachment.

## Release images

Every App release publishes the server image it built and smoke-tested from the
release commit to `ghcr.io/opencraft-app/opencraft-server`, Linux amd64:

- `ghcr.io/opencraft-app/opencraft-server:<version>` (for example `0.2.0` or
  `0.2.0-beta.1`). A published version is never moved to a different image.
- `ghcr.io/opencraft-app/opencraft-server:latest`: the most recent stable release.

The release notes name the pinned `ghcr.io/opencraft-app/opencraft-server@sha256:…`
reference; deploy that digest. This package only receives release images.

## GHCR distribution (edge builds)

The container workflow builds and smoke-tests Linux amd64 (arm64 is added once an
owned linux-arm64 browser artifact exists). PRs only validate; the canonical
repository's main branch can publish to the private
`ghcr.io/opencraft-app/opencraft` package.
Distribution transfers the tested image as a short-lived Actions artifact; it
never rebuilds the image after testing. Each architecture is uploaded under a
run-scoped candidate tag, pulled with an empty Docker credential configuration,
and smoke-tested again by registry digest. Only after every built architecture
succeeds does a serialized job assemble the multi-platform index and publish:

- `ghcr.io/opencraft-app/opencraft:sha-<full-source-commit>`: first successful
  image for that source; a later build with different bytes is rejected.
- `ghcr.io/opencraft-app/opencraft:edge`: a passing main build, updated only if
  the source is still the current main tip. This is not a stable release.
- No `latest` or version tags are published here; see Release images.

The Actions summary records the pinned `ghcr.io/opencraft-app/opencraft@sha256:…`
reference. For deployment, use that full digest, not `edge`. Obtain this Compose
file from the source commit recorded in the summary. Follow the directory and
UID/GID setup in First installation, replace `OPENCRAFT_IMAGE` in `.env` with the
pinned reference, select `linux/amd64`, then run:

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
