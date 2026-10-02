# Sandbox command control

The maintained guest uses one release artifact for two isolated runtime roles:

```text
/sbin/minisandbox-init (PID 1: mounts, signals, wait/reap, poweroff)
└── forked control agent (loopback listener and command sessions)
```

This is one binary, not one event loop. PID 1 never parses command frames and
never waits on command sockets. The agent is a critical child supervised by PID
1. It binds before the warm workload invokes the checkpoint ioctl, so its
listener survives template capture and is immediately available in every COW
clone.

The host reaches the listener with the existing clone-local
`SocketIngressHandle`. A guest `listen(2)` still creates no host listener or
host descriptor by itself. `PvmLinuxInstance::sandbox_control()` explicitly
injects a private host TCP pair into the reserved guest loopback port only when
the trusted host asks to run a command:

```rust,no_run
use std::time::Duration;
use minisandbox_core::control::{CommandSpec, PtySize};

let control = instance.sandbox_control();
control.ping(Duration::from_secs(2))?;

let spec = CommandSpec::new("/usr/bin/python3")
    .arg("-q")
    .cwd("/workspace")
    .env("PYTHONUNBUFFERED", "1")
    .user_name("sandbox")
    .terminal(PtySize::new(24, 80));
let mut command = control.start(&spec, Duration::from_secs(2))?;
command.resize(PtySize::new(40, 120))?;
command.write_stdin(b"print(6 * 7)\n")?;
command.close_stdin()?;
let result = command.collect()?;
assert_eq!(result.exit_code, 0);
# Ok::<(), Box<dyn std::error::Error>>(())
```

`CommandSpec` is encoded as bounded raw Unix bytes and executed directly. The
program and cwd must be absolute; the agent never invokes `/bin/sh`, searches
`PATH`, or launches `env`, `su`, `stty`, or another helper. The child receives
only explicitly supplied environment entries. Named users are resolved by the
agent's bounded `/etc/passwd` parser; numeric uid/gid is also supported, and
supplementary groups are cleared before dropping credentials.

`execute()` is the synchronous convenience form. Its timeout is a real command
lifetime: periodic output cannot renew it. `execute_with_timeouts()` separates
the per-request transport timeout from that lifetime. `start()` returns an
attached session with no command-lifetime deadline; `start_with_timeout()` adds
one while retaining a distinct request timeout for startup and control actions.
The deadline is enforced independently on both sides: the guest kills and reaps
the process group, while the host closes an unresponsive guest connection.

Streaming stdin, signals, and PTY resize are acknowledged actions. A successful
TCP write is not reported as operation success. Each action carries a nonzero
ID and returns a fixed result with an accepted-byte count or Linux errno. In
particular, a full eight-slot stdin queue returns `EAGAIN` without silently
discarding the fragment. Output arriving while the host waits for an action ACK
is retained in a bounded queue and remains visible through `next_event()`.

The PTY is allocated with the statically linked libc API and made the child's
controlling terminal. This attachment currently lives for one control
connection; reconnectable background sessions remain separate future work.
Dropping a live session closes the stream and the agent kills and waits for the
command process group.

## Fixed protocol bounds

The wire definition is isolated in `minisandbox-control-protocol` and has no
PVM, device, filesystem, or async-runtime dependency. Version 4 uses a canonical
32-byte little-endian header and these fixed limits:

- 64 KiB maximum payload per frame, checked before allocation;
- 32 admitted command/control connections per clone;
- at most 1 MiB in the mixed agent event queue and 512 KiB in its stdin queue;
- 8 MiB combined stdout/stderr in the host `execute()` convenience call;
- 4096 bytes per absolute guest path, 64 MiB per convenience file transfer,
  and 4096 entries per directory listing;
- 256 arguments, 256 environment entries, and a 64 KiB aggregate structured
  command record;
- an optional 64-bit millisecond command deadline plus correlated, fixed-size
  ACK records for stdin, signal, and PTY resize;
