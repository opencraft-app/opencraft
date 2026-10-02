# Minisandbox guest init

`minisandbox-init` is the complete PID 1 and command-agent artifact for the
maintained PVM Linux guest. It is deliberately not a general service manager.
One shared Rust library is linked into both release entry points:

```text
cargo build --locked --release -p minisandbox-cli -p minisandbox-init --bins
target/release/minisandbox init --mode console
target/release/minisandbox-init --mode console
```

Both forms mount the fixed `devtmpfs`, procfs, sysfs, devpts, and bounded tmpfs
instances. When the fixed `/dev/vda` writable device is present (or the host
explicitly supplies `minisandbox.overlay=1`), init mounts its ext4 upper and
pivots to an OverlayFS root before starting the workload. The
default `warm` mode launches `/opt/minisandbox/minisandbox-warm`; `console`
launches an autologin `agetty` on `ttyS0`. An explicit command can be selected
with `-- PROGRAM [ARG...]`.

`/dev/shm` defaults to 32 MiB. A host-owned profile can select a bounded,
lazily allocated size with `minisandbox.shm_mib=N` on the kernel command line;
PID 1 accepts exactly one decimal value in `1..=4096`. This is used by large
browser workloads without adding a guest-controlled mount parser.

PID 1 blocks and consumes its bounded signal set with `signalfd`, starts one
workload process group, forwards termination and terminal signals, and drains
all children with `waitpid(-1)`. Once the primary workload exits it terminates
remaining guest processes and calls `sync()`. It then requests the already
versioned `PvmHypercall::Exit` through `/dev/minisandbox`, carrying only the
normalized 8-bit workload status; a provider without that capability falls
back to `reboot(RB_POWER_OFF)`. The final fallback parks
forever, so no path deliberately returns from global PID 1 and Linux cannot
reach `Attempted to kill init!`.

After mounting the runtime filesystems, the still-single-threaded PID 1 binds
the fixed loopback control port and forks one critical agent process from the
same executable image. PID 1 remains only the supervisor. The agent owns
blocking command I/O and worker threads, so a slow control connection cannot
stall PID 1's signal or child-reaping path. If the agent exits before the
primary workload, PID 1 treats that as a fatal guest failure.

Binding happens before the default workload can publish its warm checkpoint.
The listener and sleeping agent are therefore restored with every clone. The
host reaches it through the existing explicit TCP ingress path; no guest port
is exported merely because it called `listen(2)`. The current protocol supports
ping, structured direct `execve` without a shell, acknowledged stdin/signal/PTY
actions, true command deadlines, streaming output, process-group signals, and
normalized exit status. See
[`docs/sandbox-control.md`](../../docs/sandbox-control.md) for the limits and
host API.

All mount sources, mount targets, sizes, and executable defaults are constants.
The mode and OverlayFS boolean come from the host-owned kernel command line.
This code executes inside the untrusted Linux guest. The agent adds no host
syscall, host-side device, hypercall number, or shared-memory surface. Its only
host connection is an ordinary stream explicitly injected through the existing
socket broker. The host does parse the separate fixed control protocol after
the connection is established.
