# minisandbox x86_64 PVM Architecture

Status: approved by user for implementation

Date: 2026-08-14

## 1. Objective

`minisandbox` is a new Rust runtime for executing unmodified Linux x86_64
userspace programs inside PVM-isolated address spaces. It must provide the full
runtime behavior required by the reference PVM workloads while exposing a new,
stable C ABI.

The implementation is independent:

- no C++ source, build dependency, adapter, namespace, or public type is kept;
- no source-level translation is used;
- compatibility is defined by observable behavior, the published PVM ABI,
  executable fixtures, and black-box conformance tests;
- project names, Rust modules, ownership rules, and the C API are new.

This is a cleanroom-style engineering boundary. It is not represented as a
legal clean-room implementation because the engineering team has previously
inspected the reference implementation.

## 2. Scope

### In scope

- Linux x86_64 hosts with the required PVM kernel capability.
- x86_64 guest userspace execution and PVM event/PVCS/return semantics.
- ELF loading and guest process startup.
- Guest virtual memory, page tables, demand mapping, faults, and copy-on-write.
- Linux syscall, file descriptor, futex, clock, process, and memory behavior
  needed by the conformance workloads.
- Guest threads, signals, timers, host-driven time slicing, and preemption.
- One or more PVM vCPUs, SMP scheduling, and cross-vCPU coordination.
- Freeze, immutable checkpoints, fast COW spawn, reset, and snapshots.
- In-process address-space links that let one guest call exported code in a
  second guest, including transient, permanent, reverse, and resume behavior.
- Seccomp policy support and an RSP debugging endpoint.
- A stable C ABI generated from Rust declarations.
- Deno- and server-style integration workloads as release gates. The runtimes
  themselves are consumers and are not vendored into this repository.

### Out of scope

- Hardware-KVM compatibility as a second backend.
- ARM64 or other guest architectures.
- A C++ API or compatibility facade.
- Kernel or device emulation that is not required by the userspace-runtime
  contract.
- Source or binary compatibility with any previous host API.

## 3. Chosen Architecture

The workspace has four implementation crates and one test package:

```text
minisandbox/
  crates/minisandbox-pvm-sys/   raw PVM, ioctl, mmap, signal ABI boundary
  crates/minisandbox-macros/    declarative and procedural code generation
  crates/minisandbox-core/      safe runtime and all guest semantics
  crates/minisandbox-capi/      versioned C ABI and generated header
  conformance/                  guest fixtures and black-box host tests
  include/minisandbox.h         generated, never hand-edited
```

`minisandbox-core` is divided into focused modules rather than many tightly
coupled crates:

```text
arch/x86_64     register model, PVCS conversion, event and return frames
engine          PVM run loop and exit/event classification
memory          address spaces, mappings, page ownership, faults, COW
loader          ELF validation, layout, stack, TLS, and entry state
linux           syscalls, file descriptors, futexes, clocks, and signals
scheduler       tasks, run queues, vCPU assignment, blocking, and preemption
checkpoint      quiescence, immutable baselines, spawn, reset, and snapshots
bridge          in-process guest-to-guest address links and call switching
host_policy     process/thread seccomp compilation and installation
debug           RSP protocol and stopped-task inspection
```

Only `minisandbox-pvm-sys` and the narrow foreign-function portion of
`minisandbox-capi` may contain `unsafe`. The macro crate and all other
production modules use `#![forbid(unsafe_code)]`.

## 4. Runtime Objects and Lifecycle

The public model uses four opaque concepts:

- `runtime`: process-wide capability discovery, host services, and resource
  limits;
- `program`: a validated, immutable executable description;
- `instance`: a mutable running guest address space and its tasks;
- `checkpoint`: an immutable COW baseline created from a quiescent instance.

The lifecycle is:

```text
runtime -> program -> instance -> checkpoint -> cloned instance(s)
                         |                         |
                         +---- run/pause/stop -----+
```

An instance has explicit `ready`, `running`, `paused`, `stopped`, and `failed`
states. State-changing methods reject invalid transitions; they never silently
coerce state. Releasing a valid C handle exactly once destroys that registry
reference. Releasing it again returns `INVALID_HANDLE` without dereferencing
freed memory or affecting another object.

Creating a checkpoint performs a stop-the-world rendezvous:

