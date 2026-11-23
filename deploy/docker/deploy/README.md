# Portable four-role deployment (Linux amd64)

Requirements: Docker Engine, Compose v2 (2.24+), Python 3; root or an operator with
Docker access and permission to initialize the selected directories. Host networking
and PID visibility preserve the existing split-owner protocols; this is a trusted
single-tenant deployment, not a multi-tenant isolation boundary. Hands retains the
Chromium sandbox capabilities; do not use privileged mode or disable its sandbox.

## Export / deploy

From a clean committed fork, export either a completed CSIGHub four-image upload
snapshot, or the formal `*-role-digests.json` produced by `ci:publish:roles`:

```sh
node scripts/ci/export-deployment.mjs SNAPSHOT.json NEW_BUNDLE_DIRECTORY
```

A downstream product with its own deployment template passes
`--template DIRECTORY` (which must contain every standard file) and repeats
`--include FILE` for each additional top-level file to copy; without these
options the bundle is built from this directory only.

Only immutable `repository@sha256:...` refs are accepted; no checkout, local image ID,
Electron path or build context is needed on the destination. Transfer the bundle,
copy `site.env.example` to `site.env`, and edit the project name, host directories,
ports and numeric UID/GID. UID/GID must match the images; formal builds default to 1000:1000. To change the runtime identity, build
all four images with the selected UID/GID. Container paths are stable; host paths
may live on any disk. All roles explicitly share the execution volume even when
it is outside the state directory. Hands owns browser, execution, terminal **and
files**; no extra host file-service unit, docker-exec supervisor or mounted code.

```sh
# Authenticate to your registry interactively; never commit credentials.
docker login YOUR_REGISTRY
python3 deploy.py config    # inspect resolved config; no mutation
python3 deploy.py init      # create missing directories, never recursively chown old data
python3 deploy.py pull
python3 deploy.py check     # image/UID/mount/file-service checks
python3 deploy.py up        # --no-build, wait for all four healthchecks, functional verification
python3 deploy.py verify
```

Default Gateway binds loopback only, with access control enabled. Put your existing
TLS reverse proxy / corporate authentication integration in front; never expose an
unauthenticated service. The bundle has no account credentials, providers, models,
external channel connection or message history. Configure authentication and any
optional identity provider through the existing core installation interfaces.
Do not clone another live node's identity, credentials or trust state. The runtime
remains responsible for signature, account, grant and admission validation.
Account, model and external channel provisioning is separate. Health and file RPC
checks do not prove an authenticated model turn.
No model requests are made by this drill. Do not copy production state to test hosts.

## Migration, restart, rollback

For an empty-machine drill, use an independent project, directories and ports.
`stop` stops only this project and preserves data. No cleanup/prune/down-volume
operation is provided. A machine reboot requires Docker enabled by the operator;
`unless-stopped` restores the four containers, with no source path dependency.

For moving an existing deployment: drain work and take a **cold consistent backup**
of state, execution and workspace together (including account/SQLite state, artifact
indexes and files); preserve numeric owners, private modes and symlinks. Stable
container paths matter because persisted sessions can contain absolute cwd paths.
Set container paths to the old layout if restoring `/data` sessions; do not assume
changing only a volume source rewrites persisted paths. The portable template's
browser data is `EXECUTION/browser`; an old deployment with browser data directly
at EXECUTION needs an explicitly reviewed migration, not an automatic move.

Keep the old release bundle/digests and matching data backup. Do not downgrade a
migrated database with an old image alone. Verify your recovery in isolation first.
The export records exact role digests but **is not a data backup**. Registry retention
must preserve all release digests. Credentials are configured per machine, outside
Git and outside the bundle. A successful drill does not switch the live service.

For a migration, place `retained-workspaces.json` beside `site.env`, containing the
complete distinct cwd inventory from the retained sessions. Additional resources
such as the shared skills or Git metadata can be listed explicitly:

```json
[{"cwd":"/data","readablePaths":["/data/skills","/data/mono2/.git/index","/data/mono2/.git/refs","/data/mono2/.git/objects"]}]
```

`check`, `up` and `verify` probe this inventory in **each exact role image with its
rendered mounts and UID:GID** before activation. The probe checks cwd read/write/
traversal, ancestor AGENTS/config/rules and the selected readable resources. It
never reads config contents, grants access or changes ownership. Restore the old
absolute mount layout and narrowly scoped runtime-user access before cutover;
health checks alone do not prove old sessions can resume. Do not recursively
open the whole `.codex` directory or expose authentication stores. Fresh deployments
omit this inventory. Keep the inventory with the private deployment configuration;
it contains machine paths and is not part of a release or a credential export.


## Standard root Hands (existing deployments and execution environments)

