# minisandbox Compatibility Boundary Map

## Fixed product boundary

- New project and API: `minisandbox`.
- Production implementation: Rust only.
- Host/guest target: Linux x86_64 PVM only.
- Compatibility target: observable runtime behavior, not host API or internal
  source structure.
- Host integration: new stable C ABI with generated C header.

## Must-preserve behavior

- Program loading and x86_64 userspace startup.
- Syscalls, memory mappings and faults, file descriptions, futexes, clocks,
  threads, and signals required by the conformance workloads.
- Quiescent checkpoint, immutable baseline, COW clone, reset, and snapshot.
- In-process address-space links, SMP, portable snapshots, host seccomp, and RSP
  behavior.
- Non-cooperative scheduling: a pure-compute guest task cannot starve another
  runnable task on the same PVM vCPU.

## New contracts

- Runtime/program/instance/checkpoint ownership model.
- Versioned opaque C ABI with `minisandbox_` symbols.
- Typed safe PVM run outcomes.
- Explicit checkpoint policy for every host resource.
- Audited unsafe boundary limited to PVM/kernel and FFI mechanics.
- Process-local 64-bit registry handles; only sealed seeds, snapshot descriptors,
  and program bytes cross process boundaries.
- Caller-owned snapshot descriptors with explicit resource rebinding keys.
- Macro-first contract tables for ABI, syscalls, registers, lifecycle, resources,
  snapshots, and test matrices to minimize hand-written Rust lines.

## High-risk boundaries

- PVM event/PVCS context capture during asynchronous interruption.
- Page-table and data-page ownership during SMP COW faults.
- Signal delivery versus checkpoint publication.
- Cross-process clone without inherited kernel vCPU handles.
- Address-link/snapshot representation of host-backed resources.

## Verification hooks

- Black-box guest fixture comparison.
- Dedicated timer-preemption gate.
- COW isolation and reset stress.
- SMP shootdown and freeze-rendezvous stress.
- Generated-header C compiler tests.
- Deno-style and server-style integration workloads.
