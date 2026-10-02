# Phase 6 Controlled C++ Dependencies

Status: ordinary matching-host dynamic C++ slice complete

| ID | Requirement | RED evidence | Passing gate |
|---|---|---|---|
| P6-01 | Test a non-C compiler-produced ELF | prior matrix used GCC C and QuickJS C | ordinary g++17 PIE uses vector, string, new/delete, and write |
| P6-02 | Resolve multiple DT_NEEDED libraries without directory exposure | ld-linux exited 127 for missing libstdc++.so.6 | exact manifest supplies libstdc++, libm, libgcc_s, libc, and ld-linux |
| P6-03 | Preserve distinct virtual file identity | every stat returned inode 1, so ld-linux deduplicated all DSOs | stable per-manifest inode values cause every required DSO to map |
| P6-04 | Keep all dependency bytes and mappings bounded | broad /lib64 access would escape policy | each file is capped at 4 MiB and mappings stay in the 15 MiB arena |
| P6-05 | Preserve all prior workloads | extra runtime files could affect C loader search and memory | static C, dynamic C, C++, QuickJS, COW, Rust, and C ABI gates pass |

## Controlled dependency manifest

- `/lib64/ld-linux-x86-64.so.2`
- `/lib64/libc.so.6`
- `/lib64/libstdc++.so.6`
- `/lib64/libm.so.6`
- `/lib64/libgcc_s.so.1`

The manifest is a list of exact guest/host path pairs. It does not grant guest
directory traversal, cache access, preload processing, symlink lookup, or an
open-ended host-library search. Each file is copied through the existing 4 MiB
bound and receives a unique immutable `(st_dev, st_ino)` identity.

## Compatibility boundary after this slice

Verified live: an ordinary g++ 12 C++17 PIE linked against the matching host
libstdc++/libgcc/glibc stack, including dynamic allocation, vector iteration,
string storage, output, destructors, and normal process exit.

Still not general: arbitrary third-party DT_NEEDED libraries, a caller-provided
runtime bundle/rootfs, libc or libstdc++ portability across hosts, exceptions
that require untested syscalls, threads/futex/signals, and a general filesystem.
