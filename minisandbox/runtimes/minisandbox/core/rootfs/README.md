# Root filesystem builder

`build.py` is a build-time adapter, not part of the minisandbox runtime. It
turns a merged Linux root filesystem into the exact EROFS layout consumed by
the PVM PMEM/DAX loader: uncompressed 4 KiB blocks, fixed timestamps and UUID,
and 2 MiB image alignment. Every output gets an adjacent
`<image>.metadata.json` provenance record and is checked with `fsck.erofs`.

At runtime the loader opens each immutable artifact read-only and maps the file
directly as a KVM read-only PMEM slot. It does not read or copy the complete
image into a memfd, and it does not lock images in RAM. Pages are faulted on
demand and shared through the host page cache across clones. The host must not
modify or truncate an artifact while any template or clone is alive.

The maintained default is Debian 13 (`trixie`) slim for `linux/amd64`, with
`bash`, CA certificates, `curl`, `wget`, `nslookup`/`dig`, `vim`, `strace`,
`screen`, `tmux`, `procps`, `git`, `gcc` with the glibc development files,
Python 3, and Node.js (the `node` command; npm is deliberately not installed).
The base OCI manifest is pinned by digest. The live APT mode intentionally
receives current Debian security updates and writes the resolved dpkg closure to
`/usr/share/minisandbox/packages.tsv` inside the image:

```text
python3 rootfs/build.py debian
```

The Debian build first produces the standalone guest PID 1/control-agent
artifact from the same Rust library used by the host CLI's `minisandbox init`
subcommand. It then installs `target/release/minisandbox-init` as
`/sbin/minisandbox-init`. A release-built linux/amd64 artifact can instead be
supplied explicitly:

```text
cargo build --locked --release \
  -p minisandbox-cli -p minisandbox-init --bins
python3 rootfs/build.py debian \
  --init-binary target/release/minisandbox-init
```

The artifact is ELF64/x86-64 checked before entering the Docker context, and
its SHA-256 is stored inside the image. The standalone binary and
`target/release/minisandbox` share one init implementation; they are separate
release artifacts rather than copied source trees.

The profile mounts bounded tmpfs instances at `/tmp` (64 MiB) and `/run`
(16 MiB) so compilers, tmux, and screen remain usable on the read-only root.
Those limits reserve addressable capacity, not resident pages; memory is
charged only as files are written.

The build overlays a deterministic `nameserver 192.0.2.53` configuration after
Docker export. The PVM socket broker maps that reserved guest-only address to
the host's current IPv4 resolver, so one immutable EROFS remains portable
across clone hosts.

For a replayable historical package closure, select the dated Debian snapshot.
Snapshot availability is external and can occasionally be rate-limited:

```text
python3 rootfs/build.py debian --apt-source snapshot
```

If a deliberately restricted local Docker daemon has no bridge, an explicit
build network can be selected without changing the recipe:

```text
python3 rootfs/build.py debian --build-network host
```

The output is:

```text
target/pvm-linux/debian-trixie-20260713-x86_64.erofs
target/pvm-linux/debian-trixie-20260713-x86_64.erofs.metadata.json
```

## Other inputs

Convert an existing OCI/Docker image. The image entrypoint is never run:

```text
python3 rootfs/build.py oci \
  docker.io/library/debian:trixie-slim \
  target/pvm-linux/debian.erofs
```

Docker is used only to pull and flatten layers into one rootfs tar. The
temporary container is created with networking disabled and removed after
`docker export`. Images declaring `VOLUME` are rejected because Docker export
would omit those contents. Only `linux/amd64` is currently accepted.

A daemonless OCI tool can supply a merged tar instead. This is the smallest
and preferred conversion boundary because `mkfs.erofs` reads the tar directly;
the builder does not extract untrusted paths onto the host:

```text
python3 rootfs/build.py tar rootfs.tar output.erofs
```

