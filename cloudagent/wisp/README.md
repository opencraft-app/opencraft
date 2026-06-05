# wisp

`wisp` is a small rootful runtime prototype for a Wisp-like environment.

It does not implement an OCI runtime. It prepares the rootfs, writable upper
image, overlay mounts, outer cgroup policy, and OCI bundle, then delegates
container execution to external `crun`.

## What it does

- prepares a base rootfs from `BASE_ROOTFS_IMG` or `BASE_ROOTFS_DIR` configured in `config.jsonnet`
- creates and mounts a sparse ext4 upper image
- assembles the final overlay rootfs
- bind-mounts host-local paths for `/tmp`, `/var/lib/docker`, logs, and policy
- generates an OCI `config.json`
- starts and manages a container through external `crun`
- applies host-side outer cgroup policy
- snapshots and restores the writable image

## Requirements

- Linux
- root privileges for lifecycle commands
- `mke2fs`, `e2fsck`
- a writable filesystem for `RUNTIME_ROOT` (do not assume `/run` is writable)

## Layout

- `cmd/wisp`: CLI entrypoint
- `internal/config`: config loading and defaults
- `internal/runtime`: runtime orchestration
- `config.jsonnet.example`: editable base config template
- `containers/<name>/overlay.jsonnet`: per-container runtime overlay
- `assets/rootfs`: downloaded tarballs and per-arch built loop images

## Base Rootfs

The runtime does not infer a base rootfs path in Go anymore. Point
`BASE_ROOTFS_IMG` or `BASE_ROOTFS_DIR` at the exact source you want to use.

The repository helper to prepare a loop image is:

```bash
./hack/buildloop.sh
```

The script downloads both Ubuntu Plucky cloud-image rootfs tarballs and builds
prebaked ext4 loop images under `assets/rootfs/images/`. Set `BASE_ROOTFS_IMG`
in `config.jsonnet` to the exact image path you want the runtime to consume.
Prebaked images contain the wisp user, required base directories, `/etc/mtab`,
and `.wisp-base-ready`; `bootstrap` mounts them read-only as
`LOWER_SYSTEM_BASE` instead of copying the rootfs tree.

## crun

If `CRUN_BINARY` is empty, `wisp` uses host `crun`.
If host `crun` is unavailable or incompatible, point `CRUN_BINARY` at a known-good binary explicitly.
`wisp enter` and API exec commands run as the configured `WISP_USER` by
default; use passwordless `sudo` inside the container for root operations.

## COS / JuiceFS

If `COS_ENABLED=1`, `bootstrap` first ensures that `JFS_ROOT` is a live
JuiceFS mount before it prepares remote-backed runtime state under that path.

The default flow is:

1. read path roots from `config.jsonnet` plus `containers/<name>/overlay.jsonnet`
2. run `juicefs/hack/sformat.sh $COS_WORKSPACE` when the workspace needs formatting
3. run `juicefs/hack/smount.sh $COS_WORKSPACE $JFS_ROOT`
4. verify that `JFS_ROOT` is mounted as `fuse.juicefs`
5. place only upper-image state, checkpoints, and policy under `$JFS_ROOT/wisp/<name>`

The default split is:

- local: `LOWER_ROOT`, `LOWER_LANGUAGES`, `LOWER_SYSTEM`, `LOWER_SYSTEM_BASE`, `CRUN_BINARY_PATH`
- remote: `STATE_ROOT`, `ACTIVE_ROOT`, `ACTIVE_IMG`, `CHECKPOINTS_ROOT`, `POLICY_ROOT`

Relevant env vars:

- `REMOTE_BACKEND`
- `COS_ENABLED`
- `JFS_ROOT`
- `COS_WORKSPACE`
- `JFS_LOCAL_ROOT`
- `JFS_PREFIX`
- `JFS_BIN`
- `JFS_BUILD`
- `JUICEFS_REPO_ROOT`
- `SMH_LIBRARY_ID`
- `SMH_ACCESS_DOMAIN`
- `SMH_SPACE_ID`

### Remote Backend Shape

The runtime is structured as:

1. remote backend
2. local POSIX shim
3. `wisp` runtime / overlay / `crun`

Today the default backend is `cos`.

Phase-1 SMH integration adds:

- `REMOTE_BACKEND=smh`
- `SMH_LIBRARY_ID`
- `SMH_ACCESS_DOMAIN`
- `SMH_SPACE_ID`

SMH uses the same local POSIX contract as COS: `wisp` still mounts a local
JuiceFS view at `JFS_ROOT`, then stores the runtime upper image, checkpoints,
and policy under that mount. The difference is only the remote backend behind
the metadata replica and data objects.

Minimal SMH config shape:

```jsonnet
{
  REMOTE_BACKEND: "smh",
  COS_ENABLED: true,
  COS_WORKSPACE: workspace,
  JFS_ROOT: "/mnt/smh-workspace",
  JFS_LOCAL_ROOT: "/var/lib/wisp-jfs",
  JFS_PREFIX: "workspace",
  JFS_BIN: projectRoot + "/bin/juicefs-smount",

  SMH_ENABLED: true,
  SMH_LIBRARY_ID: "<library-id>",
  SMH_ACCESS_DOMAIN: "https://<library-id>.<region>.api.tencentsmh.com",
  SMH_SPACE_ID: "",
  SMH_TOKEN_TTL_SECONDS: 259200,
}
```

