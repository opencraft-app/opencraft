# Architecture Recommendation

Build an independent Rust implementation with one x86_64 PVM backend and a new C
ABI. Do not translate the previous class model and do not build a C++ facade.

Contain kernel and foreign-function unsafety in `minisandbox-pvm-sys` and the
narrow C entry layer. Keep runtime policy, guest semantics, scheduling, memory,
and checkpoint logic in safe Rust. Model freeze/preemption/signal delivery as a
shared task-stop protocol so they cannot evolve into inconsistent context-save
paths.

The project fails its goal if it requires cooperative guest yields, shares
mutable page-table roots between clones, inherits process-local PVM vCPU handles,
or exposes Rust/kernel layouts through the C ABI.

Host handles remain process-local and are generation-checked. Cross-process
creation imports a sealed checkpoint seed or portable snapshot descriptor into a
new runtime. Guest-to-guest linked-call behavior is modeled as an in-process
address link rather than a network protocol. Snapshot restore requires explicit rebinding
for every host resource or address link that cannot be serialized.

Use a dedicated macro crate and macro-first declarative contracts to compress
hand-written Rust. Generate ABI glue, syscall/register tables, state transitions,
resource policy, snapshot codecs, and conformance matrices; keep unsafe lifetime
assumptions, lock ordering, PVM run ownership, and scheduler selection explicit.

The approved design is recorded in
`docs/design/2026-08-14-minisandbox-x86_64-pvm-design.md`.
