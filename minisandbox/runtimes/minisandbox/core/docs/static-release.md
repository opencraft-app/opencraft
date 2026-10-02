# Static musl release

The maintained executable release is entirely static, including both sides of
the PVM boundary:

- `minisandbox-init`: guest PID 1 and control agent;
- `minisandbox`: unified command entry point;
- `pvm-console`: host PVM, block, network, timer, and console runtime.

Install the Rust musl standard library once, then build all three:

```text
rustup target add x86_64-unknown-linux-musl
cargo xtask static-release
```

Artifacts are written below:

```text
target/x86_64-unknown-linux-musl/release/
```

The xtask does not trust the target name or linker output. It parses each ELF64
program table and dynamic table itself and fails the release if it finds either
`PT_INTERP` or `DT_NEEDED`. Static PIE relocation metadata is permitted; a
`PT_DYNAMIC` segment alone does not imply a shared-library dependency.

`rootfs/build.py debian` uses the same musl target by default and rejects a
custom `--init-binary` unless it is little-endian x86-64 ELF with neither a
dynamic interpreter nor a needed shared library.

The C ABI shared object is intentionally not included in this executable set:
its purpose is to be loaded into another host process. Rust and runtime
dependencies are still linked into that library, while final executable link
policy belongs to its consumer.