1. prevent new guest tasks and external operations from entering;
2. preempt every running vCPU and retain its complete PVCS/register state;
3. drain or reject non-repeatable in-flight host operations;
4. verify that each guest task is at a restorable boundary;
5. seal the address-space root and page ownership graph;
6. publish the checkpoint atomically.

Failure leaves the original instance paused and unchanged. A checkpoint is
never partially visible. Clones receive new mutable address-space roots,
task/signal state, file-description tables, and scheduler state while sharing
only immutable or COW-protected backing pages.

## 5. PVM Execution Boundary

`minisandbox-pvm-sys` wraps capability probing, vCPU creation, memory mapping,
PVM run entry, PVCS access, event injection/return, and teardown. Raw file
descriptors, numeric ioctl requests, mapped pointers, and kernel-owned layouts
cannot escape this crate.

The safe engine observes typed outcomes:

```text
Syscall | PageFault | GuestEvent | HostInterrupt | Halt | FatalPvmError
```

Every PVM entry owns a guard that restores the host signal mask and run-state
bookkeeping on all return paths. Kernel ABI versions and structure sizes are
checked at runtime before the first instance is created. Unsupported capability
sets fail deterministically rather than falling back to another backend.

PVM vCPU resources are process-local. A checkpoint stores portable guest and
memory state, not inherited kernel vCPU handles. A clone always creates new PVM
vCPU objects in its owning process. Cross-process clone uses a sealed checkpoint
seed or snapshot file descriptor and imports it into a newly created runtime;
it never invokes an ioctl through an inherited vCPU, VM, or runtime descriptor.

## 6. Memory and Copy-on-Write

Guest addresses are integers wrapped in checked newtypes. Safe code never
constructs a host pointer from a guest address. Reads, writes, and typed access
go through bounds-checked `GuestMemory` operations.

Each mapped page has explicit ownership and permissions. The memory layer
maintains:

- an immutable mapping description;
- a per-instance page-table root;
- reference-counted immutable backing pages;
- private dirty pages created on write faults;
- dirty-generation metadata for reset and snapshot accounting.

Checkpoint creation write-protects shared writable mappings. A write fault
allocates and copies exactly one private page, updates only the faulting
instance's page-table path, and resumes with the original access permissions.
Page-table nodes follow the same ownership rule as data pages; clones must not
mutate a shared page-table root.

Reset discards the instance's private generations and rebuilds mutable roots
from its checkpoint. Memory limits are charged before allocation, including COW
faults, so failure cannot leave an unaccounted page installed.

## 7. Tasks, Signals, and True Preemption

A guest task is a complete user context plus Linux task state. It is not a host
thread and is not bound permanently to one vCPU. The scheduler owns runnable,
blocked, stopped, and exited queues; PVM vCPU workers borrow runnable tasks.

Preemption is mandatory. Each worker arms a host-side quantum source before
entering PVM. Quantum expiry interrupts the blocking PVM run operation. The
engine classifies that return as `HostInterrupt`, captures the complete task
context through the supported PVM/PVCS interface, requeues the task, and selects
another runnable task. It must not rely on the guest issuing a syscall, futex,
hypercall, or yield. This design requires the host PVM run operation to be
signal-interruptible, requires complete user context to be readable and
restorable after that interruption, and uses a monotonic host clock. Capability
probing rejects a host on which these assumptions cannot be demonstrated.

The defining test has two runnable tasks on one PVM vCPU: task A performs an
infinite pure-compute loop with no yield; task B records progress. With a 10 ms
configured quantum, B must record progress no later than the second successfully
observed `HostInterrupt` after A starts. A 2 second monotonic watchdog detects a
host that stops producing interrupts but is not the scheduling pass criterion.
The test runs 100 consecutive iterations and permits no starvation failures.
This test is a required pass, not an expected failure.

Signal delivery is serialized with task-state changes. Pending process and task
signals are selected at scheduler boundaries, converted into an x86_64 user
signal frame, and delivered using the PVM event mechanism. Signal return
validates the restored frame before applying it. A checkpoint cannot publish
while signal delivery or return is half committed.

For SMP, the scheduler uses one run queue per vCPU plus bounded work stealing.
An address-space generation and shootdown epoch coordinate mapping changes.
Freeze and snapshot rendezvous wait for acknowledgement from every active vCPU.

## 8. Linux Behavior and Host Resources

