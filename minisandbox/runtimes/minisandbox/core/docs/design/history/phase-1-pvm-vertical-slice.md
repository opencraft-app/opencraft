# Phase 1: x86_64 PVM Vertical Slice

Status: complete (implementation commit `734a6da`)

Design source:
`docs/design/2026-08-14-minisandbox-x86_64-pvm-design.md`

## Outcome

A C11 program can load a minimal static x86_64 ELF through
`include/minisandbox.h`, create a PVM-backed instance, enter PVM user mode,
service `write` and `exit` syscalls, and return a typed run result. The same
guest is executable from the Rust API. No hardware-KVM or C++ path exists.

The designated host is currently:

- TencentOS Server 4.4, x86_64;
- kernel `6.7.12+`;
- `/dev/kvm` provided by `kvm_pvm`;
- installed module exposes the legacy 6.7 PVCS/MSR contract;
- GCC, Clang, and NASM are installed;
- Rust 1.96.0 is installed and is the recorded Phase 1 verification toolchain.

These facts are environment inputs, not hard-coded product detection. Runtime
PVM detection uses KVM/PVM capabilities and MSR probing.

## Test-First Gate

Every slice follows this exact order:

1. add the smallest contract or behavior test;
2. run only that test and store its expected failure in
   `.omx/evidence/phase-1/<slice>-red.txt`;
3. reject the test if it passes before implementation or fails for an unrelated
   reason;
4. implement the minimum code needed for the test;
5. store the passing command/output in
   `.omx/evidence/phase-1/<slice>-green.txt`;
6. refactor repetition into declarative macros while the test stays green;
7. run the slice verification set and commit only a green tree.

Cargo manifests and empty crate roots may be created only to make the first test
compile far enough to express its missing contract. No production type,
constant, branch, or behavior is added for a slice before its red test has been
observed and recorded.

## Workspace Shape

Likely files by the end of the phase:

```text
Cargo.toml
Cargo.lock
rust-toolchain.toml
cbindgen.toml
include/minisandbox.h
crates/minisandbox-macros/
  Cargo.toml
  src/lib.rs
crates/minisandbox-pvm-sys/
  Cargo.toml
  src/{lib,abi,device,memory,run}.rs
crates/minisandbox-core/
  Cargo.toml
  build.rs
  src/{lib,error,program,instance,engine}.rs
  src/arch/x86_64/{mod,layout,paging,trampoline}.rs
crates/minisandbox-capi/
  Cargo.toml
  src/{lib,abi,registry}.rs
conformance/
  Cargo.toml
  fixtures/minimal_exit.S
  tests/{pvm_probe,pvm_user_exit,c_api}.rs
  c/phase1_smoke.c
xtask/
  Cargo.toml
  src/main.rs
```

The exact split may shrink when a file would contain only forwarding code. A
slice must not merge the unsafe PVM boundary into `minisandbox-core`.

## Slice 1A: Contract Tests and Workspace

### Red tests first

Create:

- `crates/minisandbox-pvm-sys/tests/pvcs_contract.rs` asserting the published
  modern PVCS size, alignment, offsets, MSR numbers, event bits, and hypercalls;
- assertions for the installed 6.7 legacy PVCS layout and deprecated MSRs;
- `crates/minisandbox-capi/tests/abi_contract.rs` asserting ABI version packing,
  stable status discriminants, structure prefixes, and 64-bit handle width;
- `crates/minisandbox-macros/tests/ui.rs` plus `tests/ui/*.rs` for accepted and
  rejected declaration tables.

The first red state is unresolved workspace/crate/API symbols, not a syntax
error in the tests.

### Minimum implementation

- Create the Cargo workspace and four implementation crates.
- Set workspace Rust edition and lints once at the root.
- Put `#![forbid(unsafe_code)]` in macros and core.
- Generate both PVCS structs, constants, offset tests, C status definitions, and
  negative compile cases from short macro declarations.
- Keep the modern and legacy PVM contracts separate and explicitly named; never
  infer layout from kernel version text.

### Verify

```text
cargo test -p minisandbox-macros
cargo test -p minisandbox-pvm-sys --test pvcs_contract
cargo test -p minisandbox-capi --test abi_contract
cargo fmt --all -- --check
```

### Done

- Contract tests pass on macOS without opening `/dev/kvm`.
- Expanded declarations contain no unexpected `unsafe`.
- Hand-written tables are the only source for duplicated constants/statuses.

## Slice 1B: PVM Capability Probe

### Red tests first

Create `conformance/tests/pvm_probe.rs` requiring:

- `/dev/kvm` API version is the supported KVM API;
- VM and vCPU creation succeed through the PVM provider;
- vCPU mmap size is valid;
- guest CPUID exposes FSGSBASE;
- MSR probing classifies the host as modern or legacy PVM;
- a non-PVM or incomplete host returns `UnsupportedPvm` and never falls back.

Unit tests use an ioctl trait with scripted replies for open, short MSR reads,
bad API version, missing FSGSBASE, and partial cleanup. The real test runs only
on the designated PVM host.

### Minimum implementation

- Use maintained Rust KVM bindings/ioctl wrappers for generic KVM operations.
- Add only the missing PVM MSR/PVCS declarations locally from the published
  PVM UAPI.
- Expose safe `PvmDevice`, `PvmVm`, and `PvmVcpu` ownership types.
- Keep raw descriptors, mapped `kvm_run`, and ioctl buffers inside
  `minisandbox-pvm-sys`.
- Report a diagnostic module identity, but do not use module name as the
  capability decision.

### Verify

```text
cargo test -p minisandbox-pvm-sys device
cargo test -p minisandbox-conformance --test pvm_probe -- --nocapture
```

### Done

