# Hands image and self-hosted E2B templates

Hands owns the execution environment contents. Docker and a self-hosted E2B
cluster consume the same released image by registry digest. Keep Agent binaries,
Python, browser artifacts and system dependencies in the existing Hands image
build; do not duplicate their installation in E2B shell commands.

An operator image build may run `deploy/docker/install-sandbox-deps.sh`. It installs
the Debian packages required by the self-hosted E2B guest bootstrap. This keeps
template provisioning from downloading a second set of OS dependencies over
the guest network. The script skips installed packages, prevents package scripts
from starting daemons during image construction, and removes generated SSH host
keys from the common image. Installing the packages does not start an SSH service
in Docker Hands.

Runner startup consumes preinstalled runtimes. The remote execution binding
launches `/opt/opencraft/runtime/codex/bin/codex exec-server --listen stdio`;
the browser owner and worker come from `/opt/opencraft/runtime/browser`.
The runner does not download Codex, read shared runtime archives, extract tools
into `/tmp`, or repair a missing runtime. The Hands image, desktop package and
E2B template builds own runtime delivery and updates. Per-instance browser
profiles and sockets remain temporary session data.

Installed Assets browser policy declares only its isolation mode, for example
`"browser": { "isolation": "isolated-vm-compatibility" }`. Remove legacy archive
`manifest` settings when selecting a preconfigured template; these settings are
rejected rather than interpreted as a runtime installation request.

Existing templates without the Hands runtime layout must be replaced by a
preconfigured candidate before enabling this runner version. Template selection
and resource budgets remain owned by the installed environment catalogue.
Browser policy is supplied by the deployment adapter; shipping the browser
payload alone does not enable remote browser control.

```text
Existing Hands Dockerfile / product image build
                     |
             immutable registry image
               /                 \
         Docker Hands       E2B fromImage
                                  |
                     guest user/workspace preparation
                       and image-content verification
                                  |
                           template / sandbox
```

The template builder uses the existing `e2b@2.64.0` dependency from
`@opencraft/sandbox-e2b`. That SDK requires `POST /v3/templates` followed by
`POST /v2/templates/{templateID}/builds/{buildID}` and the build-status API.
A working sandbox runtime API alone does not establish template-builder support.

## Build a candidate

Run from a checkout with the locked workspace dependencies installed. Use a
release/export JSON containing `images.hands` as either an immutable registry
reference or an object with `ref` and optional `platform`. This is the same
format consumed by the existing deployment export. Do not use a Docker image
config ID as a registry manifest digest.

If the builder cannot reach the original registry, the Hands descriptor may also
supply `mirrorRef`. Copy the OCI image without rebuilding or changing its manifest:

```json
{
  "images": {
    "hands": {
      "ref": "source.example.com/team/hands@sha256:<manifest-digest>",
      "mirrorRef": "cluster-registry.example.com/team/hands@sha256:<same-manifest-digest>"
    }
  }
}
```

The build uses the mirror location and records `sourceImage` alongside it. A
changed manifest digest is rejected. Configure credentials for the selected
registry; do not send the source registry's credentials to an anonymous mirror.

```sh
npm run e2b:hands -- plan /private/release.json /private/new-hands-template hands-<version> 4 8192
npm run e2b:hands -- build /private/new-hands-template /private/e2b-build.json
npm run e2b:hands -- status /private/new-hands-template /private/e2b-build.json
# When status is ready:
npm run e2b:hands -- verify /private/new-hands-template /private/e2b-build.json
```

The output directory must be new and the template name must not already exist.
`build` submits once and returns acknowledged IDs; `status` observes that exact
build and can be repeated while it is building. No command installs or changes
the live assistant catalogue, replaces an existing template, restarts a service,
or automatically selects a new execution environment.

The operator-owned build connection file is separate from the runtime catalogue:

```json
{
  "schemaVersion": 1,
  "backend": "e2b",
  "apiUrl": "https://sandbox-api.example.com",
  "sandboxUrl": "https://sandbox-proxy.example.com",
  "apiKeyFile": "/private/e2b-team-key",
  "registryCredentialsFile": "/private/registry-credentials.json"
}
```

`registryCredentialsFile` is optional for public images. Its JSON contains
`username` and `password` for the image registry. All connection/credential files
must be absolute regular files, owned by the process user, without group/other
permissions (0600). Provision secrets through the existing operator secret
mechanism. They are not CLI arguments, template environment variables, build
commands or receipt fields. Use the configured private cluster endpoints;
there is no fallback to E2B's public cloud.

An existing private installation connection file can be read explicitly, but it
must not overwrite the current platform catalogue. Where that catalogue has
already moved into the platform vault, the old installation file is rollback
material, not its configuration authority.

## What the template runs

