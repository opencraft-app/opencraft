# Native Electron build container

This optional Docker image builds the repository-owned Electron fork for
**native Linux x64**. It provides the build OS and depot_tools, then invokes
the existing fork manager and browser artifact probes. It does not run the
OpenCraft server or deploy a runtime. macOS and Windows require native builders;
this image does not replace those workflows.

Build the toolchain image from a clean, selected OpenCraft commit:

```sh
docker buildx build --platform linux/amd64 --load \
  -f docker/electron-builder.Dockerfile \
  -t opencraft-electron-builder:local .
docker image inspect opencraft-electron-builder:local --format '{{.Id}}'
```

For automated or shared builds, record the selected source SHA and use the
resulting immutable image ID for the run. The Dockerfile-specific ignore file
limits the context to the fork tooling, patches, shared probe focus helper and license. It excludes native
source trees, prior build outputs and Python caches.

The Node/Debian base is fixed by digest. `container-inputs.json` pins
depot_tools and the checksum of Chromium's own dependency installer, matched
to `fork.json`. Missing prerequisites fail during image creation; compilation
does not install packages on the host. OS packages are resolved from Debian's
repositories and their installed versions are recorded in `os-packages.txt`.
These records establish the selected inputs, not a bit-for-bit reproducibility
claim. The pinned Chromium sync provides its own Clang/sysroot tooling.
Compilation puts the selected synced GN and Ninja directories first in `PATH`
for both the initial generation and child build actions. Node's configuration
generator therefore uses the same GN binary, rather than a depot_tools wrapper
that requires a separate Python bootstrap.

## Persistent workspace

Provision a local SSD-backed filesystem with at least 200 GiB **free** before
sync. Start with 300+ GB storage and 32–64 GB RAM and size against actual usage.
Docker's own image/build cache also needs room. Where supported, place BuildKit
state on the build disk separately; mounting the workspace does not move
Docker's data root. Prefer the native CPU architecture over QEMU emulation.

Choose an empty directory on that filesystem and give your build user write
access. No specific device name, mount point, account or UID is required:

```sh
export ELECTRON_WORKSPACE=/absolute/path/on/build-disk/electron
mkdir -p "$ELECTRON_WORKSPACE"
docker run --rm --init --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$ELECTRON_WORKSPACE,target=/workspace" \
  opencraft-electron-builder:local preflight
```

Run the full source/sync/compile/probe pipeline with bounded resources:

```sh
docker run --name opencraft-electron-build --init \
  --user "$(id -u):$(id -g)" --cpus=4 --memory=24g --shm-size=1g \
  --mount "type=bind,source=$ELECTRON_WORKSPACE,target=/workspace" \
  opencraft-electron-builder:local all --jobs 4
```

The workspace must be a separate writable mount. The entry refuses to download
Chromium into the container's writable layer. Downloads, source, compiler output,
cache, temporary files, home, logs and receipts live in the workspace. It uses a
nonblocking lock to reject concurrent writers with exit status 75. Use one
workspace per build user; different users should not share writable caches.
The warmed, pinned depot_tools installation is copied once into
`cache/depot-tools/<revision>/` in each workspace. CIPD client updates and
vpython bootstrapping can then write beside their tools as an ordinary build
user; the image installation remains immutable. Subsequent runs reuse that
copy and verify its Git revision before use. Allow roughly 2 GiB for this copy
in addition to source and compiler output.
The storage downloader's installation uses `DEPOT_TOOLS_GSUTIL_BIN_DIR` under
the workspace cache, so it does not write into the image's depot_tools tree.
Image creation and preflight load the shared native-focus helper required by
the causality and IME probes, catching a missing probe dependency before sync.
Preflight checks gclient, CIPD and gsutil before the large source download;
first use requires access to their public download endpoints.
The image defaults to UID/GID 1000, and supports a numeric `--user` override.
No privileged container, host Docker socket or block device is required.

Follow `docker logs -f opencraft-electron-build`; logs and JSON phase receipts
also remain under `logs/` after the container exits. A detached container or
external CI supervisor can own long builds. Compilation time and disk use vary;
starting a job does not prove that it produced a usable native runtime.

Individual actions use the same workspace:

```sh
# After a failed network sync, inspect its logs and continue the same source.
docker run --rm --init --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$ELECTRON_WORKSPACE,target=/workspace" \
  opencraft-electron-builder:local sync
```

Supported actions are `preflight`, `checkout`, `verify`, `sync`, `build`,
`browser-artifact`, `all` and `resume`. A changed fork definition selects a different
source root, preserving prior builds. Existing source verification rejects
dirty or mismatched trees; do not delete operation locks until the recorded
owner is confirmed dead.

### Change compilation concurrency