- The remote host is classified as the legacy 6.7 PVM ABI.
- Every failed probe closes all created descriptors.
- Requested PVM mode has no hardware-KVM fallback branch.

## Slice 1C: Guest Memory, Page Tables, and User Transition

### Red tests first

Create safe local tests that require:

- checked guest-address arithmetic and bounded copies;
- independent supervisor and user four-level page-table roots;
- supervisor trampoline, page tables, and PVCS absent from the user root;
- user code/stack mapped with the intended W/X permissions;
- PVCS page aligned, exactly 128 ABI bytes initialized, and the rest zero;
- invalid, overlapping, non-canonical, and executable-writable layouts rejected.

Create a remote red test that starts at a supervisor ERETU stub, transitions to
one user instruction stream, and receives an expected PVM exit without using a
Linux ELF loader.

### Minimum implementation

- Implement guest addresses and layout in safe Rust.
- Generate page-table entry masks and mapping cases from one macro table.
- Use a boundary-owned mapping object for KVM memslot registration.
- Generate the minimal x86_64 supervisor and user byte sequences with a safe
  Rust build helper; do not require a host C++ compiler or copy an existing
  trampoline.
- Program CR0/CR3/CR4/EFER, CPUID, STAR/LSTAR, PVM PVCS/event/ERETU MSRs, and
  legacy-only CR3/RSP/RETS MSRs according to the probed ABI.

### Verify

```text
cargo test -p minisandbox-core memory
cargo test -p minisandbox-core paging
cargo test -p minisandbox-conformance --test pvm_user_transition -- --nocapture
```

### Done

- User-mode code executes through PVCS/ERETU on the designated host.
- User reads/writes to supervisor, PVCS, or page-table addresses fault.
- The safe core contains no raw host pointer.

## Slice 1D: Minimal ELF and Syscall Run Loop

### Red tests first

Create loader tests for truncated headers, wrong architecture/class/endian,
overlapping segments, non-canonical addresses, W+X policy, oversized memory,
entry outside executable memory, BSS zero fill, and read-only segments.

Create remote black-box tests for two static fixtures:

- `_start` invokes `exit(73)`;
- `_start` invokes `write(1, "minisandbox\n", 12)` and then `exit(73)`.

The run result must distinguish guest exit, timeout, guest fault, PVM failure,
and host callback failure.

### Minimum implementation

- Parse only ELF64 little-endian x86_64 `PT_LOAD` segments needed by the
  fixtures; reject rather than guess at unsupported types.
- Build the initial user stack with a documented minimal ABI.
- Classify PVM exits into typed safe outcomes.
- Implement only `write`, `exit`, and `exit_group` syscall behavior in this
  phase, generated from the first syscall contract table.
- Resume `write` through PVCS/ERETU; terminate on exit.
- Enforce a monotonic host timeout that interrupts the PVM run operation.

### Verify

```text
cargo test -p minisandbox-core loader
cargo test -p minisandbox-core syscall
cargo test -p minisandbox-conformance --test pvm_user_exit -- --nocapture
```

### Done

- Both fixtures pass repeatedly on the designated PVM host.
- Malformed ELF inputs never reach a KVM ioctl.
- Timeout cleanup leaves the vCPU and run mapping destructible.

## Slice 1E: Stable C ABI

### Red tests first

Create C and Rust ABI tests for:

- header compilation under GCC and Clang in C11 and C17 modes;
- short/long `struct_size`, wrong ABI version, null output, stale handle, wrong
  handle kind, double release, and callback re-entry;
- end-to-end runtime/program/instance/run/release of the minimal ELF;
- Rust panic conversion to `MINISANDBOX_STATUS_INTERNAL` without unwinding into
  C.

### Minimum implementation

The initial generated API contains:

```text
minisandbox_abi_version
minisandbox_runtime_create
minisandbox_program_load
minisandbox_instance_create
minisandbox_instance_run
minisandbox_instance_exit_code
minisandbox_last_error
minisandbox_release
```

- Generate entry-point validation and panic barriers from a C-ABI declaration
  table.
- Store objects in a process-cookie/kind/slot/generation registry.
- Accept output through a C callback with an opaque caller context.
- Generate `include/minisandbox.h` with `cbindgen` through `cargo xtask header`;
  CI fails on header drift.

### Verify

```text
cargo test -p minisandbox-capi
cargo xtask header --check
cargo xtask c-check
cargo xtask c-smoke
```

### Done

- The C smoke test prints exactly `minisandbox\n` and reports exit code 73.
- Invalid handles and ABI inputs are rejected without crashes or leaks.
- No Rust layout appears in the header.

## Slice 1F: Phase Gate

### Required checks

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask header --check
cargo xtask unsafe-audit
cargo xtask loc
cargo xtask macro-check
cargo xtask c-check
cargo xtask c-smoke
```

Run all Linux/PVM tests on the designated host and store exact kernel, module
hash, Cargo.lock hash, commands, and outputs under `.omx/evidence/phase-1/`.

### Done

- All verification-map rows are green.
- `unsafe` appears only in the mapped-memory/ioctl portion of
  `minisandbox-pvm-sys` and the C pointer conversion portion of
  `minisandbox-capi`, each with a local safety comment.
- There are no C++ files, C++ build steps, or compatibility shims.
- Macro expansion tests and hand-written line-count report pass.
- The Git tree is clean and the phase evidence names the tested commit.

## Dependencies and Stop Conditions

- Install the pinned Rust toolchain on the designated host before Slice 1B.
- Stop if the host PVM ABI cannot be classified by capability/MSR probing.
- Stop if PVM run interruption cannot preserve readable/restorable context;
  do not substitute cooperative yielding.
- Stop if a dependency requires exposing a raw pointer to safe core code.
- Do not begin general syscall, COW, thread, or SMP work until Phase 1 is green.
