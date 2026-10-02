# PVM socket service

This directory contains the socket-specific PVM boundary and its guest-facing
facade. It is not part of the PVM execution core.

`guest/pvm_socket.c` owns the public `PF_INET` registration. For TCP, `127/8`
and wildcard listeners select a hidden native Linux INET socket, so processes
inside one sandbox can use normal loopback `bind/listen/accept/connect` without
a VM exit or broker capability. Other destinations select host-backed TCP
through the bounded mailbox. `SOCK_DGRAM` remains only a restricted UDP DNS
transport. Native static Go, musl, glibc, and Python programs therefore keep
using ordinary socket syscalls; no libc shim is involved.

The kernel is built with `CONFIG_INET=y`, but native INET does not register a
second public family. The versioned Linux patch exposes only a kernel-internal
factory which the PVM facade invokes after choosing local transport. A stable
outer socket and callback bridge preserve poll/epoll registrations made before
that choice. Broker capabilities are allocated lazily, so a loopback-only
socket consumes neither a ring entry nor one of the 128 host capabilities.

The runtime allocates two 256 KiB mappings for every VM clone:

| GPA | KVM permission | Contents |
|---|---|---|
| `0x100000000` | guest read/write | request producer, response consumer, guest event indices, requests, TX slots |
| `0x100040000` | `KVM_MEM_READONLY` | config, host cursors/event indices, completions, RX slots |

The regions begin above the loader's maximum contiguous RAM range, so 1--3 GiB
agent profiles cannot overlap the clone-private device slots. Immutable PMEM
root images start at 8 GiB and remain disjoint from both mappings. The sole
virtio-blk MMIO page sits in the reserved gap at `0x100100000`.

Neither mapping belongs to sealed template RAM, so clones never inherit mailbox
ownership or data through COW. The broker is woken by `HC_SERVICE_NOTIFY`; it
wakes the guest through one eventfd-backed GSI 10 capability. Interrupts are
only hints. Both sides always re-read their ring cursor.

Wire ABI v6 is a hard cutover: older descriptors are rejected so both peers
agree on the four-slot connection limit and notification suppression. Four
wrapping 32-bit event indices independently arm request availability, response
availability, request credit, and response credit. A producer notifies only
when it crosses the peer's requested index; the consumer publishes its arm
before rechecking the producer, closing the classic arm/sleep lost-wakeup race.
Both halves use a full Store-to-Load barrier between publishing their cursor
and sampling the peer's event index. Release/Acquire alone is insufficient:
both peers could otherwise observe the other's previous value and go to sleep.
Normal ring consumption therefore creates no reverse credit notification unless
the producer actually blocked on a full ring. These fields are untrusted hints:
they never authorize a cursor, descriptor, address, length, or capability.
The guest also amortizes request doorbells across concurrent stream
`sendmsg(2)` calls. A lone sender retains the immediate-notify path; once more
than one sender is active, each call may publish several fixed 4-KiB TX
descriptors before issuing the already existing `HC_SERVICE_NOTIFY`. Pending
work is always notified before waiting for request-ring or TX-slot credit,
before returning `EAGAIN`, and before leaving `sendmsg(2)`. This batching adds
neither a timer nor a wire field, hypercall, interrupt, or host-side parser.
Host readiness is retained
in a software queue because Mio uses edge-triggered
polling. Each runnable connection receives a two-operation quantum and is then
placed at the tail, so consuming a readiness edge cannot strand work beyond a
fixed budget. Every connection may own at most four TX and four RX slots; RX
waiters are resumed fairly when either global or connection credit returns.
Blocking guest TX allocation uses an ordered waiter queue, so a hot connection
cannot repeatedly steal a newly freed global slot from a queued connection.
The guest reports `EPOLLOUT` only when connection credit, a global TX slot, and
request-ring space are all available. Consequently blocking sockets, nonblocking
`EAGAIN`, `poll`/`epoll`, and Linux async runtimes all observe the same bounded
backpressure. A guest blocked by a full request ring explicitly arms one credit
IRQ, so it cannot depend on an unrelated socket completion.

TCP TX keeps latency-sized payloads of at most 1 KiB as private host snapshots.
Larger opaque payloads are sent directly from the already validated fixed G2H
slot, avoiding one allocation and one extra host-userspace copy per 4 KiB. The
mailbox state retains ownership until `send(2)` has accepted the complete
range; partial writes advance only host-private offset/remaining state. Connect
endpoints and DNS messages always remain private copies because they influence
policy or parsing. A compromised guest may mutate its own large TCP payload
while a send is in progress, but cannot change the private capability, socket
fd, destination, slot, offset, or length selected by the broker.

