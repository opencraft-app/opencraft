# Phase 3 Warmed QuickJS Actor Turn

Status: implementation and full gate complete; final commit pending

| ID | Requirement | RED evidence | Passing gate |
|---|---|---|---|
| P3-01 | Pin an auditable QuickJS core without embedding it in the host | no JavaScript engine source or guest existed | 18 core files match upstream commit `04be2460` byte-for-byte |
| P3-02 | Build a bounded static Linux QuickJS guest | no QuickJS guest build existed | stripped 2,042,688-byte ELF parses under the existing loader contract |
| P3-03 | Evaluate deployment code exactly once before checkpoint | no Actor warm-up protocol existed | 32 children each observe the same initialized state and return `count: 42` |
| P3-04 | Resume a real Linux userspace image, including TLS and FP state | PVM resume captured only the cold entry state | warm checkpoint restores registers, FPU, FS base, stack, brk, and mailbox |
| P3-05 | Seal the live warmed heap into the existing 4 KiB COW substrate | Phase 2 could seal only a cold program image | writable live leaves are snapshotted to a sealed memfd and write-protected in both roots |
| P3-06 | Run one bounded JSON Actor turn per fork | no turn input/result protocol existed | real PVM children parse one input, invoke `handle`, emit one JSON result, and exit |
| P3-07 | Expose warm/fork/run-turn through the stable C ABI | ABI exposed only generic ELF run and cold template fork | generated ABI 1.2 header and live C ABI conformance pass |
| P3-08 | Bound guest and host-controlled payloads | no Actor-specific bounds existed | 64 KiB mailbox, 24 MiB QuickJS heap limit, 512 KiB JS stack, and 1 MiB output cap |
| P3-09 | Preserve isolation and reclaim child-private pages | warmed heap isolation was unproven | 32 turns remain identical and live-private data pages return to zero after every drop |

## Runtime model

- The host boots the static QuickJS guest once, supplies deployment source through
  a fixed mailbox, and services only a narrow static-libc syscall surface.
- The guest initializes QuickJS, evaluates deployment code, and performs a
  checkpoint hypercall. The host captures CPU/FPU/TLS state, snapshots the live
  64 MiB address space into a sealed memfd, and retains an immutable COW plan.
- Each Actor turn creates a child over the shared baseline, injects JSON input by
  the checkpoint return value and mailbox, then handles validated 4 KiB write
  faults with child-private pages. A child may run exactly once.
- Guest stdout is the single JSON result. Exit status, output, COW faults, and
  dirty-page count are returned through typed Rust and C interfaces.

## Security and density boundary

- RELRO pages removed from the writable COW plan during warm-up remain read-only.
- Deployment syntax/runtime failures do not publish a template. Unsupported
  syscalls return `ENOSYS`; host entropy comes from `/dev/urandom`.
- The final debug-host conformance run observed at most 27 private data pages
  (108 KiB) per QuickJS child; this excludes page tables, PVCS pages, VM/vCPU host
  state, and allocator overhead and is evidence, not a production RSS/PSS SLA.

## Deferred production work

This initial vertical slice does not yet pool/reset VM/vCPU objects, lazily map
the full baseline, implement an asynchronous Promise/event loop, connect a State
Broker/FDB transaction, enforce `RuntimeOptions.max_memory`, or benchmark a
release build under production concurrency. The installed legacy PVM ABI is
live-tested; modern ABI offsets remain encoded but cannot be exercised on this
host.
