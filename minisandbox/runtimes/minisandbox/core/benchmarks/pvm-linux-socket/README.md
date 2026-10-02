# PVM Linux socket benchmarks

This directory is a standalone benchmark workspace for the complete
minisandbox TCP path:

```text
guest application socket syscall
  -> PVM Linux socket provider
  -> bounded mailbox slots and IRQ
  -> host socket reactor
  -> host loopback TCP socket
```

The `ingress-*` modes reverse connection establishment without changing the
data path:

```text
host SocketIngressHandle::connect_tcp
  -> bounded ingress offer and guest listener queue
  -> guest accept(2)
  -> the same mailbox slots and fair host reactor
```

It is deliberately not advertised as a raw TCP/IP-stack or NIC benchmark.
The syscall/provider boundary is part of the measurement and is exactly the
product path this suite is meant to expose.

The directory follows the same isolation rules as the scheduler benchmarks:

- it is its own Cargo workspace and uses only public runtime/socket APIs;
- its static guest driver and private EROFS never enter the production guest
  overlay;
- generated files stay below ignored `build/` and `target/` directories;
- the host server binds only an ephemeral loopback port, and every clone gets
  an allowlist containing only that exact address and port;
- deleting this directory removes the complete benchmark without reverting
production code.

The harness also bounds untrusted-protocol-adjacent allocations: at most 128
connections per clone, 512 connections in one host run, 4 million RR latency
samples per clone, 16 GiB per stream, and 128 MiB of guest worker buffers.
Guest headers must exactly match the host-selected configuration before the
server allocates or moves payload data.

## Measurements

`tcp-rr` performs sequential request/response exchanges and reports aggregate
operations per second plus p50/p99/p999 latency. The standard sizes are 1, 32,
256, and 1024 bytes.

`tcp-rr-rate` uses absolute `CLOCK_MONOTONIC` deadlines to offer a selected
number of request/response operations per second, per connection, for a fixed
duration. This is the non-saturation test: it reveals whether 100 or 1000 RR/s
parks efficiently instead of consuming a core merely because a saturation run
has work available. It also reports operations that began more than one target
period late.

`tcp-stream-tx` and `tcp-stream-rx` move a fixed number of bytes in one
direction. They report MiB/s and the actual number of guest `send(2)` or
`recv(2)` calls. The requested call sizes are 4 KiB, 64 KiB, and 1 MiB. The
actual call count is important: a large userspace buffer may still require one
syscall per 4 KiB provider slot.

Every payload is checked against a deterministic byte pattern, so the
performance run also detects loss, duplication, and reordering. A connections
argument creates 1, 8, or 32 simultaneous sockets inside one single-vCPU guest;
a clones argument runs independently restored guests concurrently. An optional
host delay after each server I/O quantum creates controlled backpressure. The
standard slow-receiver case sleeps 2 ms per 64 KiB quantum, capping its ideal
receiver rate near 31.25 MiB/s.

Prefix any mode with `ingress-` to create the guest listener before the warm
checkpoint and connect from the host after clone restore. The batch JSON then
also reports ingress ACK latency as `connect_p50_ns`, `connect_p99_ns`, and
`connect_max_ns`. One listener accepts at most 16 simultaneous unaccepted
offers; this harness rejects larger ingress connection counts instead of
confusing bounded admission with a successful-load benchmark.

## Build the private guest image

Build the production kernel and Debian EROFS once, then run:

```text
./benchmarks/pvm-linux-socket/build-rootfs.sh
```

This writes:

```text
benchmarks/pvm-linux-socket/build/debian-socket-bench.erofs
```

## Run

Run the standard RR, bidirectional stream, connection-fairness, clone-scaling,
and slow-receiver matrix:

```text
./benchmarks/pvm-linux-socket/run-suite.sh
```

One direct invocation is:

```text
cargo run --release \
  --manifest-path benchmarks/pvm-linux-socket/Cargo.toml -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  benchmarks/pvm-linux-socket/build/debian-socket-bench.erofs \
  tcp-rr 32 8 1 10000 0
```

The equivalent host-to-guest run is:

```text
cargo run --release \
  --manifest-path benchmarks/pvm-linux-socket/Cargo.toml -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  benchmarks/pvm-linux-socket/build/debian-socket-bench.erofs \
  ingress-tcp-rr 32 8 1 10000 0
```

The trailing arguments are:

```text
<mode> <I/O bytes> <connections/clone> <clones> \
  <RR iterations or stream bytes/connection> <host delay microseconds>
```

Output is JSON Lines followed by one exact `MSSOCKBENCH_RESULT` line per clone.
Guest monotonic time supplies the RR percentiles and stream rate; batch wall
time and aggregate host CPU usage are reported separately. Batch JSON splits
peer-server thread CPU from socket-broker CPU and the remaining VM/runtime CPU.
It also reports guest service doorbells, injected guest IRQs, poll wakeups,
fair-reactor turns, commands/events, socket slots, and socket bytes. These are
host diagnostic snapshots; no benchmark counter is part of the guest ABI.

A fixed-rate invocation uses the amount field as target RR/s and the final
field as duration in milliseconds:

```text
cargo run --release \
  --manifest-path benchmarks/pvm-linux-socket/Cargo.toml -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  benchmarks/pvm-linux-socket/build/debian-socket-bench.erofs \
  tcp-rr-rate 32 1 1 1000 5000
```

## Comparing protocol revisions

Do not compare a kernel from one socket ABI with a host binary from another;
the hard version cutover deliberately rejects that pairing. Build each commit
in a separate detached worktree and run its benchmark binary with its matching
kernel while sharing only the immutable benchmark EROFS.

For notification changes, use at least five three-second fixed-rate samples at
1,000 and 5,000 RR/s. Reverse the version order on alternating rounds and
compare medians for host CPU, broker CPU, doorbells, IRQs, p50, p99, p999, and
late operations. A single p999 sample is not accepted as a regression without
repetition. Run both 16 MiB stream directions and at least one multi-clone case
after the fixed-rate comparison.