Syscall dispatch is generated from one declarative table containing the syscall
number, argument decoder, handler, restart behavior, and checkpoint safety.
Handlers operate on safe domain types and return Linux results; they do not
write raw registers directly.

File descriptors point to reference-counted file descriptions with explicit
offset, flags, close, clone, and snapshot policies. Blocking operations register
with a host reactor and move the guest task to a wait queue instead of blocking
the vCPU worker.

Host resources are classified as:

- cloneable: independently recreated in a new instance;
- shareable: intentionally shared with synchronized state;
- restorable: represented in a snapshot and reconstructed;
- non-checkpointable: causes checkpoint creation to fail with a named reason.

This classification is part of the handler contract and is covered by tests.
The baseline matrix is:

| Resource | Local checkpoint/clone | Portable snapshot/restore |
|---|---|---|
| Regular file or directory | duplicate the descriptor and preserve the declared shared-offset policy | require a caller-provided binding key; never serialize the descriptor |
| Caller-injected stdio or descriptor | allowed only with an explicit share or duplicate policy | require rebinding by key |
| Pipe, socket, eventfd | rejected by default; explicit process-local sharing is allowed | require rebinding, otherwise restore fails |
| epoll set | reconstruct from virtual interest records when every target is valid | reconstruct only after all targets are rebound |
| Guest timer, signal, futex wait | preserve logical state; recreate host wait registration | serialize logical state, never host reactor tokens |
| Address-space link | active call rejected; dormant binding is inherited by a local clone | record a binding key and require target rebinding |
| RSP listener/client | listener stays attached only to the original; an active client blocks checkpoint | never serialized; restore starts detached |
| PVM VM/vCPU, host timer, reactor token | always recreate | never serialized |

Checkpoint creation validates the complete descriptor graph before sealing any
memory. If one resource lacks a valid policy, the whole operation fails and
reports that descriptor and policy reason; it never produces a partial
checkpoint. Reset closes instance-private resources created after the
checkpoint, recreates restorable resources, and re-establishes declared shared
bindings.

## 9. Snapshots, Address Links, Host Policy, and Debugging

### Snapshot artifact

A portable snapshot is a versioned byte stream written to a caller-owned,
seekable file descriptor. The writer never chooses or opens a host path. The
stream contains an architecture and format header, required PVM capability set,
program identity digest, checkpoint metadata, page extents, guest task and Linux
state, resource binding keys, optional accessed-page/prefetch hints, and a
checksum for every section. It contains no host pointer, process-local handle,
raw host descriptor, mutex, PVM VM/vCPU descriptor, or reactor token.

The writer commits a footer only after all sections and checksums are complete.
Readers reject a missing footer, unknown required section, size overflow,
checksum mismatch, incompatible ABI/capability set, or non-matching program.
Restore receives a `program` handle and a complete binding table, constructs a
new process-local instance, and publishes its handle only after all mappings and
resources are valid. A prefetch byte limit controls how much of the optional hot
page order is populated eagerly; remaining pages are demand-faulted without
changing guest-visible behavior.

A sealed checkpoint seed uses the same logical schema in a memfd optimized for
`MAP_PRIVATE` import. It may be transferred through `fork` inheritance or
`SCM_RIGHTS`. Import always occurs through a new runtime and creates fresh PVM
VM/vCPU resources.

### Address-space links

An address link is a process-local object joining a client instance to a target
instance in the same runtime. It is not a network protocol. The link stores a
symbol/address binding, access policy, target identity, connection counter, and
`idle`, `active`, `closing`, or `closed` state.

During a linked call, target code and target-owned data execute under the
target's guest context while explicitly passed client buffers remain accessible
according to the link policy. Target addresses returned to the client cannot be
dereferenced after disconnect. A transient call disconnects on return or fault;
a permanent link keeps the dormant binding and permits reverse/nested resume
operations. Calls into one mutable target are serialized. Fault, signal,
timeout, disconnect, and reset paths all restore the original client context and
leave the link either `idle` or `closed`, never half active.

A checkpoint requires every link to be idle. Local clones inherit dormant link
configuration and reconnect to the same process-local target. Portable snapshots
store only caller-defined link binding keys; restore fails unless every required
target is rebound explicitly.

### Host seccomp policy

