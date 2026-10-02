# Experimental console

This directory is a disposable Linux bring-up aid. It adds no listener,
console protocol parser, or hypercall.

- `device/` is an allocation-free, bounded COM1 UART state machine.
- `runner/` is an explicit local terminal runner; it is not a runtime service.

The intended proof is an interactive Debian shell over the existing legacy
UART. Production guest services must use the capability-backed stream mailbox,
not this per-byte I/O-exit path.

With the pinned PVM Linux artifacts already built:

```text
cargo run -p pvm-console -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/debian-trixie-20260713-x86_64.erofs
```

The runner selects `minisandbox.mode=console`; the standalone guest PID 1
mounts the kernel filesystems and launches an autologin `agetty` on `ttyS0`.
By default it also opens `minisandbox-upper-2g.ext4` beside the EROFS artifact,
locks it exclusively, attaches it as `/dev/vda`, and boots a writable
OverlayFS root. Build that default layer once with `python3 rootfs/build.py
upper`. Choose another persistent layer with `--upper PATH`, or explicitly
request the immutable root with `--read-only`. Never attach one writable layer
to multiple running guests; the host lock rejects that operation.
It copies local stdin into the fixed UART RX FIFO and streams UART TX to local
stdout. Exiting the shell triggers an orderly guest poweroff instead of killing
global PID 1. The runner opens no network or Unix-domain listener and implements
no console framing protocol; outbound connections are created only by the
separate socket broker described below.
The pinned guest's built-in PF_INET provider probes its fixed mailbox at boot.
The runner starts the independently bounded socket broker with unrestricted
outbound TCP and DNS-resolver policies, and forwards service notifications to
it. This is a development default: use the high-level runtime policy APIs for
destination isolation.

For an interactive terminal, the runner temporarily enables local raw mode so
VT100 replies reach the guest immediately instead of appearing as `^[[...R`
text after Enter. Press `Ctrl-]` to detach and restore the local terminal.