- one nonzero request ID and exactly one top-level operation per connection;
- signal values restricted to 1 through 64 and exit values to 0 through 255.

Unknown versions, flags, opcodes, reserved fields, operation shapes, request
IDs, and oversized lengths fail closed. Host output capture overflow drops the
session, causing the guest command to be killed. A disconnected or malformed
control input also kills and reaps the command group.

The guest and its agent remain untrusted. Consequently, the host validates all
response records even though it initiated the connection. This change adds one
small host parser, but adds no hypercall, MMIO register, shared ring, PCI model,
or host path/FD operation. The existing PVM boundary and socket broker remain
the host security boundary.

Process groups provide normal shell/job cleanup semantics, not a security
boundary against a malicious program that deliberately calls `setsid(2)`.
Whole-sandbox CPU and private-memory enforcement must remain in the host. Strong
per-command containment, if required later, needs a guest cgroup or equivalent
kernel-owned membership mechanism rather than `/proc` traversal.

The agent is not an intra-guest privilege boundary: it runs as root, and the
guest as a whole is the PVM trust unit. A workload that reaches the reserved
loopback port can consume the clone's 32 control slots or invoke the same
command/file surface as the host. This is guest-local self-compromise/DoS, not
host escape; deployments that require mutually distrusting users inside one
clone need an authenticated guest channel and guest-side credentials.

## Bounded file API

`PvmLinuxInstance::sandbox_files()` exposes `read`, atomic `write`, `stat`,
`list`, `make_dir`, `remove`, and `rename`. Paths are raw Unix paths and must be
absolute; they are always resolved inside the guest. No host pathname or host
file descriptor is sent to the guest.

```rust,no_run
use std::time::Duration;

let files = instance.sandbox_files();
files.make_dir("/workspace/project", true, Duration::from_secs(2))?;
files.write(
    "/workspace/project/main.py",
    b"print(6 * 7)\n",
    Duration::from_secs(2),
)?;
let source = files.read(
    "/workspace/project/main.py",
    Duration::from_secs(2),
)?;
assert_eq!(source, b"print(6 * 7)\n");
# Ok::<(), Box<dyn std::error::Error>>(())
```

File content is split into canonical 64 KiB frames. A write first creates a
same-directory file with `O_CREAT|O_EXCL`; only a complete, flushed upload is
renamed over the destination. Disconnects and malformed frames remove that
temporary file and leave the prior destination intact. Every file call also
has an absolute host-side deadline, so a malicious guest cannot extend a
five-second call indefinitely by slowly returning valid frames.

This first slice intentionally omits filesystem watch and open-ended streaming
handles. The convenience calls have fixed memory and response bounds; a future
large-file streaming API should use an explicit cancellable session rather than
silently weakening those bounds.

## Current E2B-compatible slice

The current slice covers direct argv/env/cwd/user execution, pipe and PTY
sessions, terminal resize, stdin, separated or merged output, signals, exit
status, concurrency, checkpoint restoration, and the bounded file API above.
The next protocol extensions needed for broader E2B SDK compatibility are
reconnectable background-command handles and filesystem watch. Those belong on
this same injected transport and do not require another PVM ABI.

The live example validates the control listener across a real warm checkpoint,
then tests Python execution, acknowledged stdin/signal/PTY actions, a
continuously-outputting process stopped by its total deadline, real stdin queue
backpressure, and eight concurrent command sessions:

```text
cargo run --locked --release -p minisandbox-core \
  --example pvm_linux_control -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs
```

The EROFS must contain the newly built static
`target/x86_64-unknown-linux-musl/release/minisandbox-init`; the maintained
`python3 rootfs/build.py debian` path builds, verifies, and installs it
automatically.

The writable live example additionally validates a 160 KiB multi-frame file,
metadata/list/rename/remove, a remote `ENOENT`, and eight parallel file clients:

```text
cargo run --locked --release -p minisandbox-core \
  --example pvm_linux_files -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs \
  target/pvm-linux/minisandbox-upper-2g.ext4 \
  target/pvm-linux/files-api-pool
```