Seccomp protects the host runtime process; it is not a guest syscall policy and
is not attached to an instance or snapshot. The C API exposes irreversible
`bootstrap` and `runtime` phases, optional all-thread synchronization, log-only
soak mode, and validated additional rules with argument masks. Filters stack and
can only tighten. Installation validates all rules before changing thread state.

Callers must create or open resources required only during bootstrap before
installing the runtime phase. Runtime callbacks execute on filtered threads, so
their required syscalls must be declared before enforcement. A forbidden host
syscall produces the configured kernel seccomp action; it is not translated into
a guest errno.

### RSP debugging

An RSP endpoint is a process-local control object attached to one instance and a
caller-supplied listening socket. It permits one active client and supports
thread selection, stop status, register and memory read/write, breakpoints,
continue, single-step, interrupt, and kill. Every operation uses the same audited
task-stop protocol as preemption and checkpointing.

The listener and client are never checkpointed or serialized. An active client
blocks checkpoint creation. A detached listener may remain attached to the
original instance but clones and restored instances start with no RSP endpoint.
Destroying an instance first stops and detaches its endpoint.

## 10. Stable C ABI

The C API uses opaque 64-bit registry handles and symbols prefixed with
`minisandbox_`. It does not expose Rust layout, kernel structs, raw mapped
pointers, C++ objects, or guest-internal structs. A handle encodes object kind,
slot, and generation and is checked against a per-process registry cookie before
lookup.

Rules:

- `minisandbox_abi_version()` exposes major/minor compatibility.
- Every extensible input structure starts with `struct_size` and `abi_version`.
- Functions return a stable status enum; extended errors are copied into a
  caller-owned buffer or retrieved from an explicit error object.
- Create/retain/release ownership is documented for every handle.
- Callbacks carry an opaque caller context and declare whether re-entry is
  permitted.
- All FFI entry points catch Rust panics and convert them to a fatal status.
- No borrowed Rust reference survives a call.
- Header output is generated and checked for drift in CI.

All handles are process-local. They become invalid after `fork`, are never sent
over IPC, and cannot be reconstructed from their integer representation. The
only cross-process artifacts are sealed checkpoint-seed descriptors, portable
snapshot descriptors, and caller-owned program bytes. The child or receiver
creates a new runtime and imports those artifacts.

`runtime`, `program`, and `checkpoint` operations are thread-safe. Instance
control operations are thread-safe but serialized; exactly one call may execute
guest code for an instance at a time. Concurrent observation is allowed only
through methods documented as snapshots. Callbacks may call error/query APIs but
must not re-enter a state-changing operation on the originating instance; such
re-entry returns `BUSY` rather than deadlocking.

The first ABI version covers capability probing, runtime creation, program
loading, instance run/control, checkpoint/spawn/reset, guest-memory copies,
signal/control injection, snapshots, address links, and debug endpoints.
Fine-grained inspection APIs are added only when a conformance consumer requires
them.

## 11. Error Handling and Recovery

Core errors are typed by subsystem and retain an optional OS error number and
operation context. They are translated once at the C boundary. Guest-caused
faults, guest Linux errors, policy denials, resource exhaustion, unsupported PVM
capabilities, and internal invariant violations are distinct classes.

An error affecting one guest task does not poison an instance unless the
address space or PVM vCPU state is no longer trustworthy. Invariant violations
transition the instance to `failed`, stop all vCPUs, and preserve diagnostic
state. Teardown remains available from every state.

## 12. Macro-First Implementation

Minimizing hand-written source lines is an explicit project goal. Repeated
runtime syntax is represented once as a declarative contract and expanded by
`macro_rules!`, derive macros, or focused procedural macros. The macro crate
generates:

- syscall/hypercall definitions, decoders, dispatch, restart metadata, seccomp
  requirements, and conformance cases from one table;
- x86_64 register, PVCS, signal-frame, and RSP register mappings;
- state enums, legal transition tables, status conversion, and transition tests;
- typed C handle entry points, structure-size/version checks, ownership docs,
  panic barriers, and header metadata;
- resource checkpoint-policy matrices plus local-clone, reset, serialize, and
  rebind dispatch;
- snapshot section identifiers, encoders/decoders, bounds checks, checksums, and
  round-trip/corruption tests;
- address-link call variants and cleanup-path tests;
- errno/error/status declarations and conversions;
- repetitive PVM integration and differential-test matrices.

