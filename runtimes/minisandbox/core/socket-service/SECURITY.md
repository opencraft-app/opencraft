# Socket-service security boundary

## Trusted computing base

The guest application, guest kernel, PF_INET provider, both guest cursor words,
all request descriptors, TX bytes, and every hypercall argument are untrusted.
The host TCB for networking is limited to:

- PVM memslot and irqfd registration;
- this crate's ring snapshot/validation code;
- its bounded read of the fixed host `/etc/resolv.conf` path for the optional
  `192.0.2.53` guest DNS alias;
- the pure `pvm-stream-mailbox` cursor/capability state machine;
- the configured `ConnectPolicy`;
- Rust/mio and the host kernel TCP/UDP syscall implementation;
- the typed host ingress caller and each connected IPv4 `TcpStream` it
  explicitly transfers to a sandbox.

The broker holds TCP descriptors but no VM/vCPU descriptor. Its IRQ capability
can assert only the pre-registered GSI. The generic PVM layer knows no socket
opcode, endpoint, capability, or host file descriptor.

## Enforced invariants

- Every clone gets fresh anonymous G2H and H2G mappings.
- H2G is registered with `KVM_MEM_READONLY`; absence of
  `KVM_CAP_READONLY_MEM` fails clone creation.
- A guest producer may be at most 64 entries ahead of the host consumer.
- A guest response consumer may advance only through host-produced entries.
- Descriptor bytes are copied with volatile reads into a private array before
  decoding; guest memory is never borrowed as a Rust struct.
- Producer publication is Release and observation is Acquire on both sides.
- Four fixed `u32` event indices are notification hints only. Every arm is
  followed by a full-barrier Acquire recheck, and every producer uses the
  matching Store-to-Load barrier before sampling the event index. Cursor
  validation remains independent of whether an adversarial peer suppresses or
  requests a notification.
- One wake drains at most 64 requests; one readiness event performs at most
  eight socket I/O operations.
- Capability index and non-wrapping generation are checked independently of
  the host fd table. The clone session is host-private decoder context, not a
  guest descriptor field; every clone receives fresh non-COW mailbox mappings,
  so an old clone cannot publish bytes into a new clone's session.
- Data offset/length must fit one 4096-byte fixed slot. Per-stream outstanding
  TX and RX are each bounded to 16 KiB, while each complete directional
  mailbox contains at most 128 KiB of payload storage.
- The completion backlog is bounded. Cursor violations and backlog exhaustion
  terminate the broker for that clone instead of attempting recovery from
  attacker-selected state.
- TCP policy is checked before `TcpStream::connect`; DNS policy is checked
  before creating a connected UDP socket. The high-level runtime defaults to
  `AllowAll`; callers that need destination isolation must explicitly supply
  `DenyAll` or an allowlist.
- DNS is fixed to IPv4 UDP port 53, at most 16 DNS sockets per clone and eight
  outstanding transaction IDs per socket. Queries are at most 512 bytes and
  must contain exactly one IN/A or IN/AAAA question, optionally with one empty
  EDNS OPT record. Responses are source-filtered by connected UDP, bounded to one
  slot, structurally checked, and matched to an outstanding transaction ID.
- Only the fixed guest address `192.0.2.53` and the libc no-configuration
  fallback `127.0.0.1` are rewritten, and only to the first IPv4 `nameserver`
  in a host resolver file no larger than 16 KiB. Other DNS destinations are
  passed through exactly as requested after policy approval.
- Host ingress admits at most 32 streams total across the trusted command
  channel and pending table. An RAII permit returns quota on every rejection,
  timeout, worker shutdown, or successful attach. Pending IDs combine a fixed
  index and non-wrapping generation inside one clone-private broker/mailbox;
  stale ACK/accept/cancel messages cannot attach a stream twice, and an old
  broker handle cannot migrate to a new clone.
- Every staged ingress offer reserves one bounded completion slot for its
  eventual cancel. A full guest-controlled completion backlog therefore cannot
  suppress broker deadline processing; new host submissions fail fast with
  `Capacity` when an offer plus its cancellation cannot both be represented.