Secret handling:

- `SMH_LIBRARY_SECRET` is required only on the server side when `wisp` needs to
  create a space or mint a short-lived `SMH_ACCESS_TOKEN`.
- Do not commit `SMH_LIBRARY_SECRET` or write it into
  `containers/<name>/overlay.jsonnet`.
- `create <name>` is the provisioning point. If `SMH_SPACE_ID` is empty, it
  creates one SMH space for the workspace and persists only
  `REMOTE_BACKEND`, `SMH_LIBRARY_ID`, `SMH_ACCESS_DOMAIN`, and `SMH_SPACE_ID`
  into the workspace overlay.
- If a space already exists, set `SMH_SPACE_ID` before `create <name>` and no
  new SMH space is created.

Operator flow:

```bash
export SMH_LIBRARY_SECRET='<server-side-secret>'

sudo ./dist/wisp workspace use demo
sudo ./dist/wisp create demo
sudo ./dist/wisp start demo
```

Direct JuiceFS checks use the same backend variables:

```bash
export REMOTE_BACKEND=smh
export SMH_LIBRARY_ID='<library-id>'
export SMH_ACCESS_DOMAIN='https://<library-id>.<region>.api.tencentsmh.com'
export SMH_SPACE_ID='<space-id>'
export SMH_ACCESS_TOKEN='<temporary-access-token>'

./bin/juicefs-smount sformat demo --local-root /var/lib/wisp-jfs
./bin/juicefs-smount smount demo --local-root /var/lib/wisp-jfs --mountpoint /mnt/smh-workspace
```

For the Wisp release artifact, build the SMH-focused `juicefs-smount` with the
release helper. The default release tags now keep `sformat`, `smount`,
Litestream VFS, and SMH, while compiling out unused object stores, progress UI,
debug agent, Pyroscope, metrics server, legacy Litestream S3, object
encryption, and VFS backup code.

## Build

```bash
make build
```

This produces:

- `dist/wisp`
- `dist/wispclient`
- `dist/wispclient`
- `dist/wispenv`

## Test

```bash
make test
```

## Usage

```bash
sudo ./dist/wisp bootstrap
sudo ./dist/wisp bootstrap --rebuild-base
sudo ./dist/wisp start
sudo ./dist/wisp status
sudo ./dist/wisp enter
sudo ./dist/wisp checkpoint create
sudo ./dist/wisp checkpoint restore <checkpoint-id>
sudo ./dist/wisp stop
```

## Crash Safety Contract

Wisp treats `active/root-upper.img` as a mutable working set. The crash-safe
recovery boundary is the latest committed checkpoint recorded in the remote
checkpoint manifest, not the current active image and not an ordinary barrier.

Default lifecycle semantics:

- `writeback=1` stays enabled for interactive performance.
- Manual checkpoints are classified as `class=manual` and are never removed by
  system checkpoint retention.
- Automatic, idle, graceful stop, and umount checkpoints are classified as
  `class=system` with a `trigger` field.
- Graceful `stop` succeeds only after a system checkpoint commits. If the
  checkpoint fails, stop fails closed.
- `wispclient stop --force <name>` and
  `POST /v1/wisps/{wisp}/stop?force=1` are the explicit non-destructive escape
  hatch. They skip checkpointing and the next recovery may roll back to the
  latest committed checkpoint.
- `destroy` remains destructive and is not force stop.

Checkpoint commit under `writeback=1` uses a cut-aware writeback fence: chunks
staged at the checkpoint cut must upload before the manifest pointer advances,
while later writes do not block the earlier checkpoint commit.

## Daemon Mode

Run the daemon:

```bash
sudo ./dist/wisp daemon run
```

Host-side admin commands:

```bash
sudo ./dist/wisp workspace use orbcrun-sg3
sudo ./dist/wisp bootstrap
sudo ./dist/wisp create orbcrun-sg3
sudo ./dist/wisp ls
sudo ./dist/wisp status orbcrun-sg3
sudo ./dist/wisp start orbcrun-sg3
sudo ./dist/wisp enter orbcrun-sg3
sudo ./dist/wisp stop orbcrun-sg3
sudo ./dist/wisp destroy orbcrun-sg3
```

`bootstrap` without a name performs one host-global bootstrap for shared lower
layers and shared tools. `create <name>` then prepares that workspace's upper
image. `start <name>` will fail instead of silently preparing missing state. By
default `CRUN_BINARY_PATH` points at a host-shared tool cache; set it in a
container overlay if one workspace needs a different runtime binary.
`bootstrap` also performs the host preflight checks that used to live in the
packaging shell script.

`wisp workspace use <name>` materializes
`containers/<name>/overlay.jsonnet` while keeping `config.jsonnet` unchanged.
Use it when you want to keep the same base image but switch the writable upper
state to a new container name.