The source-of-truth input to each macro must be a short, reviewable table or
annotated Rust type. Adding a syscall, register, resource class, snapshot
section, C entry point, or conformance case should normally require changing one
declaration rather than several match statements and tests.

Macros may generate lifecycle and dispatch boilerplate, but raw-pointer
lifetime assumptions, lock acquisition order, PVM run ownership, and the core
scheduler selection algorithm remain explicit Rust. Unsafe expansion is allowed
only for locally defined macros inside the two permitted boundary modules; the
macro input must include a safety invariant. General procedural macros may not
emit `unsafe`.

CI stores normalized `cargo expand` output for the contract macros, checks it
for drift, compiles generated negative cases with `trybuild`, and includes all
expanded paths in test coverage. Hand-written Rust line count is reported per
crate so repetition regressions are visible; expanded line count is not treated
as project complexity.

## 13. Verification Strategy

Testing proceeds from behavior contracts, not implementation similarity.

### Per-module tests

- pure Rust state machines, decoders, page ownership, and error translation;
- property tests for address ranges, page-table updates, COW isolation, and ABI
  structure-size handling;
- concurrency model tests for scheduler, freeze, signal, and shootdown races;
- Miri for safe crates and targeted loom models for synchronization protocols.

### PVM integration tests

- boot and terminate a minimal x86_64 guest;
- syscall, page-fault, mmap, ELF/TLS, file, clock, futex, and signal matrices;
- checkpoint, many COW clones, reset, memory-pressure, and cross-process clone;
- mandatory 10 ms-quantum preemption test: B progresses by the second observed
  quantum interrupt, for 100 consecutive iterations;
- SMP progress, fault/shootdown, signal, and freeze races;
- address-link lifecycle, snapshot restore, seccomp denial, and RSP inspection.

### Differential black-box tests

The same guest fixtures run against the behavioral oracle and `minisandbox`.
Tests compare exit state, output, externally visible memory changes, signals,
errno, file effects, and bounded timing properties. Internal data structures,
addresses not declared stable, and diagnostic wording are not compared.

### Release gates

1. all safe crates contain no `unsafe` blocks;
2. every unsafe block in boundary crates has a local safety invariant and test;
3. generated C header compiles as C11 and C17 with GCC and Clang;
4. conformance passes on the designated x86_64 PVM host;
5. sanitizer-enabled C consumer tests pass;
6. Deno-style warm checkpoint/clone and server-style address-link/SMP workloads
   pass;
7. task A pure-compute/task B progress preemption passes repeatedly under load.

## 14. Delivery Slices

The complete runtime is delivered as independently testable vertical slices:

1. PVM capability probe, vCPU run/exit, guest memory, minimal ELF, and C ABI.
2. Linux memory/syscall/FD behavior and general ELF startup.
3. Quiescence, checkpoint, page-table/data COW, clone, and reset.
4. Tasks, futexes, signals, timers, true preemption, and SMP.
5. Portable snapshot format and host-resource rebinding.
6. Address-space link lifecycle and local-clone inheritance.
7. Host seccomp policy and RSP control endpoint.
8. Deno-style and server-style full integration, stress, and compatibility
   closure.

Each slice must have a runnable PVM acceptance test. Later success cannot waive
an earlier failed gate.

## 15. Primary Risks

- PVM kernel ABI drift: isolate it in one crate and fail fast on capability or
  layout mismatch.
- Incorrect asynchronous context capture: make preemption, signal, and freeze
  share one audited task-stop protocol.
- COW corruption under SMP: use explicit page/root ownership plus generation
  and shootdown acknowledgements.
- Host resource ambiguity at checkpoint: require every resource type to declare
  its checkpoint policy.
- An apparently stable C ABI leaking Rust or kernel layout: keep all handles
  opaque and version every extensible structure.
- Macro expansion obscuring a safety invariant: keep raw-pointer, lock-order,
  PVM-run ownership, and scheduler-selection logic explicit and review expanded
  contract code in CI.

## 16. Completion Definition

`minisandbox` is complete when the entire x86_64 PVM conformance suite and the
integration release gates pass using only Rust production code and the generated
C ABI, with no C++ source or compatibility layer in the repository. Passing a
small guest, boot test, or cooperative-only thread test is not full
compatibility.
