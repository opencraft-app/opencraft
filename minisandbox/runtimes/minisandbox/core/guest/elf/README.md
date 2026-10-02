# Generic ELF conformance guests

These sources are compiled by `conformance/build.rs` with the host's ordinary
GCC, Clang, C++, and Rust toolchains. They intentionally use the normal Linux
process entry point and libc/runtime startup rather than hand-written ELF
headers or minisandbox-specific assembly.

`static_process.c` covers C/glibc process behavior in static, static-PIE, and
dynamic forms. `simple_cpp.cpp` adds an ordinary dynamic C++ program with
standard-library allocation and container use. `simple_rust.rs` adds a normal
`std` Rust PIE with allocation, argument inspection, formatted output, signal
setup, and a guarded alternate signal stack.