The maintained kernel pins `CONFIG_IO_URING=y`; its socket operations reuse the
same nonblocking protocol and poll hooks. The live smoke below covers the
edge-triggered epoll path; opcode-by-opcode io_uring conformance remains a
separate test target rather than an unqualified compatibility claim.

Mio registration tokens are host-owned, monotonic, and never reused during a
worker lifetime. Their table value is the complete capability generation, not
just its index, so an event already copied out of `epoll_wait` cannot be applied
to a close-and-reopen at the same index. The bounded completion backlog also
reserves worst-case event space before consuming work. If a guest stops
advancing its completion consumer, only that clone's broker pauses; the worker
does not exit and the queue cannot grow without bound.

Host-to-guest TCP is explicit and lazy. `PvmLinuxInstance::socket_ingress()`
returns a cloneable host handle; `connect_tcp(port)` constructs a private host
endpoint, while `inject_tcp(stream, port)` transfers an IPv4 TCP stream already
accepted by a front end. Guest `listen(2)` creates no host fd and no reactor
registration. Only an explicit call stages an offer, and only guest `accept(2)`
attaches it to a fresh broker capability. ACK, reject, accept, cancel, pending
generation and clone session use the existing fixed descriptors. The combined
host-command and pending population is capped at 32 per clone, each listener
queues at most 16, and guest lookup scans at most 128 registered listeners. No
new GPA, IRQ, hypercall, variable-length parser, PCI device, or host port
listener was added.

The submission layer is executor-independent and nonblocking.
`begin_inject_tcp[_with_timeout]` immediately returns an `IngressOperation`
implementing `Future`; `inject_tcp_async`, `inject_tcp_with_timeout_async`, and
`connect_tcp_async` are convenience async forms. The original synchronous
methods remain compatibility wrappers that block only their caller. Each
pending offer reserves its own cancel-completion slot, so a guest that stops
consuming completions cannot suppress the broker-owned deadline. Dropping a
future merely detaches that waiter; the five-second default deadline still
reclaims the stream and per-clone permit.

`AllowAll` and `DenyAll` are explicit policies alongside TCP and DNS
allowlists. The high-level `Engine` convenience APIs select unrestricted
egress by default; their policy variants can narrow or disable it per clone.
Even with `AllowAll`, a DNS capability can reach only IPv4 UDP port 53 and the
broker accepts only bounded, structurally validated A/AAAA queries. It is not
a general UDP proxy. Raw sockets, other UDP, DNS-over-TCP, UDP ingress, TLS
interception, and HTTP parsing are absent. Host TCP ingress exists only through
the typed, explicit per-sandbox handle; guest listeners are never host-published
by default.

The maintained rootfs uses `192.0.2.53` as a deterministic guest-only DNS
alias. The broker maps only that reserved address to the first IPv4
`nameserver` in the host's bounded `/etc/resolv.conf`; all other resolver
addresses pass through unchanged when authorized by policy. The one exception
is `127.0.0.1:53`, which glibc and musl use when `resolv.conf` is absent or
empty: because UDP loopback is not implemented, it is treated as the
same host-resolver alias. This keeps both new and existing shared EROFS images
portable across hosts without exposing a guest-selected path.

TCP `127/8` is always sandbox-local. Code that intentionally needs the host's
loopback TCP endpoint uses the guest-visible `192.0.2.1` alias; policy is
checked against that alias first, then the broker replaces only its address
with host `127.0.0.1`. This special case changes no mailbox field or parser.

Verification:

```text
cargo test -p pvm-stream-mailbox -p pvm-socket-service
cargo clippy -p pvm-stream-mailbox -p pvm-socket-service --all-targets -- -D warnings
cargo xtask pvm-linux configure
cargo xtask pvm-linux build
cargo xtask pvm-linux initramfs
cargo run -p minisandbox-core --example pvm_socket -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/minisandbox-initramfs.cpio

cargo run -p minisandbox-core --example pvm_socket_public -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/minisandbox-initramfs.cpio \
  <explicit-resolver-ipv4> example.com

cargo run -p minisandbox-core --example pvm_socket_ingress -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  target/pvm-linux/minisandbox-initramfs.cpio
```