An already materialized directory is also supported:

```text
python3 rootfs/build.py dir rootfs/ output.erofs
```

Directory mode preserves the ownership visible to the invoking user. Use
`--all-root` only for deliberately single-user images. Tar/OCI mode preserves
numeric uid/gid metadata without requiring a root-owned staging tree.

Build a Dockerfile directly through BuildKit's final-rootfs tar exporter:

```text
python3 rootfs/build.py dockerfile ./application \
  target/pvm-linux/application.erofs
```

This route deliberately bypasses `docker create`/`docker export`, so a
Dockerfile `VOLUME` declaration cannot hide the directory contents from the
converter. Buildx executes the Dockerfile as an ordinary trusted image build;
the resulting tar is never extracted onto the host and is fed directly to
`mkfs.erofs`. Image runtime metadata is not inferred from Dockerfile text, so a
caller must still supply its explicit launch identity, argv, environment and
working directory.

## Hermes Agent whole-process profile

The pinned Hermes source is built as a complete PVM workload, not as a Docker
daemon or a nested container:

```text
git clone https://github.com/NousResearch/hermes-agent.git \
  target/research/hermes-agent
git -C target/research/hermes-agent checkout \
  d66341ab28635d9eecbd30a18d50801d927153b8
python3 rootfs/build.py hermes
python3 rootfs/build.py upper \
  --output target/pvm-linux/hermes-upper-8g.ext4 \
  --size-mib 8192
```

The Hermes command emits two immutable artifacts from one patched BuildKit
graph: `hermes-base-d66341ab2863-x86_64.erofs` ends immediately before the full
source copy, while `hermes-app-d66341ab2863-x86_64.erofs` contains only tar
entries whose content or stable metadata differs in the final stage. Identical
Python wheels, Node modules, browsers and system libraries remain only in the
base inode and therefore keep one host page-cache copy across app revisions
that reuse that base. Base-only paths are deliberately retained because the
runtime layer format is additive; the delta counts and both tar hashes are
recorded in artifact metadata.

The builder rejects a different upstream revision or a dirty checkout by
default, injects the static minisandbox PID 1, and records the source revision,
MIT license and launch policy in the EROFS metadata. The warm template contains
no credentials or user state. After cloning, Hermes runs as its image account
(UID/GID 10000), with `/opt/hermes` immutable and `/opt/data` on the private
writable OverlayFS layer.

The reviewed Hermes Dockerfile patch also force-compiles the application tree
and virtual environment to PEP 552 checked-hash, optimization-0 `.pyc` files.
Hash validation remains correct after deterministic EROFS timestamp rewriting,
while explicit compilation works even though runtime bytecode writes are
disabled. The exact bytecode policy is recorded in artifact metadata.

Run the offline identity/version smoke on a PVM-enabled host:

```text
cargo run --locked --release -p minisandbox-core \
  --example pvm_linux_hermes -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/hermes-base-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-app-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-upper-8g.ext4 \
  target/pvm-linux/hermes-block-pool
```

The smoke invokes `hermes chat -q` without credentials. Reaching Hermes'
non-interactive “no API keys or providers found” guard and its `hermes setup`
guidance is treated as success and emits
`MINISANDBOX_HERMES_NO_CREDENTIALS_OK`. It then runs a deterministic one-shot
chat against a bounded host-loopback OpenAI-compatible SSE peer. That second
check traverses Hermes, the guest socket provider, the PVM capability broker,
HTTP streaming and Hermes' final response parser; it emits
`MINISANDBOX_HERMES_LOCAL_E2E_OK`. It excludes WAN and model inference latency,
and no real secret enters either the template or clone.

