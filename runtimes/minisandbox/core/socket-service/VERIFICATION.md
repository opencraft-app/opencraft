# Verification notes

The pure ownership/cursor layer remains in `../stream-mailbox`, with its TLA+
model, Kani harnesses, transition tests, and cargo-fuzz target. This adapter adds
tests at the unsafe shared-memory boundary:

- separate allocations do not share mailbox state;
- a Release-published descriptor is observed by an Acquire drain;
- producer and consumer jumps beyond the 64-entry bound fail closed;
- a response descriptor is initialized before its Release producer cursor;
- event-index crossing coalesces repeated publications, handles `u32` wrap,
  and rechecks work published concurrently with notification arming; the live
  10,000-RR stress specifically covers the Store-to-Load lost-wakeup race;
- response credit is armed only while the completion ring is full; adversarial
  event indices can affect only that guest's notification hint, not host cursor
  ownership or publication bounds;
- unrestricted, deny-all, and exact-allowlist policies make the expected
  independent TCP and DNS decisions;
- a real nonblocking loopback TCP broker completes connect, private 4-byte TX,
  direct 4-KiB shared-slot TX, direct-slot RX, and IRQ-notifier publication;
- raw shared TX pointers reject an out-of-range slot and every offset/length
  combination that crosses one fixed slot;
- the real PVM guest verifies a deterministic stream larger than six RX slots
  in deliberately unaligned 997-byte reads, forcing slot release/reuse and
  proving that delivery follows event FIFO order rather than slot number;
- a guest `send(2)` immediately followed by `close(2)` preserves almost four
  complete TX slots; the broker publishes TX completions before CLOSED, the
  peer receives the exact deterministic tail, and only then observes FIN;
- one retained readiness edge drains multiple fixed quanta, then resumes after
  RX credit is released without requiring a second host edge;
- two simultaneously readable TCP connections alternate by reactor quantum;
- after all 32 RX slots are occupied, released global credit goes to the queued
  ninth connection before returning to a connection already at its quota;
- the host rejects a fifth connection-local TX slot even if a compromised guest
  bypasses the Linux provider's matching four-slot limit;
- pre-v6 descriptors are rejected after the ABI v6 hard cutover;
- bounded host ingress tests cover offer, ACK, child-capability accept,
  direct-slot RX, TX completion, timeout/cancel, and a single admission counter
  shared by queued and staged streams; an executor-independent operation is
  polled and woken exactly once, an unresponsive clone does not occupy another
  clone's waiter, and timeout/cancel completes even when all remaining event
  capacity is reserved;
- dropping or explicitly cancelling an ACKed ingress operation emits one
  bounded cancel, removes it from the guest listener queue, returns the permit,
  and advances the pending generation; stale ACKs cannot target its replacement;
- 64 host injection racers starting concurrently with broker/clone teardown all
  complete as `BrokerStopped` or `Capacity`, and a handle retained from the
  destroyed clone cannot submit into a fresh clone;
- an active-FD quota rejects before host socket creation, the pending-offer
  quota counts both command-channel and staged ownership, and independent
  aggregate ingress/egress token buckets retain edge readiness until a
  host-computed refill deadline;
- peer FIN preserves the reverse direction, guest `SHUT_WR` drains queued TX
  before FIN and makes later send return `EPIPE`, and abortive peer RST closes
  both directions and recycles the capability;
- stale host poll tokens cannot target a reopened capability index;
- a full bounded completion backlog stops consuming requests and resumes after
  guest credit returns instead of terminating the worker;
- malformed DNS, unsupported query types, non-53 UDP destinations, unlisted
  resolvers, duplicate transaction IDs, and unmatched responses fail closed;
- a real nonblocking UDP loopback round trip exercises fixed-slot query and
  direct-slot response ownership.

