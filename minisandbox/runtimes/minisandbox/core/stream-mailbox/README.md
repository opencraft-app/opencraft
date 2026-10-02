# PVM fixed-slot stream mailbox prototype

This crate is the executable protocol core for the minisandbox stream
transport. It is part of the top-level workspace, but does not yet map guest
memory or touch a host socket.

The design assumes the complete guest is malicious. Shared indices,
descriptors, capabilities, generations, lengths, and release notifications are
therefore copied and validated rather than represented as borrowed Rust data.

## Layout and zero-copy boundary

Each clone receives fresh non-COW memory containing two
descriptor rings and separate fixed RX/TX pools. Host `recvmsg` may target an RX
slot directly. The adapter snapshots small guest-writable TX; for full-slot
opaque TCP payloads it may instead pass a range-checked raw pointer to
`send(2)` while the ownership model keeps the slot host-owned. It never creates
a Rust reference, and policy-bearing endpoint/DNS bytes always take a private
snapshot. An unmodified POSIX application still requires one guest-kernel
`copy_to_iter` or `copy_from_iter`; direct slots remove only an additional
broker staging copy.

The model proves/checks the safety-critical ownership layer consumed by the
atomic ring and socket adapter in `../socket-service`:

- every slot has one modeled owner;
- capability index, 64-bit non-wrapping generation, and host-bound clone/reset
  session must match;
- per-stream TX/RX byte credits remain bounded;
- rejected transitions leave the complete state unchanged;
- reset refuses to finish while any host operation owns a slot;
- late receive completion during close/reset is dropped;
- untrusted producer/consumer indices cannot advance beyond real work.

## Wire ABI v6

Every guest-to-host command is exactly 32 bytes. The descriptor carries a
32-bit capability-table index and a 64-bit generation. It deliberately does
not carry a clone/session value: the host supplies its current nonzero 64-bit
session to `Command::decode`, so decoded commands can name only capability
objects in that host-side state. This does not make raw descriptor bytes
self-authenticating. Cross-clone replay is prevented by fresh non-COW mailbox
mappings and clone-bound host handles; stale commands within one mailbox are
rejected by the non-wrapping generation.

Capability generations never wrap. A table entry reaching `u64::MAX` is
permanently retired. A session reaching `u64::MAX` refuses reset without
mutating state. This fail-closed behavior removes the previous ABA path while
keeping the descriptor at 32 bytes.

ABI v3 added one canonical `DnsQuery` opcode, and ABI v4 made the
four-slot-per-connection credit contract mandatory. ABI v5 retains the same
32-byte descriptor shape and adds notification event indices to the surrounding
mailbox header; older descriptors are rejected so both peers use the race-free
suppression protocol. ABI v6 additionally defines canonical fixed-width ingress ACK,
reject and accept commands. ACK/reject identify a bounded pending entry; accept
carries a fresh child capability plus the independently generation-checked
pending ID. No pointer, fd, address length, or variable-sized command was
added. A DNS fixed slot begins with the
socket service's eight-byte IPv4 endpoint followed by one bounded DNS payload.
The generic ownership model still knows only slot/capability/credit state; DNS
port, resolver policy, parsing and transaction matching remain in the separate
socket-service boundary.

## Source layout

- `src/protocol.rs`: pure capability/credit/slot/reset transition system;
- `src/cursor.rs`: host-private wrapping cursors validating peer indices;
- `src/wire.rs`: canonical 32-byte little-endian command decoder;
- `tests/`: lifecycle, rejection-atomicity, wraparound, and bounded state search;
- `fuzz/`: guest command and host event descriptor decoders, endpoint parser,
  adversarial wrapping ring cursors, and capability/slot/reset transition
  sequences under libFuzzer;
- `model/`: a small TLA+/TLC model for ownership/reset interleavings;
- `src/proofs.rs`: Kani harnesses against the production transition functions.
- `VERIFICATION.md`: exact checks already run and the remaining proof boundary.

## Checks

```text
cargo fmt --all -- --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
cd fuzz && cargo +nightly fuzz run protocol
cargo kani
java -jar tla2tools.jar -config model/StreamMailbox.cfg model/StreamMailbox.tla
```

Kani performs bounded model checking of the real Rust transition functions.
TLC exhaustively explores the configured finite protocol model. Fuzzing remains
necessary because neither proves the mapping/socket adapter or the host
kernel.

## Existing Rust implementations considered

`rust-vmm/virtio-queue` is production-grade infrastructure for general split
virtqueues, but deliberately accepts arbitrary guest address/length descriptor
chains and leaves memory validation to each device. Firecracker's Rust
virtio-vsock implementation is the best reference for credit and connection
semantics, but is still a complete virtio device. In-process queues such as
`ArrayQueue`, `ringbuf`, and `bbqueue` assume a cooperative Rust peer and do not
define reset epochs or a malicious shared-memory ABI.

This prototype therefore keeps the state machine project-specific and small.
The runtime adapter reuses this project-specific state machine rather than a
trusted-process queue abstraction.