`fromImage` uses the full Hands payload. The only extra build steps write an
image-identity marker, prepare the E2B `user` workspace at `/workspace`, set PATH,
and run the same content probe used for verification. Python 3 with CA trust,
Git, bundled Node/Codex/browser executables and Hands owner files must already
exist in the image; a missing tool fails the build instead of installing a
second environment.

This template serves the existing E2B command/PTY transport. It does not start
Compose's Hands Unix-socket services: those require Brain mounts, tokens and
resource declarations belonging to a particular deployment. Shipping the same
binaries does not establish remote Brain-to-Hands connectivity or browser
control. Such runtime changes must use the existing execution owners and
sandbox contract, with separate end-to-end verification.

## Evidence and uncertain outcomes

`plan.json` records the image, resource request, workspace and template name.
`receipt.json` binds that plan's hash to the template/build IDs. A release's
source revision may describe another service, so it is labelled
`releaseSourceRevision`; verification separately observes `handsSourceRevision`
from the actual image payload. Do not relabel an old image with the current
checkout SHA.

A lost submission acknowledgement produces `submission-unknown`; it cannot be
resubmitted from that directory. Inspect the unique name in the cluster before
preparing another build. Vendor error bodies and raw logs are not persisted. Build, status and verify
operations take a task-directory lock so a concurrent observer cannot erase a
VM identity. A process crash leaves `.operation-lock` for operator inspection;
remove it only after confirming the old operation has stopped and reconciling
its recorded intent with provider state.

`verify` allocates one bounded temporary VM, checks effective CPU/memory and the
image identity/tools, then deletes that exact VM and requires the info API to
confirm absence. Acceptance requires both `verification.phase=passed` and
`verification.cleanup=confirmed`. An ambiguous create or cleanup remains in the
receipt and is not automatically replayed. Compute expires after two minutes;
provider-managed persistent workspace/volume cleanup remains an explicit
provider responsibility, not a promise made by deleting compute.

Tests: `npm run test:e2b:hands`. The suite includes the real pinned SDK against a
local HTTP builder fixture as well as failure/cleanup tests. This is distinct
from validation against a real self-hosted builder.

## Optional operator-assisted cold publication

A self-hosted provider may require filesystem-only cold boot instead of memory
resume. `scripts/e2b/hands-cold-template.mjs` runs the same image preparation
commands, flushes disk with `sync` before capture, and requires confirmed build-VM
deletion. This is an explicit operator path, not an automatic runtime fallback.

Supply a private seed receipt with `schemaVersion: 1`, `phase: "ready"`, the exact
planned `image`, `cpuCount`, `memoryMB`, `filesystemOnly: true`, `seedTemplateId`,
`sourceArtifactId`, and SHA-256 hashes in `rootfsSha256`, `headerSha256`,
`metadataSha256`. To adopt an already allocated build VM, supply `buildSandboxId`
and `buildSandboxPurpose: "hands-cold-template-build"`; its purpose metadata and
effective resource budget are checked before preparation.

```sh
node scripts/e2b/hands-cold-template.mjs /private/plan /private/connection.json /private/seed.json
```

The default path requests a filesystem snapshot. If the operator explicitly
sets `captureMode: "memory"`, the tool captures a full staging snapshot and stays
in `awaiting-cold-publication`. It does not claim that the staging snapshot is an
accepted runtime template. A separate provider-owned procedure must publish that
exact source as filesystem-only; this CLI never writes provider database rows.

```sh
node scripts/e2b/hands-cold-template.mjs publish /private/plan /private/connection.json /private/publication.json
node scripts/e2b/hands-template.mjs verify /private/plan /private/connection.json
```

The publication receipt supplies `schemaVersion`, `phase`, `image`,
`filesystemOnly`, `planSha256`, `sourceSnapshotId`, `templateId`, `buildId`,
and the three artifact hashes. Acceptance binds the plan and source snapshot and
confirms the exact template/build is ready through the configured API.

Some persistent-workspace providers require guest NFS modules for the exact
guest kernel. The optional build-guest helper `scripts/e2b/install-guest-nfs.py`
accepts an operator-pinned archive, per-module hash/size manifest, archive SHA-256
and kernel release. It rejects unsafe archive members before writing, loads
NFS v3/v4 and orders module loading before envd readiness. It must only run in a
disposable build guest, never on the controller host. Provision trusted artifacts
through the operator's existing mechanism, not from user input or host modules.
Record `kernelAdaptation: { kernel, archiveSha256, installed: true }` in the seed
to require matching provenance during fresh-VM verification.

## Validation boundary

The automated suite uses a local HTTP builder with the installed E2B SDK and
synthetic sandbox handles. It covers plan pinning, secret-file permissions,
single submission, resource checks, uncertain outcomes and confirmed cleanup.
It does not establish compatibility with every E2B deployment, launch a real
cloud VM or change any installed catalogue. Validate the selected image and
provider separately before enabling the preinstalled-runtime runner.
