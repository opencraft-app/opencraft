# PVM stream-service implementation record

## Pinned inputs

- minisandbox socket baseline: `939247d`
- Linux PVM repository: `https://github.com/loopholelabs/linux-pvm.git`
- Linux branch: `pvm-v6.7`
- Linux base commit: `51ee0edb884b3372c168f58244de58507c99b2f7`
- existing guest patches: `0001` decompressor identity map, `0002` no-PCI PMEM registration

The exact external source, patch hashes, overlay hashes and replay order remain
authoritative in `guest/pvm-linux/source.toml` and
`guest/pvm-linux/patches/series`.

## Implemented boundary

Hypercall ABI v1 reserves `ServiceNotify = 6` (`0x4d53_0106`). The guest passes
only a queue-set bitmask in RDI. The low-level PVM runner samples RDI once,
rejects zero and unknown bits, and returns a typed `PvmExit::ServiceNotify`.
The only currently valid bit is the guest-to-host fixed command ring.

Mailbox wire ABI v6 retains the fixed 32-byte descriptor shape, makes the
four-TX-slot contract mandatory, and adds four fixed event indices to the ring
headers. It also adds bounded ingress ACK/reject/accept commands: the pending
identity is fixed-width and generation checked, while accepted streams receive
an ordinary fresh capability. An older peer is rejected instead of running
without the complete notification and ingress contract:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 2 | ABI version |
| 2 | 2 | opcode |
| 4 | 4 | capability index |
| 8 | 8 | non-wrapping capability generation |
| 16 | 2 | fixed-slot index |
| 18 | 2 | flags; currently zero |
| 20 | 4 | slot offset |
| 24 | 4 | length |
| 28 | 4 | command sequence |

Clone/reset session identity is host-owned and supplied to the decoder rather
than read from the descriptor. Capability generations retire on exhaustion;
sessions fail reset on exhaustion. Neither silently wraps.

Request/event availability and their two reverse credit channels each use one
wrapping `u32` event index. Producers notify only when crossing an armed index;
consumers arm before a full-barrier Acquire producer recheck, while producers
publish their cursor before the matching full-barrier event-index load. The
indices are hints rather than cursor authority, so a malicious guest can delay
or amplify only its own notifications and cannot bypass any ring bound.

## Implemented security gates

1. Fresh non-COW mailbox backing and a unique nonzero session for every clone.
2. Acquire/release atomic ring implementation with directionally writable pages.
3. A fixed per-notify drain budget, retained readiness queue, per-connection
   quantum, fair guest TX waiters, and explicit TX/RX credit backpressure.
4. Non-reused host registration tokens map poll events to a complete
   capability generation, so a stale event cannot target a reopened index.
   Descriptors still carry index/generation and decoding supplies the clone
   session.
5. Connection, DNS transaction, ingress, byte, slot and completion quotas owned by the host.
6. Warm checkpoints reject service traffic; every restored clone receives a
   new mailbox, session, broker and descriptor table.
7. The bounded host completion backlog reserves worst-case space before
   consuming requests or readiness. A slow guest pauses its own broker until
   it advances the completion consumer; it cannot terminate the worker or grow
   host memory without bound.
8. Host ingress is explicit and lazy: 32 RAII admission permits cover both the
   trusted command queue and pending table, no guest listener opens a host fd,
   and Mio registration occurs only after a generation-checked guest accept.

The Linux PF_INET provider, atomic mapping, service IRQ and Rust broker now live
under the independent `socket-service/` boundary. The provider is a hashed
source overlay copied into generated `net/pvm_socket/`; it is intentionally not
hidden as an edit to the pinned kernel tree. TCP destinations and UDP DNS
resolvers have independent default-deny policies. The DNS opcode cannot reach
non-53 UDP, and the provider exposes no general UDP or guest TCP/IP stack.