The pinned guest kernel build checks the C ABI and hidden native INET API
surface. The `pvm_socket` example is the integration check for actual
KVM memslots, irqfd/GSI delivery, the guest IRQ handler, syscall transparency,
and the Rust broker. Its TCP exchange uses `SOCK_NONBLOCK` and edge-triggered
`epoll` for asynchronous connect, send, and receive; a refused connection also
checks the generic Linux `SO_ERROR`/`EPOLLERR` contract. A fresh writable guest
also completed `apt-get update`, including signature and hash verification of a
9.67 MB Packages index, after the RX FIFO change. The normal CPython
warm-clone example additionally proves
that adding fresh mailboxes does not break warm checkpoint restore or RAM COW.
The separate `pvm_socket_ingress` smoke registers an EPOLLET listener before a
warm checkpoint, rejects an unbound target, restores a clone, injects a typed
IPv4 stream, and verifies both byte directions after guest `accept(2)`.

## ABI v6 lifecycle, quota, and long-connection regression

On 2026-08-17, the current ABI v6 kernel and host were exercised through the
real PVM boundary. The `pvm_socket` example restored a warm clone, verified
directional FIN, ordered `SHUT_WR`, post-shutdown `EPIPE`, abortive RST, and a
64-KiB/s aggregate token bucket with a 4-KiB burst in both directions. The
`pvm_socket_ingress` example additionally raced 64 injectors against actual
`PvmLinuxInstance` destruction, proved the old handle terminal, then completed
cancellation and a bidirectional exchange on a fresh clone.

`../benchmarks/pvm-linux-socket-long` uses Hyper and Tokio-Tungstenite against
one warm clone containing a bounded C `EPOLLET` reactor. It completed 48
simultaneous capabilities: 16 HTTP/1.1 keep-alive connections with 64 requests
each, 16 SSE streams with 512 fixed 512-byte events each, and 16 WebSockets
with 64 masked 256-byte echo messages each. Eight SSE clients stopped reading
after response headers and were not released until all other 40 connections
finished. The guest reported:

```text
MSLONG_RESULT accepted=48 completed=48 send_eagain=6167 recv_eagain=2080
```

This proves application-level slow consumers exercise bounded backpressure
without connection-level head-of-line blocking. The test also retains at most
eight ingress admission permits until application handshake, because an ACK
means kernel queueing rather than application `accept(2)` readiness.

The expanded `../stream-mailbox/fuzz/fuzz_targets/protocol.rs` covers arbitrary
guest command and host event descriptors, endpoints, wrapping ring cursors,
and capability/slot/reset transitions. A 200,000-execution ASan-instrumented
run completed without crash or invariant failure (`cov=494`, `ft=2487`).

## ABI v5 notification measurements

On 2026-08-16, clean detached worktrees at `a892810` (ABI v4) and `3345552`
(ABI v5) were built with their matching host binaries and kernels. The same
EROFS workload ran for three seconds per sample, five times per version, with
the version order reversed on alternating rounds. The table reports medians:

| Offered load | Metric | ABI v4 | ABI v5 | Change |
|---:|---|---:|---:|---:|
| 1,000 RR/s | guest doorbells/RR | 3.610 | 1.987 | -45.0% |
| 1,000 RR/s | guest IRQs/RR | 2.988 | 1.634 | -45.3% |
| 1,000 RR/s | total host CPU | 1.013 s | 0.780 s | -23.0% |
| 1,000 RR/s | broker CPU | 0.197 s | 0.146 s | -25.9% |
| 1,000 RR/s | p50 / p99 / p999 | 182 / 234 / 305 us | 146 / 189 / 263 us | -20% / -19% / -14% |
| 5,000 RR/s | guest doorbells/RR | 3.989 | 1.497 | -62.5% |
| 5,000 RR/s | guest IRQs/RR | 2.486 | 1.975 | -20.5% |
| 5,000 RR/s | total host CPU | 4.126 s | 4.020 s | -2.6% |
| 5,000 RR/s | broker CPU | 0.753 s | 0.652 s | -13.4% |
| 5,000 RR/s | p50 / p99 / p999 | 142 / 210 / 381 us | 127 / 183 / 339 us | -11% / -13% / -11% |

The earlier one-shot 5,000 RR/s sample showed worse p99/p999, but that result
did not repeat in any of the five clean paired rounds. It was measurement noise
compounded by a build tree that also contained the then-uncommitted idle-wait
experiment, not a stable ABI v5 regression.

