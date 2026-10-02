# Phase 7 ELF Toolchain Compatibility

Status: GCC, Clang, C++, and Rust simple-process slice complete

| ID | Requirement | RED evidence | Passing gate |
|---|---|---|---|
| P7-01 | Prove compatibility is not specific to GCC output | Clang static link failed under the shared `-Werror` flags because `-no-pie` is unused | Clang 17 static ET_EXEC, static PIE, dynamic C PIE, and dynamic C++ PIE all run live |
| P7-02 | Run a normal Rust `std` binary | rustc PIE reached `GuestFault` before `main` | rustc 1.96 allocation, argv, signal setup, output, destructors, and exit run live |
| P7-03 | Support runtime descriptor probing | zero-timeout `poll` returned `ENOSYS`, causing Rust stdio initialization to abort | bounded pollfd arrays report stdin/stdout/stderr and controlled-file readiness |
| P7-04 | Preserve guest signal ABI state without host signal exposure | Rust could not install its SIGPIPE or stack-overflow dispositions | bounded `rt_sigaction` and `sigaltstack` state remains private to the guest process |
| P7-05 | Enforce guarded stack mappings | `MAP_STACK` was rejected and `mprotect(PROT_NONE)` returned `ENOSYS` | `MAP_STACK` is accepted as a hint and guard pages become genuinely non-present |
| P7-06 | Preserve all earlier workloads and ABI gates | broader syscall/memory handling could regress COW or loader permissions | full workspace, C ABI, header, unsafe, LOC, and macro gates pass |

## Verified compiler matrix

- GCC 12: C11 static ET_EXEC, static PIE, and matching-host dynamic PIE.
- Clang 17: C11 static ET_EXEC, static PIE, and matching-host dynamic PIE.
- G++ 12 and Clang++ 17: C++17 matching-host dynamic PIE using the standard
  library, allocation, containers, and normal teardown.
- rustc 1.96: matching-host dynamic PIE using `std`, allocation, arguments,
  formatted output, guest signal dispositions, and an alternate guarded stack.

The programs are compiled independently by their stock compilers. None uses a
minisandbox SDK, custom crt, hand-written ELF headers, or guest-specific
assembly.

## Runtime boundary after this slice

The current target is arbitrary **simple** x86_64 Linux ELF, not one specific
JavaScript runtime. Verified programs may be static ET_EXEC, static PIE, or a
matching-host glibc dynamic PIE whose interpreter and `DT_NEEDED` libraries are
in the controlled runtime manifest.

This is not yet an arbitrary distro-binary claim. The sandbox still lacks a
caller-supplied runtime bundle/rootfs, general paths and files, nonzero-timeout
blocking poll, delivered guest signals, futex/clone threads, networking, and
runtime-configured memory limits. musl was not tested because `musl-gcc`,
`x86_64-linux-musl-gcc`, and Zig are absent on the designated host.