Container CPU and memory limits can be updated, but an existing Ninja process
keeps the `--jobs` value it started with. To change parallelism, interrupt Ninja
with SIGINT inside the build container, then wait for the container to exit.
Allow the fork manager to finish and release its operation lock; do not run
two writers against the workspace or remove a live process's lock.

Once the previous container has exited, start a new container with the same
image and workspace, adjusted resource limits, and `resume --jobs N`:

```sh
docker run --name opencraft-electron-resumed --init \
  --user "$(id -u):$(id -g)" --cpus=6 --memory=24g --shm-size=1g \
  --mount "type=bind,source=$ELECTRON_WORKSPACE,target=/workspace" \
  opencraft-electron-builder:local resume --jobs 6
```

`resume` requires a previously synchronized source tree. It verifies the fork,
runs the incremental build, then prepares and probes the browser artifact.
It preserves existing Ninja outputs and does not repeat checkout or dependency
sync. Failed compilation stops before artifact preparation. Select CPU, memory
and job limits against actual host capacity, leaving resources for other services.

Sync follows the individual revisions selected by DEPS and uses shallow
history. It does not request every remote tag or branch head. Existing caches
from a broader checkout may still contain those refs; the builder preserves
them rather than deleting user-owned cache data. Git's default protocol is
retained. Site-specific network settings should be supplied to the container
explicitly instead of changing the public build definition.

## Browser output and consumption

`source/<fork-sha256>/src/out/OpenCraft/dist.zip` is the native build archive.
`browser-artifact` extracts it through the existing validated archive extractor
into a fresh directory and runs the browser-specific native probes. Only a
successful run produces `artifacts/<fork-sha256>/<run-id>/browser/` with
`opencraft-electron-artifact.json`, alongside probe evidence, build metadata
and OS package versions. Failed runs keep diagnostic evidence and never gain
a success receipt. Desktop inventories and remote browser inventories remain
separate; a desktop marker does not certify remote browser input.

Browser probes use explicit headless test-process sandbox flags; these do not
change the sandbox policy of the deployed application. Probe success still
needs actual Web/phone composition-input acceptance after integration.

To package a verified browser runtime on a native Linux x64 host, select that
directory using `OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION`; the existing packager
rechecks provenance and every inventoried file. Paths recorded inside the build
container start at `/workspace`; map them to the corresponding host directory.
The standard application Dockerfile requires this owned distribution as its
`owned-electron` named build context. It verifies all three native input probe
markers, the exact fork definition and every file before installing application
dependencies. There is no stock-runtime fallback:

```sh
docker buildx build --load -f docker/Dockerfile \
  --build-context "owned-electron=/absolute/path/to/verified/browser" \
  --target runtime -t opencraft:local .
```

For `docker compose build`, persist the same host directory as
`OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION` in `docker/.env`; Compose supplies the
named context to all three service builds. Its default lookup directory is
`.local/owned-electron/browser` at the repository root. Missing input fails;
building a runtime never starts a second Electron compilation implicitly.
See [Compose deployment](../../docker/README.md). Prebuilt image users do not
need a distribution directory on their runtime host.

`Electron fork native artifacts` now also probes a fresh Linux browser
distribution and uploads its inventory marker alongside the unchanged
`dist.zip`. Set repository variable `OPENCRAFT_ELECTRON_ARTIFACT_RUN_ID` to a
successful native workflow run. Container and headless CI consume the browser
proof; desktop jobs consume the independent desktop proof. The shared restore
action validates executable permissions, versions, fork identity and full file
inventory before packaging. A run ID does not bypass provenance checks.

For a component update to an existing OpenCraft Linux x64 image, use
`docker/browser-runtime.Dockerfile`. Pin the selected base image ID, tag that
local image for the build, and supply the verified distribution as a named
BuildKit context:

```sh
docker buildx build --load -f docker/browser-runtime.Dockerfile \
  --build-context "owned-electron=/absolute/path/to/verified/browser" \
  --build-arg BASE_IMAGE=opencraft:pinned-base \
  --build-arg OPENCRAFT_BASE_IMAGE_ID=sha256:FULL_BASE_IMAGE_ID \
  --build-arg OPENCRAFT_SOURCE_REVISION=FULL_SOURCE_COMMIT \
  -t opencraft:owned-browser .
```

This verifies the complete distribution and native input probe markers before
replacing the browser component. It removes obsolete browser files, updates
that component's manifest hashes and provenance, and preserves the existing
application code, browser worker, entrypoint and deployment history. It uses
the application's `/opt/opencraft` layout and defaults to runtime UID/GID 1000;
set `RUNTIME_USER` when the selected image requires a different image user.
Run candidate startup and browser/input acceptance before switching the Hands
service. Neither building the candidate nor updating a Gateway supplies a
native runtime to an already running Hands owner.