- Guest listeners do no host work. One listener holds at most 16 pending IDs,
  listener lookup examines at most 128 entries, and ambiguous reuse-port
  matches reject. Staged streams are not registered in Mio until a fresh child
  capability accepts them. Broker-owned deadlines complete both async and
  synchronous host APIs even when a malicious guest stops consuming the
  completion ring.
- Active TCP plus restricted-DNS host descriptors are admitted before host
  socket creation or child-capability attachment and are configurable only in
  `1..=128`. Aggregate per-clone TCP ingress and egress byte rates can each use
  a host-private fixed-point token bucket with a bounded burst. Rate-blocked
  connections retain edge readiness in a bounded queue and resume at the next
  host-computed refill deadline without guest timers or busy polling.
- TCP EOF is directional: peer FIN retains guest-to-peer TX until guest close
  or `SHUT_WR`; guest `SHUT_WR` drains already accepted TX before issuing host
  FIN. Abortive reset terminates both directions and reclaims the capability.
- Socket readiness is served through a bounded round-robin queue. A hot or
  slow connection receives at most one fixed quantum per turn before another
  ready connection can run.

## Host integration obligations

- `SocketIngressHandle` is a trusted host capability. Async servers should use
  `connect_tcp_async`, `inject_tcp_async`, or await the `IngressOperation`
  returned by `begin_inject_tcp`; these waits occupy no executor thread. The
  original `connect_tcp` and `inject_tcp` methods intentionally remain
  synchronous and may block their caller for the bounded offer deadline (five
  seconds by default).
- The handle may target any nonzero guest TCP port. Port selection is trusted
  host routing input, not guest authority and not a broker security policy.
  Guest code cannot obtain the handle or publish a listener by itself.
- Dropping an incomplete `IngressOperation` is cancellation. The broker closes
  the stream, returns its permit, advances the pending generation, and emits a
  bounded guest-visible cancel when an ACKed offer must be removed from a
  listener queue. `cancel()` provides the same operation explicitly.
- An ingress ACK means only that the guest kernel queued the offer; it does not
  prove application `accept(2)` or protocol readiness. A gateway admitting a
  burst larger than the bounded listener queue must retain its own admission
  permit until application-level handshake or otherwise retry a rejected
  offer. This prevents host concurrency from turning into an unbounded guest
  accept queue.
- The 32 pending and 128 active limits are per clone. Fleet admission must also
  cap aggregate clones, workers, file descriptors, and host TCP socket-buffer
  memory. Mailbox backpressure bounds shared slots but cannot replace those
  host-wide budgets.

## Copies and zero-copy

Small guest TX is copied into host-private memory before `send(2)`. Full-slot
stream TX may instead pass a validated raw G2H range to `send(2)` while the
ownership state machine keeps that slot host-owned. No Rust reference is
created and no policy-bearing endpoint or DNS input uses this path; a malicious
guest may race only its own opaque TCP payload contents. RX uses `recv(2)`
directly into an H2G fixed slot. KVM prevents guest writes, and the slot is
published only after the syscall completes, so host-kernel-to-guest RX has no
intermediate userspace copy. UDP DNS uses the same direct RX path after an
eight-byte host-authenticated source-endpoint prefix.

## Explicitly out of scope

This provider does not promise isolation of applications from their own guest
kernel. It does not publish guest ports into a host namespace, accept arbitrary
host fds, provide UDP ingress or arbitrary UDP, parse or enforce HTTP/TLS,
provide DNS-over-TCP, resolve recursively itself, or emulate every Linux socket
option. The initial ingress ABI accepts connected IPv4 TCP only. Authorizing
DNS permits DNS-name exfiltration to the
authorized resolver; the structural and size limits bound the transport but do
not make DNS a content policy. Stronger tenant policy requires a separate
resolver/proxy. None of these features belong in the generic hypercall handler.
