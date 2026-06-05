# wisp single-host package

This package is intended to be copied to one Linux machine and run without the
full source tree. The Linux machine runs the Wisp daemon and containers locally;
workspace persistence still uses the configured object-storage-compatible
backend. The default packaged config uses `REMOTE_BACKEND=smh`.

Contents:

- `bin/`
  - `wisp`
  - `wispclient`
  - `wispenv`
  - `wisp-fs-agent`
  - `juicefs-smount`
- `assets/`
  - packaged `crun`
  - optional packaged `fusermount3`
  - optional packaged `e2fsprogs` userland tools
  - packaged prebaked base rootfs image
- `juicefs/hack/`
  - `smount.sh`
  - `sformat.sh`
- `config/config.jsonnet.example`
- `scripts/install.sh`

Build on a development machine:

```bash
make linux-single-tar.gz
```

Quick start on the target Linux machine:

1. Extract the tarball.
2. Run `sudo ./scripts/install.sh /opt/wisp` or install in-place.
3. Provide SMH credentials in environment variables or edit
   `/opt/wisp/config/config.jsonnet`:

   ```bash
   export SMH_LIBRARY_ID=...
   export SMH_ACCESS_DOMAIN=...
   export SMH_LIBRARY_SECRET=...
   ```

4. Start the daemon with `sudo -E /opt/wisp/bin/wisp daemon run`.
5. Run `sudo -E /opt/wisp/bin/wisp bootstrap`.
6. Create and start a workspace:

   ```bash
   sudo -E /opt/wisp/bin/wispclient -server http://127.0.0.1:8520 create demo
   sudo /opt/wisp/bin/wispclient -server http://127.0.0.1:8520 start demo
   sudo /opt/wisp/bin/wispclient -server http://127.0.0.1:8520 exec demo -- /bin/sh -lc 'echo hello from wisp && pwd'
   ```

`bootstrap` now performs host preflight checks automatically before it prepares
the workspace. A prebaked packaged base image is mounted read-only as the base
lower layer.

The install script renders `config/config.jsonnet` from the single-host SMH
example template and replaces the placeholder install root with the target
prefix.

Host requirements still expected outside the package:

- Linux with root privileges
- `bash`
- `tar`
- `mke2fs`
- `e2fsck`
- overlayfs, loop-device support, and cgroup v2

## Release packaging notes

Prepare a static `crun` before packaging so target sandboxes do not need
`libyajl.so.2` or other runtime libraries:

```bash
GOARCH=amd64 ./hack/release/prepare-static-crun.sh
```

Prepare an AGS-compatible prebaked rootfs image. This rewrites the ext4 image
without `64bit` and `metadata_csum`, which avoids mount failures on the current
AGS kernel/runtime path:

```bash
GOARCH=amd64 ./hack/release/prepare-compat-rootfs.sh
```

The compact compatibility image is intentionally minimal and does not include a
package manager. For flows that need runtime package installation, prepare a 2G
OpenCloudOS rootfs with `microdnf`, `rpm`, `dnf`, and `gcc` installed:

```bash
GOARCH=amd64 ./hack/release/prepare-opencloudos-package-rootfs.sh
```

The generated OpenCloudOS rootfs rewrites `BaseOS`, `AppStream`, and `extras`
to prefer Tencent internal mirrors first:

```text
http://mirrors.tencentyun.com/opencloudos/$releasever/...
http://mirrors.tencent.com/opencloudos/$releasever/...
https://mirrors.opencloudos.tech/opencloudos/$releasever/...
```

Prepare `tini` locally so bootstrap never downloads it from GitHub at runtime:

```bash
GOARCH=amd64 ./hack/release/prepare-tini.sh
```

The package script accepts explicit artifact inputs, which is the preferred path
for small sandbox images:

```bash
GOOS=linux GOARCH=amd64 \
  WISP_CRUN_BINARY="$PWD/assets/bin/crun/crun-amd64" \
  WISP_FUSERMOUNT_BINARY="$PWD/assets/bin/fuse/fusermount3-amd64" \
  WISP_E2FSPROGS_DIR="$PWD/assets/bin/e2fsprogs/amd64" \
  WISP_TINI_BINARY="$PWD/assets/bin/tini/tini-amd64" \
  WISP_ROOTFS_IMAGE="$PWD/assets/rootfs/images/opencloudos-amd64-package-2g.img" \
  WISP_BUILD_WITH_DOCKER=1 \
  WISP_PACKAGE_WITH_DOCKER=1 \
  ./hack/release/package-tarball.sh
```

Publish the generated tarball to COS:

```bash
COSCMD_BIN=/tmp/coscmd-venv/bin/coscmd \
  COSCMD_CONFIG=/tmp/cos-agent-sidecar.conf \
  COS_OBJECT_PREFIX=/workspace/20260520 \
  ./hack/release/publish-cos.sh dist-release/wisp-linux-amd64-20260520T094918Z.tar.gz
```

`publish-cos.sh` emits an `http://<bucket>.cos.<region>.myqcloud.com/...`
URL by default. On same-region Tencent Cloud compute, the default COS domain is
resolved to the private network path, so this avoids TLS overhead while still
using COS as the release distribution channel. Set `COS_PUBLIC_SCHEME=https` or
`COS_PUBLIC_BASE_URL=...` if a public HTTPS URL is required.

On macOS, use `WISP_BUILD_WITH_DOCKER=1`; the JuiceFS helper is built in a
Linux container because it has Linux-only and cgo build constraints. When GNU
tar is available, or when `WISP_PACKAGE_WITH_DOCKER=1` is set,
`package-tarball.sh` uses sparse-file packaging so prebaked ext4 images stay
compact.

The default release tags intentionally keep the SMH runtime path and compile out
unused S3-compatible and COS storage backends. COS is still used as a release
artifact distribution channel by `publish-cos.sh`; it is not the workspace
mount backend.

`package-tarball.sh` also builds the Wisp binaries with `-trimpath` and
`-ldflags "-s -w -buildid="` by default. This keeps the release artifact small
without relying on post-build `strip`; override `WISP_LDFLAGS` or
`JUICEFS_LDFLAGS` only when a debug-symbol build is explicitly needed.

The packaged `sformat.sh` and `smount.sh` scripts do not contain COS
credentials. With `REMOTE_BACKEND=smh`, they only use `SMH_LIBRARY_ID`,
`SMH_ACCESS_DOMAIN`, `SMH_SPACE_ID`, and a short-lived `SMH_ACCESS_TOKEN`.