The smoke also creates a second clone and performs a one-time handoff from the
checkpoint-aware bootstrap to upstream `hermes_cli.gateway.run_gateway()`.
It enables Hermes' authenticated API server on guest loopback port 8642 but
does not bind a host port. The host obtains a private connected FD through
`SocketIngressHandle::connect_tcp()` and hands it directly to Hyper's HTTP/1
client. Response bodies are consumed as a stream rather than aggregated. The
smoke verifies an unauthenticated
`/v1/models` request is rejected, verifies an authenticated request succeeds,
and sends four concurrent `/health` requests over four independent FDs. A
successful run emits `MINISANDBOX_HERMES_GATEWAY_FD_E2E_OK`. This exercises
the real gateway, guest `accept(2)`, PVM stream capabilities, concurrent broker
connections, HTTP and API authentication without adding a public listener.
Before the handoff a caller can use
`SandboxFiles::write` to install clone-private `/opt/data/config.yaml`, then
invoke `/opt/minisandbox/hermes-launch.py` with one `--env NAME` option for
each credential or platform variable to copy into the daemon. Values come from
the launcher's environment and never appear in argv or the immutable template.

Measure only per-sandbox clone construction and checkpoint-to-resume cost with:

```text
cargo run --locked --release -p minisandbox-core \
  --example pvm_linux_hermes -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/hermes-base-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-app-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-upper-8g.ext4 \
  target/pvm-linux/hermes-block-pool \
  2048 --startup-clones 8
```

Use `--concurrent-startup-clones N` to construct the same independent clones
and then resume their vCPUs concurrently.

Measure fresh-clone-to-final-answer latency with the deterministic provider:

```text
cargo run --locked --release -p minisandbox-core \
  --example pvm_linux_hermes -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/hermes-base-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-app-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-upper-8g.ext4 \
  target/pvm-linux/hermes-chat-pool \
  2048 --concurrent-chat-clones 20
```

This mode reports VM creation, control readiness, Hermes-process-to-answer and
clone-to-answer separately. Unlike `--concurrent-startup-clones`, it starts a
complete Python/Hermes process in every clone, so its private memory and CPU
cost are intentionally visible.

Measure the live-interpreter template against the same provider and lifecycle:

```text
cargo run --locked --release -p minisandbox-core \
  --example pvm_linux_hermes -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/hermes-base-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-app-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-upper-8g.ext4 \
  target/pvm-linux/hermes-chat-pool \
  2048 --concurrent-warm-chat-clones 20
```

This starts only the bounded clone-local invocation client. The restored warm
daemon reuses its already-imported Python module graph but constructs a fresh
agent, provider client and session database after resume. No credential or live
provider connection is present in the shared template.

Measure the actual long-lived upstream daemon lifecycle with:

```text
cargo run --locked --release -p minisandbox-core \
  --example pvm_linux_hermes -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/hermes-base-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-app-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-upper-8g.ext4 \
  target/pvm-linux/hermes-gateway-pool \
  2048 --concurrent-gateway-clones 20
```

This reports clone construction, control readiness, launch-to-upstream-ready
and total clone-to-gateway-ready separately. Each daemon has fresh PID/runtime
files, event loop, cron state and platform resources in its private clone.

An explicit real-provider run injects one allowlisted credential into the
already-created clone only:

```text
export OPENROUTER_API_KEY=...
cargo run --locked --release -p minisandbox-core \
  --example pvm_linux_hermes -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/hermes-base-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-app-d66341ab2863-x86_64.erofs \
  target/pvm-linux/hermes-upper-8g.ext4 \
  target/pvm-linux/hermes-real-chat-pool \
  2048 --real-chat openrouter openai/gpt-5-mini OPENROUTER_API_KEY
```

The credential value is neither placed in argv nor printed. Provider and
credential-variable pairs are allowlisted, and output records timing and byte
count rather than the model response. The immutable warm template is built
before the command environment is injected.

The complete reproducible matrix lives under
`benchmarks/pvm-linux-hermes/run-suite.sh`.