In-container command:

```bash
/.wisp/bin/wispenv info
```

By default the CLI reads `config.jsonnet` from the project directory and then
applies `containers/<base-name>/overlay.jsonnet`. It also accepts
`config/config.jsonnet` next to the working directory or install root. You can
override the base file with `WISP_CONFIG=/path/to/config.jsonnet` and the overlay file with
`WISP_CONFIG_OVERLAY=/path/to/containers/<name>/overlay.jsonnet`.

`config.jsonnet` is the primary runtime config source, per-container overlay
files are the runtime override layer, and both are evaluated through the
embedded Go Jsonnet evaluator. Path inference is intended to live in jsonnet
locals, not in Go fallback logic.

## Network API

The daemon keeps the local Unix admin socket and also exposes an HTTP API on
`ADMIN_LISTEN_ADDR`, which defaults to `0.0.0.0:8520`.

Current HTTP endpoints:

- `GET /v1/runtime/containers`
- `POST /v1/runtime/create`
- `GET /v1/runtime/status?name=<container>`
- `POST /v1/runtime/bootstrap`
- `POST /v1/runtime/start`
- `POST /v1/runtime/stop`
- `POST /v1/runtime/destroy`
- `GET /v1/runtime/exec?name=<container>[&argv=/bin/sh&argv=-lc&argv=env]`

New Wisps-shaped v1 endpoints:

- `GET /v1/wisps`
- `POST /v1/wisps`
- `GET /v1/wisps/{wisp}`
- `POST /v1/wisps/{wisp}/start`
- `POST /v1/wisps/{wisp}/stop`
- `DELETE /v1/wisps/{wisp}`
- `POST /v1/wisps/{wisp}/exec`
- `GET /v1/wisps/{wisp}/exec/ws`
- `GET /v1/wisps/{wisp}/checkpoints`
- `POST /v1/wisps/{wisp}/checkpoints`
- `GET /v1/wisps/{wisp}/checkpoints/{checkpoint}`
- `POST /v1/wisps/{wisp}/checkpoints/{checkpoint}/restore`
- `GET /v1/wisps/{wisp}/filesystem?path=/...`
- `GET /v1/wisps/{wisp}/filesystem/content?path=/...`
- `PUT /v1/wisps/{wisp}/filesystem/content`
- `POST /v1/wisps/{wisp}/filesystem/mkdir`
- `POST /v1/wisps/{wisp}/filesystem/rename`
- `DELETE /v1/wisps/{wisp}/filesystem?path=/...`
- `GET /v1/wisps/{wisp}/filesystem/stat?path=/...`

`/v1/runtime/*` remains available as the brownfield compatibility surface in v1.

Example:

```bash
curl -s http://127.0.0.1:8520/v1/runtime/containers
curl -s -X POST http://127.0.0.1:8520/v1/runtime/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{}'
curl -s -X POST http://127.0.0.1:8520/v1/runtime/create \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo"}'
curl -s -X POST http://127.0.0.1:8520/v1/runtime/start \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo"}'
```

## Remote CLI

`wispclient` is the TCP client for the HTTP/WebSocket control plane. It defaults
to `http://127.0.0.1:8520` and is intended for controlling a daemon running on
another machine or over an SSH tunnel.

Examples:

```bash
./dist/wispclient bootstrap
./dist/wispclient create demo
./dist/wispclient start demo
./dist/wispclient shell demo
./dist/wispclient exec demo -- /bin/sh -lc 'echo hello'
./dist/wispclient checkpoint create demo
./dist/wispclient fs mkdir demo /workspace
./dist/wispclient fs write demo /workspace/hello.txt hello
./dist/wispclient fs read demo /workspace/hello.txt
./dist/wispclient stop demo
./dist/wispclient destroy demo
```

## WebSocket Exec

`GET /v1/runtime/exec` upgrades to a WebSocket-backed PTY session and runs the
same `crun exec -t` path used by `wisp enter`.

Query parameters:

- `name=<container>` selects the container
- repeated `argv=` values optionally override the default interactive shell
- `cols=` and `rows=` optionally set the initial PTY size

Frame behavior:

- client text/binary frames are written to PTY stdin
- server binary frames stream PTY output
- a client text frame with JSON `{"type":"resize","cols":120,"rows":40}` resizes the PTY

DNS inside the runtime is injected via `/etc/resolv.conf`. By default it writes:

- `nameserver 114.114.114.114`

You can override that with `RESOLV_NAMESERVERS`, for example:

- `RESOLV_NAMESERVERS=114.114.114.114,223.5.5.5`

## Command summary

- `wisp bootstrap`
- `wisp bootstrap --rebuild-base`
- `wisp start`
- `wisp stop`
- `wisp status`
- `wisp enter`
- `wisp cgroup apply`
- `wisp checkpoint create [id]`
- `wisp checkpoint restore <id>`
- `wisp prepare-min-base [dest]`
- `wisp daemon run|status|bootstrap|start|enter|stop`
- `wispenv info`
