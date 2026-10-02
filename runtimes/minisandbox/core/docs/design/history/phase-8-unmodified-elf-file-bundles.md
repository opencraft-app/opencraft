# Phase 8 Unmodified ELF and Exact File Bundles

Status: unmodified matching-host simple ELF slice complete

| ID | Requirement | RED evidence | Passing gate |
|---|---|---|---|
| P8-01 | Prove execution does not depend on repository-built fixtures | compiler-produced fixtures could share accidental assumptions | unmodified `/usr/bin/true`, `/usr/bin/printf`, and `/usr/bin/sha256sum` run live |
| P8-02 | Preserve standard descriptor lifecycle | `printf` emitted correct bytes, then `close(1)` returned EBADF and forced exit 1 | fd 0/1/2 close state is tracked; closed read/write/poll agree |
| P8-03 | Remove the fixed-library-list bottleneck | `sha256sum` exited 127 because `libcrypto.so.3` was absent | caller supplies exact libcrypto/libz paths and bytes through a bounded read-only bundle |
| P8-04 | Avoid exposing a host root or search path | resolving arbitrary DT_NEEDED from host directories would broaden authority | bundle paths are exact, absolute, normalized, unique, and resolved only in memory |
| P8-05 | Make the capability usable from the stable ABI | Rust-only files would not serve C consumers | C ABI 1.4 adds `MinisandboxGuestFile` and `minisandbox_instance_run_process_with_files` |
| P8-06 | Preserve ABI and runtime regressions | a new pointer-of-struct boundary can add unchecked nested ranges | nested pointer negatives, layout, generated header, GCC/Clang, and full PVM gates pass |

## File-bundle contract

- At most 64 caller files.
- At most 8 MiB per file and 64 MiB total caller file bytes.
- Paths must be absolute, nonempty, NUL-free, and contain no empty, `.` or `..`
  component.
- Duplicate caller paths and collisions with built-in runtime paths are rejected.
- Contents are copied into immutable `Arc<[u8]>` storage before guest execution.
- Guest access remains through the existing bounded read/pread/stat/private-mmap
  service. There is no host path fallback, directory traversal, write-through,
  cache, or preload access.

The old Rust and C process-run APIs remain available and behave as an empty
caller bundle. C ABI major remains 1; minor is 4.

## Compatibility boundary after this slice

Verified live without recompilation: system `true`, `printf`, and `sha256sum`.
The last program streams stdin and maps caller-supplied libcrypto/libz DSOs,
showing that simple dynamic ELF is no longer restricted to a hardcoded
`DT_NEEDED` list.

This is still a deliberately read-only virtual filesystem. Programs requiring
directory enumeration, mutable files, locale trees, `/proc`, networking,
blocking I/O, processes, or threads remain outside the verified simple-ELF
boundary. The caller is responsible for supplying a dependency set compatible
with the selected interpreter/libc.