Five paired 16 MiB stream rounds also improved median TX from 70.5 to 91.3
MiB/s and RX from 79.2 to 112.5 MiB/s, while total host CPU fell about 25% in
both directions. Three paired four-clone rounds sustained the requested 4,000
aggregate RR/s; median total host CPU fell 21%, broker CPU fell 16%, and the
worst clone p99 fell 23%. No delay timer is used for any notification
coalescing. The no-watchdog lost-wakeup stress additionally completed 50,000
unpaced RR exchanges (102,005 commands).

## Hybrid TCP TX measurements

On 2026-08-16, the private-copy baseline at `107e3bb` was compared with the
hybrid TX implementation using one matching ABI-v5 kernel and one immutable
EROFS. Runs alternated order. Payloads up to 1 KiB retain the baseline private
snapshot path; a 4-KiB stream slot is sent from its validated G2H mapping while
the ownership state machine keeps it host-owned. Medians were:

| Workload | Metric | Private copy | Hybrid TX | Change |
|---|---|---:|---:|---:|
| 1 connection, 16 MiB | throughput | 94.55 MiB/s | 106.46 MiB/s | +12.6% |
| 1 connection, 16 MiB | total host CPU | 246.6 ms | 204.9 ms | -16.9% |
| 1 connection, 16 MiB | broker CPU | 53.7 ms | 28.8 ms | -46.3% |
| 8 connections, 32 MiB aggregate | throughput | 168.2 MiB/s | 184.6 MiB/s | +9.8% |
| 8 connections, 32 MiB aggregate | total host CPU | 363.6 ms | 313.5 ms | -13.8% |
| 8 connections, 32 MiB aggregate | broker CPU | 100.9 ms | 60.2 ms | -40.4% |
| 4 clones, 32 MiB aggregate | throughput sum | 156.6 MiB/s | 170.2 MiB/s | +8.7% |
| 4 clones, 32 MiB aggregate | total host CPU | 673.6 ms | 627.3 ms | -6.9% |
| 4 clones, 32 MiB aggregate | broker CPU | 152.1 ms | 97.6 ms | -35.8% |

The 8-MiB slow-receiver case remained receiver-limited at about 27.8 MiB/s,
while median host CPU fell 19.2% and broker CPU fell 51.1%. Every stream and
every clone reported the exact deterministic checksum and expected TX slot and
completion counts. The 32-byte 5,000-RR/s path stays below the threshold and
retains the original private-copy/`Write` behavior; paired samples remained in
the same CPU and latency noise band.

The optimization adds no descriptor field, hypercall, fd, event type, queue,
or allocation derived from untrusted lengths. Its additional unsafe boundary
returns only a fixed-mapping raw pointer after checking slot and range on every
send attempt. Policy-bearing endpoints and DNS bytes are never read through
this path. In the 8-connection stream case faster completion increased median
doorbells from 498 to 963 and IRQs from 818 to 970 even though CPU fell; future
notification batching can target that separately without coupling it to TX
memory ownership.

## Concurrent stream doorbell batching

On 2026-08-16, the unbatched hybrid-TX kernel at `3dfc8fb` was compared with
the guest-only adaptive batching change. Both kernels used the same host
benchmark binary and immutable EROFS. The workload order alternated and the
table reports medians from five paired 32-MiB aggregate rounds:

| 8 concurrent connections | Unbatched | Adaptive batch | Change |
|---|---:|---:|---:|
| guest doorbells | 1,075 | 864 | -19.6% |
| guest IRQ injections | 985 | 863 | -12.4% |
| host poll wakeups | 1,534 | 1,248 | -18.6% |
| throughput | 187.24 MiB/s | 193.33 MiB/s | +3.3% |
| total host CPU | 299.7 ms | 290.8 ms | -3.0% |
| broker CPU | 48.2 ms | 47.6 ms | -1.3% |

A deliberately slow receiver (2 ms after every 64 KiB) exercised TX-slot
backpressure for five paired 32-MiB rounds. It remained receiver-limited at
28.02 versus 28.05 MiB/s. Median host CPU was 342.3 versus 348.2 ms and broker
CPU was 43.8 versus 45.6 ms; notification counts were effectively unchanged
and the per-run CPU spread was larger than the median delta. This is why a lone
sender keeps the original immediate path instead of maximizing batching.

