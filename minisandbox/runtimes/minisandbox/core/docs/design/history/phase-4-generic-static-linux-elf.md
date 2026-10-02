# Phase 4 Generic Static Linux ELF

Status: static compatibility slice and full gate complete; dynamic loader work remains

| ID | Requirement | RED evidence | Passing gate |
|---|---|---|---|
| P4-01 | Run an ordinary compiler-produced static C ELF | GCC ELF failed with `Image(ProgramLayout)` | real static glibc `main` exits 37 with exact output |
| P4-02 | Supply the Linux process entry contract | cold path had one synthetic stack page and no auxv | argc/argv/envp/AT_PHDR/AT_RANDOM/AT_EXECFN and 1 MiB stack pass |
| P4-03 | Accept caller argv, environment, and stdin | no generic process-input API existed | real guest validates 3 argv, 1 env entry, and `read(0)` bytes |
| P4-04 | Support static PIE without opening dynamic loading implicitly | `ET_DYN` was rejected as invalid ELF | static PIE self-relocates at fixed `0x400000` load bias |
| P4-05 | Classify dynamic binaries honestly | `PT_INTERP` was silently ignored | real dynamic PIE returns `UnsupportedInterpreter` during parsing |
| P4-06 | Provide bounded anonymous memory | guest `mmap` returned `ENOSYS` and exited 96 | 15 MiB arena enforces Present/W/NX, mprotect, and munmap faults |
| P4-07 | Provide safe common process services | only QuickJS bootstrap libc calls were serviced | brk/read/write/getrandom/time/uname/getpid/readlink work under bounds |
| P4-08 | Preserve freestanding and Actor workloads | generic Linux startup would reject handcrafted fixtures | capability selection keeps raw ELF, cold COW, and QuickJS tests green |
| P4-09 | Expose process inputs through stable C | ABI had only default run and Actor turn input | ABI 1.3 byte slices and live process-input conformance pass |
| P4-10 | Bound all caller-controlled process inputs | argv/env/stdin could otherwise force unbounded host copies | 1,024-entry vectors, 512 KiB strings, 1 MiB stdin, and embedded-NUL rejection pass |
| P4-11 | Keep host-mediated reads inside the user address space | output capture treated a guest pointer as a physical address | trusted user-CR3 translation returns EFAULT for supervisor-only pages |

## Runtime model

- `Engine::run` selects the Linux process path when ELF program headers are
  present in a load segment; legacy freestanding syscall ELFs retain the small
  raw entry path.
- `Engine::run_process` explicitly accepts argv, environment, and stdin and
  always requires the complete Linux startup contract. Inputs are rejected
  before image construction when vector, byte, stdin, or NUL constraints fail.
- Static `ET_EXEC` uses linked addresses. Static `ET_DYN` receives a fixed safe
  `0x400000` bias and performs its own static-PIE relocations. Any `PT_INTERP`
  request is rejected before VM creation until a controlled loader exists.
- Linux processes receive a 64 MiB image: bounded brk arena, initially
  non-present anonymous mmap arena, and 1 MiB stack. Anonymous mappings can only
  be private, anonymous, non-executable, and exact-lifetime managed.
- `/proc/self/exe`, uname, stdin, stdout/stderr, random, and time are virtualized;
  no host file path, network socket, or arbitrary syscall is exposed.
- Host reads of guest buffers walk the trusted four-level user page tables;
  non-present, supervisor-only, and non-user mappings are never copied out.

## Compatibility boundary after this slice

Verified live: GCC static glibc `ET_EXEC`, GCC static PIE, normal libc startup,
malloc/brk, anonymous mmap/mprotect/munmap, argv/env/stdin, process identity/time,
freestanding ELF, warmed QuickJS Actor, Rust API, and C ABI 1.3.

Still required for the broader generic-ELF goal: controlled `PT_INTERP` and
dependency loading, a virtual file-descriptor/filesystem policy beyond fd 0/1/2,
thread/futex/signal semantics, additional syscall compatibility driven by real
programs, enforcement of runtime-configured memory size, and multi-toolchain/
application compatibility benchmarks. This slice is not evidence that arbitrary
dynamically linked or multithreaded Linux binaries already run.
