# Dedicated local build storage

`scripts/packaging/build-workspace.mjs` is an opt-in Linux build entry for a separately
provisioned build volume. It never formats disks or changes production storage.
Set `OPENCRAFT_BUILD_ROOT` to its mount point. The entry refuses a missing,
read-only or unprovisioned mount and refuses to fall back to a directory on the
system disk. Host provisioning owns UUID-based mounting and a root-owned
`.opencraft-build-volume.json` containing `schemaVersion: 1`,
`purpose: "opencraft-build"` and the filesystem UUID.

The layout is `worktrees/`, `cache/`, `tmp/`, `artifacts/`, `logs/` and `locks/`.
Use the same absolute mount point inside a build container; bind it explicitly
and let the container access only its build directories. Do not give it the
block device or the production Docker socket. A parent bind mount established
before the new filesystem was mounted will not necessarily expose the disk.

From an OpenCraft checkout:

```sh
export OPENCRAFT_BUILD_ROOT=/path/to/mounted/build-volume
node scripts/packaging/build-workspace.mjs status
node scripts/packaging/build-workspace.mjs worktree dev/local
```

The last command prints a detached checkout path keyed by its complete commit
SHA. Build from that path with its own dependencies; another checkout's
`node_modules` and dirty changes are not copied. Use the entry there to install
and build, keeping generated output on the volume:

```sh
node scripts/packaging/build-workspace.mjs run -- npm ci --no-audit --no-fund
node scripts/packaging/build-workspace.mjs run -- npm run build:web:release
node scripts/packaging/build-workspace.mjs run -- npm run package:headless:linux:amd64
```

The wrapper sets npm, Electron, electron-builder, XDG, ccache, Git and temporary
cache paths, separates per-user caches, holds a shared nonblocking build lock,
and writes output under `logs/<uid>/`. Lock contention exits with status 75.
Build jobs should not put credentials in command output. Configure explicit
artifact output overrides where an individual packaging entry supports them;
otherwise its output remains inside the volume-backed checkout.

Electron source and output live under `worktrees/electron/<fork-definition-hash>`:

```sh
export OPENCRAFT_BUILD_PYTHON=/absolute/path/to/python3.12
node scripts/packaging/build-workspace.mjs electron preflight
node scripts/packaging/build-workspace.mjs electron checkout
node scripts/packaging/build-workspace.mjs electron sync
node scripts/packaging/build-workspace.mjs electron build
```

Preflight/checkout/sync require 200 GiB free. Builds default to at most four
compiler jobs; explicit `--jobs` is forwarded to the existing fork manager.
The pinned toolchain, native OS dependencies, successful compilation and
functional native probes are still separate requirements. This entry does not
claim that a ready disk means a native artifact was built.

For Docker, provision a dedicated docker-container BuildKit builder whose
state volume is backed by the build filesystem. Set `OPENCRAFT_BUILD_BUILDER`
to that builder and run from the volume-backed checkout:

```sh
node scripts/packaging/build-workspace.mjs container -- --load -f docker/Dockerfile -t opencraft:candidate .
```

BuildKit intermediates use the provisioned disk. `--load` still imports final
image layers into the production Docker daemon's image storage. This entry
does not move Docker's data root or restart any production service. Long native
builds should run under an independent supervisor with bounded CPU/memory.