Three paired 32-byte runs at 5,000 RR/s retained 4,999.7 RR/s. Median p50 was
127.3 versus 127.5 us, p99 177.8 versus 174.1 us, and p999 250.9 versus 215.2
us; total host CPU changed by +0.3%. Three four-clone rounds, with one stream
per clone, changed aggregate throughput by -0.2% and host CPU by -0.6%, showing
that the guest-local sender count neither couples clones nor requires a shared
host batching coordinator. Every run produced the exact deterministic
checksum and expected descriptor, byte, and completion counts.

## Host-to-guest ingress measurements

On 2026-08-16, ABI v6 at `8c05e26` was measured on a four-vCPU AMD EPYC 7K83
host. The standalone socket benchmark created each guest listener before the
warm checkpoint, restored a clone, then connected through the public typed
ingress handle. Three rounds were run per row; the table reports medians and
compares the same mailbox data path with guest-initiated outbound TCP:

| Workload | Host ingress | Guest outbound | Change |
|---|---:|---:|---:|
| 1 connection, 32-byte saturation | 8,506.8 RR/s | 8,407.1 RR/s | +1.2% |
| 1 connection, p50 / p99 | 114.1 / 157.7 us | 116.7 / 158.3 us | -2.2% / -0.4% |
| 1 connection, total host CPU | 2.045 s | 2.057 s | -0.6% |
| 8 connections, aggregate | 23,822.7 RR/s | 23,774.6 RR/s | +0.2% |
| 8 connections, p50 / p99 | 292.9 / 735.1 us | 289.3 / 795.5 us | +1.2% / -7.6% |
| 4 clones, aggregate | 22,352.5 RR/s | 23,613.4 RR/s | -5.3% |
| Guest-to-host 16 MiB stream | 107.15 MiB/s | 101.97 MiB/s | +5.1% |
| Host-to-guest 16 MiB stream | 143.06 MiB/s | 144.31 MiB/s | -0.9% |

Ingress ACK latency was 0.446 ms for one connection, p50/p99 0.701/1.128 ms
for eight concurrent connections, and 0.837/1.730 ms at the one-listener limit
of 16. Four simultaneously restored clones measured 1.375/3.466 ms. The API
returns when the guest has queued the offer, before the application completes
`accept(2)`.

At an offered 1,000 RR/s, ingress used 1.328 seconds of total host CPU over
five seconds versus 1.316 seconds outbound; broker CPU differed by 2.7 ms.
At 100 RR/s it used 0.168 seconds total (3.35% of one core) and 31.6 ms broker
CPU, with p50/p99 170/249 us. A 2-ms-per-64-KiB slow receiver held 27.99 MiB/s
and completed with the exact checksum, demonstrating backpressure rather than
unbounded buffering in the mailbox path.

All descriptor counts and deterministic payload checks matched. A new hostile
guest test fills all 32 clone-local ingress permits without ACKs, observes an
immediate `Capacity` error on the 33rd stream, then proves every permit is
returned after timeout under the ordinary Rust test runner. The host submission
side now creates 32 pending futures without 32 waiter threads; the same fixed
ABI v6 descriptors, IRQ, and hypercall surface are unchanged.

## Concurrent batching security note

For the concurrent batching change above, no host code or protocol definition
changed. The guest merely changes when it
issues an existing notification hint, and flushes accumulated work before any
credit wait, nonblocking failure, or syscall return. A compromised guest could
already omit or flood this hint; the host still validates all cursors,
descriptors, capabilities, slots, offsets, and lengths, and continues to bound
each reactor turn. The change therefore reduces cooperative exits without
adding a guest-controlled parser or host resource.

The public-network integration example performs a guest-native UDP DNS query,
uses the returned A record for a guest-native TCP connection, and exchanges TLS
handshake records with a real HTTPS endpoint. On 2026-08-15, the development
host explicitly authorized resolver `9.218.233.133:53` and the two then-current
`example.com:443` IPv4 addresses. The guest reported:

```text
MINISANDBOX_PVM_DNS_OK 104.20.23.154
MINISANDBOX_PVM_HTTPS_TCP_OK
MINISANDBOX_PVM_LINUX_OK
```

This is a connectivity/transparent-byte-path test, not certificate validation.
The resolver and address set are environment/time dependent and are printed by
the example before every run.