New bundles use the explicit root/client Hands contract: `OPENCRAFT_HANDS_ROOT=1` in
`site.env`; `deploy.py` merges the supplied `compose.root-hands.yaml`. Existing
explicit nonroot sites are not silently rewritten; `OPENCRAFT_HANDS_ROOT=0`
remains supported with a compatible image.
Gateway/Brain/Proxy and Chromium retain `OPENCRAFT_UID:GID`. Never set the global
UID to zero. Use a verified Hands image whose core entry contains the root/client
bridge (`scripts/container-deployment/root-hands.mjs`), not an older single-UID
image plus a root override. The core Hands entry selects root mode only when it
runs as UID 0 and then requires the `OPENCRAFT_ROOT_HANDS_*` contract this profile
sets; UID 0 without it fails at startup. No host JS injection is required. The
generic core owner remains independent from plugin lifecycles.

Set `OPENCRAFT_HOST_HANDS_ROOT_DIR=/srv/opencraft/hands-ipc` and
`OPENCRAFT_HOST_EXECUTION_DIR=/srv/opencraft/hands-ipc/client`. The root profile
mounts their common parent once for atomic socket hardlinks; server and client
remain private separate subdirectories. Optional `OPENCRAFT_HANDS_SERVER_NAME`
and `OPENCRAFT_HANDS_CLIENT_NAME` select retained child names without moving data.
`OPENCRAFT_HANDS_PUBLIC_CLIENT_DIRECTORY` can retain an older Hands-side client
alias (such as `/var/lib/opencraft/client-execution`) without moving browser profiles. For a retained legacy profile stored directly
in that client root, explicitly set `OPENCRAFT_HANDS_BROWSER_NAME=.`; the default
`browser` layout remains unchanged. No profile data is copied or recursively
re-owned by startup.
When the retained profile itself is a filesystem root (for example, Hands data is
on a separate mounted disk), keep it in place with an explicit existing
`OPENCRAFT_HANDS_BROWSER_DIRECTORY` in the common mount. Put new server/client IPC
directories at sibling paths on that same filesystem. Startup validates profile
ownership and tests both execution and browser hardlinks before starting owners;
it never creates or re-owns the declared retained profile. Separate bind aliases
are not a substitute for one common mount, even on the same disk.
`init` creates only missing private directories with their declared owner: server
and Hands logs root; shared state/workspace/client IPC and other logs nonroot.
Existing directories are not recursively chowned/chmodded. Credentials are separate
0600 files per UID, initialized from the existing matching copy; mismatches fail
instead of rotating credentials. Only sockets are published between 0700 roots.
Browser runs with the nonroot UID; newly created default projectless directories
also retain client ownership. Legacy external cwds are not moved or rewritten.

Root capabilities are explicit and bounded. The read-only image/workspace probe
adds only DAC_OVERRIDE to traverse private image code; it does not grant the probe
SYS_ADMIN, SETUID or CHOWN. Preserve retained `/data`/cwd mounts in the reviewed
migration config, and run its workspace inventory before cutover. Root mode is
not a migration/data backup and does not restore instance plugins automatically.
For the same-instance upgrade preserve its existing Hub identity; do not re-enroll
or start a second Gateway against production identity while rehearsing.

## Configurable standard, not a machine clone

`.40` is the verified deployment instance, not a hardcoded address/path/credential
template. Images contain the runtime contract; `site.env` selects numeric client
identity, root mode, host/container paths, budgets, browser layout and Git hosts.
Private credentials remain in this instance's protected state/vault. Do not put
private keys into images, the bundle, `site.env`, or Git; do not copy another
instance's identity or credential store. Browser/retained workspace identities and
Hands log mounts can be configured explicitly without moving or re-owning data.

New bundles set `OPENCRAFT_PERSONAL_GIT=1`; this selects
`compose.personal-git.yaml` independently of root mode. Set
`OPENCRAFT_HOST_GIT_RUNTIME_DIR`, `OPENCRAFT_GIT_RUNTIME_DIRECTORY` and the explicit
`OPENCRAFT_GIT_HOSTS` allowlist. Gateway, Brain and Hands must use the same private
IPC directory and packaged v2 worker; preflight rejects a partial/mismatched chain.
`init` creates Git IPC with the **nonroot client** identity, even for root Hands.
No keys are stored in this IPC mount: vault provisioning stays in the existing
per-instance account configuration. Git authorization belongs to the admitted
input/turn's actor, not the machine root account or conversation creator.

Enabling the wrapper alone is not a migration: install matching Gateway issuer,
Brain execution runtime, and Hands command bridge together, then verify an admitted
turn. The worker advertises only execution-owned brokers; a Gateway restart must
not revoke a live command. Disabling the profile is explicit legacy deployment
configuration, never permission to fall back to server credentials. Managed Git
operations with missing authority intentionally fail closed.

Optional opaque account ENV delivery (`OPENCRAFT_ENVIRONMENT_DELIVERY=opaque`,
alias `vault-owner`; see the [container README](../README.md#optional-account-env-delivery))
is one decision for the Gateway and Brain: the compose file passes the
`site.env` value to both, and preflight rejects a pair that disagrees, an issuer
setting without delivery, a non-Assets execution context, an issuer file other
than `$OPENCRAFT_DATA_DIR/run/environment-issuer.json`, or Gateway and Brain
state directories that are not the same host directory. Hands and Proxy do not
receive it. `OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION` goes to the Gateway only.