The default is 2 GiB RAM with a lazily allocated 1 GiB `/dev/shm`, suitable for
the bundled Chromium. Pass a final `1024..3072` MiB argument to select another
RAM quota; the immutable EROFS and clean template pages remain shared while the
clone is charged only for private COW pages.

## Writable OverlayFS layer

Create the default sparse 2 GiB ext4 image with the required `upper/` and
`work/` directories:

```text
python3 rootfs/build.py upper
```

Choose a different output or logical quota at build time when needed:

```text
python3 rootfs/build.py upper \
  --output target/pvm-linux/my-upper.ext4 \
  --size-mib 2048
```

The output is a sparse regular file plus a provenance sidecar; its logical
capacity is the guest-visible filesystem limit, while initially allocated host
storage is much smaller. The builder refuses to overwrite an existing image,
uses a fixed filesystem UUID for reproducibility, and validates it read-only
with `e2fsck`.

When `/dev/vda` is attached, the maintained Rust PID 1 uses its `upper/` and
`work/` directories over the immutable EROFS root, then `pivot_root`s into the
writable OverlayFS. The explicit `minisandbox.overlay=1` token remains accepted
for bring-up diagnostics. `/tmp` and `/run` remain bounded tmpfs mounts. The
PVM examples are documented in `guest/pvm-linux/README.md`.

## Fixed three-layer profile

The memory-efficient product layout is deliberately fixed rather than a
general image graph:

```text
per-sandbox ext4 upper/work
application-version.erofs
shared base.erofs
```

`base.erofs` is `/dev/pmem0` and remains the Linux boot root.
`application-version.erofs` is `/dev/pmem1`; the guest init mounts it read-only
and constructs `lowerdir=app:base`. `/dev/vda` contains only the clone-private
OverlayFS `upper/` and `work/` directories. The base EROFS page cache is shared
across every application version, the app EROFS page cache is shared by clones
of that version, and warm RAM COW pages are shared only within one warm
template.

Build a minimal additive app tree directly. It may add paths or override base
paths; OCI deletion/whiteout semantics are intentionally unsupported:

```text
python3 rootfs/build.py app application-root/ \
  target/pvm-linux/hermes-d66341ab-app.erofs
```

The builder rejects `.wh.*` entries instead of silently giving them the wrong
meaning. The host exposes exactly two immutable mappings: KVM slot 1 at 8 GiB
for base and slot 4 at 16 GiB for app. Socket mailbox slots 2/3 and the
virtio-blk MMIO page remain unchanged. Every range is page aligned, bounded,
pairwise non-overlapping, host `PROT_READ`, and guest `KVM_MEM_READONLY`.

The standalone integration probe accepts a marker path which the app layer
must override, then creates two sibling writable clones:

```text
cargo run -p minisandbox-core --example pvm_linux_three_layer -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/base.erofs \
  target/pvm-linux/hermes-d66341ab-app.erofs \
  target/pvm-linux/minisandbox-upper-2g.ext4 \
  target/pvm-linux/three-layer-pool \
  /usr/share/minisandbox/application-version d66341ab
```

## Docker/OCI compatibility boundary

The resulting EROFS contains the image's final filesystem tree, so ordinary
glibc/musl applications and files installed by a Dockerfile are reusable. OCI
`Entrypoint`, `Cmd`, environment, user, working directory, exposed ports,
labels, and stop signal are recorded in the sidecar but are not silently
applied by the PVM loader. Docker volume semantics, cgroups, namespaces, and
the Docker daemon are not provided. A writable OverlayFS layer is available
only when the caller explicitly attaches the minisandbox ext4 virtio-blk
device; it is not inferred from OCI metadata.

This is therefore filesystem and userspace compatibility with Docker/OCI, not
Docker-in-the-guest. A generic imported image still needs an init compatible
with the current guest command line (the maintained Debian profile installs
`/sbin/minisandbox-init`). The init binary is supplied separately because an
arbitrary imported OCI filesystem is not silently modified.
