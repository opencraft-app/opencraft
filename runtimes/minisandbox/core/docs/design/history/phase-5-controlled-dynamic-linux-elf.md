# Phase 5 Controlled Dynamic Linux ELF

Status: matching-host glibc dynamic slice complete; broader dependency and OS compatibility remains

| ID | Requirement | RED evidence | Passing gate |
|---|---|---|---|
| P5-01 | Preserve a validated PT_INTERP request | parser returned UnsupportedInterpreter | one absolute, NUL-terminated, bounded path is retained without host I/O |
| P5-02 | Enter a real userspace dynamic loader | dynamic PIE could not be parsed | main is at 0x400000, ld-linux at 0x800000, AT_BASE/AT_ENTRY are correct |
| P5-03 | Resolve runtime files without exposing the host filesystem | ld-linux exited 127 before finding libc | exact allowlist exposes only ld-linux and libc; preload/cache/other paths return ENOENT |
| P5-04 | Provide loader file-descriptor syscalls | open/read/stat/pread/writev returned ENOSYS | bounded openat/read/pread/fstat/newfstatat/close/access/writev pass live |
| P5-05 | Map shared-object segments with enforced permissions | ld-linux reported failed to map segment | private file/anonymous mmap, bounded MAP_FIXED, RX/RW/NX, mprotect and partial munmap pass |
| P5-06 | Enforce current user PTEs on host-mediated memory | a protected page remained in the host write plan | Present+User+Writable translation returns EFAULT after mprotect |
| P5-07 | Preserve process and stable-C inputs | only static conformance used argv/env/stdin through C | static and dynamic glibc programs both exit 38 with exact C ABI output |

## Runtime model

- Parsing records a single syntactically valid PT_INTERP path but performs no
  filesystem access. Engine policy currently accepts exactly
  `/lib64/ld-linux-x86-64.so.2`.
- At run time the engine reads at most 4 MiB each from the controlled host
  interpreter and `/lib64/libc.so.6`, copies them into an in-memory read-only
  virtual file table, and exposes no other host path.
- The main PIE uses load bias `0x400000`; the interpreter uses `0x800000`.
  Linux auxv reports the main headers and entry plus the interpreter base, then
  execution begins at the interpreter entry inside PVM.
- The loader can map allowlisted file pages only inside the 15 MiB mmap arena.
  Shared mappings, W+X, unbounded descriptors, unapproved files, and mappings
  outside the arena remain rejected.
- Host reads walk the trusted user CR3. Host writes additionally require the
  current user PTE to be Present, User, and Writable before copying any byte.

## Compatibility boundary after this slice

Verified live: the ordinary GCC dynamic PIE fixture linked against the host's
matching glibc, normal ld-linux relocation, libc startup, argv/env/stdin,
stdout, static ET_EXEC, static PIE, Rust API, and stable C ABI 1.3.

Not yet general: alternative interpreters, extra DT_NEEDED libraries, a
caller-supplied rootfs/runtime bundle, dynamic-runtime version pinning,
PROT_NONE/hinted mmap, threads/futex/signals, a general filesystem, networking,
and runtime-configured memory enforcement. This phase supports simple matching-
host glibc programs; it does not claim arbitrary distro binaries are portable.