The live smoke first proves cross-process guest loopback
`bind/listen/accept/connect/send/recv`, including an epoll registration made
before transport selection. It keeps a listener open across the warm
checkpoint and verifies it again after resume; success emits
`MINISANDBOX_PVM_LOCAL_TCP_OK` and
`MINISANDBOX_PVM_LOCAL_TCP_RESUMED_OK`. It then starts a host loopback server
behind the explicit alias and proves the broker round trip. It also refuses a nonblocking
connection and verifies generic Linux `SO_ERROR` consumption clears
`EPOLLERR`. Its stream test sends more than six fixed slots of deterministic
data and reads in 997-byte pieces, forcing RX slot reuse while older slots are
still queued. This catches any implementation that selects slots by numeric
index instead of TCP arrival order. Success includes
`MINISANDBOX_PVM_SOCKET_STREAM_FIFO_OK`, `MINISANDBOX_PVM_SOCKET_OK`, and
`MINISANDBOX_PVM_SOCKET_SO_ERROR_OK` on the guest console. The same smoke queues
almost four complete TX slots and immediately calls `close(2)`; the host must
receive every byte before FIN and the guest publishes
`MINISANDBOX_PVM_SOCKET_CLOSE_DRAIN_OK`.

The public smoke gives the guest only `<resolver>:53` plus the host-resolved
IPv4 addresses for `example.com:443`. The guest first resolves the name through
its native UDP socket and then exchanges a TLS ClientHello/ServerHello record
over its native stream socket. Success requires both
`MINISANDBOX_PVM_DNS_OK` and `MINISANDBOX_PVM_HTTPS_TCP_OK`.

The ingress smoke creates a listener and edge-triggered epoll registration
before the warm checkpoint, restores a clone with a fresh mailbox/session,
rejects one unbound port, then calls `connect_tcp` for the selected port. It
verifies host-to-guest and guest-to-host bytes plus accepted local/peer
endpoints and emits `MINISANDBOX_PVM_HOST_INGRESS_OK`.

`BrokerHandle::stats()` exposes monotonic host-only diagnostics for one clone:
doorbells, poll wakeups, fair-reactor turns, drained commands, published
events, injected guest IRQs, socket slots/bytes, and broker-thread CPU time.
The snapshot is lock-free and does not affect mailbox layout, policy, quotas,
or the guest-visible protocol. The standalone socket benchmark uses it to
separate a busy echo verifier from the broker and VM execution cost.

## Remaining attack surface

The mailbox parser is narrow, but networking is not free of host exposure:

- `AllowAll` is the product default. A guest can therefore originate IPv4 TCP
  from the host network namespace, including host-local, private-network, or
  metadata endpoints that routing permits. Deployments needing tenant egress
  isolation must supply allowlists or an outer network policy.
- The broker still exercises the host Linux TCP/UDP/IP stack. The fixed ABI
  removes arbitrary guest socket syscalls and fd access; it does not remove the
  kernel protocol stack's packet-processing attack surface.
- Native IPv4/TCP and loopback are additional code inside the untrusted guest,
  not host input parsers. Bugs there can compromise or crash that sandbox but
  do not widen the PVM host boundary. Raw sockets and native UDP remain
  unreachable through the public PVM family.
- One clone owns one worker thread, poller, IRQ eventfd, two 256 KiB mailboxes,
  at most 128 capabilities, and at most 16 DNS sockets. Each value is bounded
  locally, but clone admission and host-wide fd/thread/network quotas remain a
  runtime responsibility.
- A guest can deliberately flood `ServiceNotify`, open slow connections, or
  select a hostile port-53 peer. Per-turn quanta and bounded queues prevent
  memory growth and cross-connection starvation inside one worker, but CPU and
  bandwidth still need outer per-clone accounting.
- Large TCP TX intentionally does not provide an immutable payload snapshot:
  the guest-writable slot is the `send(2)` source until completion. This is not
  an authorization input and cannot redirect the host socket, but applications
  requiring payload integrity against a compromised guest kernel have no such
  trust boundary anywhere inside that guest.

The guest C provider remains untrusted PVM state. Its waiter and socket bugs may
crash or deadlock that guest; host safety continues to depend on PVM isolation,
`KVM_MEM_READONLY` enforcement for H2G, and revalidation of every G2H cursor,
descriptor, capability, range, and policy decision in Rust.
